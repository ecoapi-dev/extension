/**
 * Unit tests for ast/waste/concurrency-detector.ts.
 *
 * Constructs AstCallMatch mock objects directly — no Tree-sitter WASM needed.
 *
 * Scenarios:
 *  1. API call inside setInterval (polling) with no backoff → "rate_limit" emitted
 *  2. API call inside setInterval with backoff AND concurrency guard → suppressed
 *  3. Promise.all fan-out (parallel) with no concurrency limiter → "concurrency_control" emitted
 *  4. Promise.all fan-out with p-limit nearby → suppressed
 *  5. Retry pattern in source with no backoff → "rate_limit" retry storm emitted
 *  6. API call near high-frequency event listener → "rate_limit" event amplification emitted
 *  7. API call near scroll event but with debounce guard → suppressed
 */
import assert from "node:assert/strict";
import { detectConcurrencyWaste } from "../ast/waste/concurrency-detector";
import type { AstCallMatch } from "../ast/ast-scanner";
import { pointSpan } from "../scanner/source-span";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeMatch(overrides: Partial<AstCallMatch>): AstCallMatch {
  const line = overrides.line ?? 10;
  const column = overrides.column ?? 0;
  return {
    kind: "sdk",
    provider: "openai",
    packageName: "openai",
    methodChain: "client.chat.completions.create",
    confidence: 1,
    method: "POST",
    endpoint: "/v1/chat/completions",
    line,
    column,
    span: pointSpan(line, column),
    frequency: "single",
    loopContext: false,
    streaming: false,
    batchCapable: false,
    cacheCapable: false,
    isMiddleware: false,
    ...overrides,
  };
}

function run(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (err) {
    console.error(`FAIL ${name}`);
    throw err;
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

run("concurrency: polling without backoff → rate_limit finding emitted", () => {
  const match = makeMatch({
    frequency: "polling",
    loopContext: true,
    line: 4,
  });

  const source = [
    "import OpenAI from 'openai';",
    "const client = new OpenAI();",
    "setInterval(async () => {",
    "  await client.chat.completions.create({ model: 'gpt-4o', messages: [] });",
    "}, 5000);",
  ].join("\n");

  const findings = detectConcurrencyWaste([match], source, "/project/src/jobs/poller.ts");
  assert.ok(findings.length > 0, "expected a rate_limit finding");
  assert.ok(
    findings.some((f) => f.type === "rate_limit"),
    "finding type should be 'rate_limit'"
  );
  assert.ok(
    findings.some((f) => f.evidence.some((e) => /polling|timer/i.test(e))),
    "evidence should mention polling"
  );
});

run("concurrency: polling with backoff AND concurrency guard → fully suppressed", () => {
  const match = makeMatch({
    frequency: "polling",
    loopContext: true,
    line: 6,
  });

  // Source has both backoff and a mutex/semaphore guard
  const source = [
    "import OpenAI from 'openai';",
    "const client = new OpenAI();",
    "const mutex = new Mutex();",
    "setInterval(async () => {",
    "  await mutex.acquire();",
    "  try {",
    "    await client.chat.completions.create({ model: 'gpt-4o', messages: [] });",
    "  } finally {",
    "    mutex.release();",
    "  }",
    "}, 5000, { backoff: true, exponential: true });",
  ].join("\n");

  const findings = detectConcurrencyWaste([match], source, "/project/src/jobs/poller.ts");
  const pollingFindings = findings.filter((f) => f.type === "rate_limit");
  assert.equal(pollingFindings.length, 0, "fully guarded polling should be suppressed");
});

run("concurrency: Promise.all fan-out without limiter → concurrency_control emitted", () => {
  const match = makeMatch({
    frequency: "parallel",
    loopContext: true,
    line: 4,
  });

  const source = [
    "import OpenAI from 'openai';",
    "const client = new OpenAI();",
    "const results = await Promise.all(",
    "  items.map((item) => client.chat.completions.create({ model: 'gpt-4o', messages: [{ role: 'user', content: item }] }))",
    ");",
  ].join("\n");

  const findings = detectConcurrencyWaste([match], source, "/project/src/api/batch.ts");
  assert.ok(findings.length > 0, "expected a concurrency_control finding");
  assert.ok(
    findings.some((f) => f.type === "concurrency_control"),
    "finding type should be 'concurrency_control'"
  );
  assert.ok(
    findings.some((f) => /p-limit|concurrency|limiter/i.test(f.description + f.evidence.join(" "))),
    "finding should reference concurrency limiting"
  );
});

run("concurrency: Promise.all fan-out with p-limit → suppressed", () => {
  const match = makeMatch({
    frequency: "parallel",
    loopContext: true,
    line: 5,
  });

  const source = [
    "import pLimit from 'p-limit';",
    "import OpenAI from 'openai';",
    "const client = new OpenAI();",
    "const limit = pLimit(5);",
    "const results = await Promise.all(",
    "  items.map((item) => limit(() => client.chat.completions.create({ model: 'gpt-4o', messages: [] })))",
    ");",
  ].join("\n");

  const findings = detectConcurrencyWaste([match], source, "/project/src/api/batch.ts");
  const concFindings = findings.filter((f) => f.type === "concurrency_control");
  assert.equal(concFindings.length, 0, "p-limit guard should suppress concurrency_control finding");
});

run("concurrency: retry pattern with no backoff → retry storm rate_limit emitted", () => {
  const match = makeMatch({
    frequency: "single",
    loopContext: false,
    line: 6,
  });

  const source = [
    "import OpenAI from 'openai';",
    "const client = new OpenAI();",
    "let retries = 3;",
    "while (retries > 0) {",
    "  try {",
    "    await client.chat.completions.create({ model: 'gpt-4o', messages: [] });",
    "    break;",
    "  } catch (e) {",
    "    retries--;",
    "    // retry immediately",
    "  }",
    "}",
  ].join("\n");

  const findings = detectConcurrencyWaste([match], source, "/project/src/api/chat.ts");
  assert.ok(
    findings.some((f) => f.type === "rate_limit"),
    "retry without backoff should emit a rate_limit finding"
  );
  assert.ok(
    findings.some((f) => f.evidence.some((e) => /retry|backoff/i.test(e))),
    "evidence should mention retry or backoff"
  );
});

run("concurrency: API call near scroll event listener without debounce → rate_limit emitted", () => {
  const match = makeMatch({
    frequency: "single",
    loopContext: false,
    line: 4,
  });

  const source = [
    "import OpenAI from 'openai';",
    "const client = new OpenAI();",
    "window.addEventListener('scroll', async () => {",
    "  const result = await client.chat.completions.create({ model: 'gpt-4o', messages: [] });",
    "  updateUI(result);",
    "});",
  ].join("\n");

  const findings = detectConcurrencyWaste([match], source, "/project/src/ui/page.ts");
  assert.ok(
    findings.some((f) => f.type === "rate_limit"),
    "high-frequency event listener without debounce should emit rate_limit"
  );
  assert.ok(
    findings.some((f) => f.evidence.some((e) => /event|debounce|scroll/i.test(e))),
    "evidence should mention the event listener or debouncing"
  );
});

run("concurrency: scroll event with throttle guard → event finding suppressed", () => {
  const match = makeMatch({
    frequency: "single",
    loopContext: false,
    line: 5,
  });

  const source = [
    "import OpenAI from 'openai';",
    "import { throttle } from 'lodash';",
    "const client = new OpenAI();",
    "const handler = throttle(async () => {",
    "  const result = await client.chat.completions.create({ model: 'gpt-4o', messages: [] });",
    "  updateUI(result);",
    "}, 1000);",
    "window.addEventListener('scroll', handler);",
  ].join("\n");

  const findings = detectConcurrencyWaste([match], source, "/project/src/ui/page.ts");
  const eventFindings = findings.filter(
    (f) => f.type === "rate_limit" && /event|scroll/i.test(f.description + f.evidence.join(" "))
  );
  assert.equal(eventFindings.length, 0, "throttle guard should suppress event amplification finding");
});
