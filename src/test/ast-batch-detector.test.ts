/**
 * Unit tests for ast/waste/batch-detector.ts.
 *
 * Constructs AstCallMatch mock objects directly — no Tree-sitter WASM needed.
 *
 * Scenarios:
 *  1. batchCapable call inside forEach → "batch" finding emitted
 *  2. batchCapable call inside loop with batch guard → suppressed
 *  3. Non-batchCapable call inside loop → "n_plus_one" finding emitted
 *  4. Two independent single calls to same provider → "batch" (Promise.all) emitted
 *  5. Two single calls with concurrency guard nearby → sequential finding suppressed
 *  6. batchCapable call in a loop but already in a parallel (Promise.all) context → "batch" emitted
 */
import assert from "node:assert/strict";
import { detectBatchWaste } from "../ast/waste/batch-detector";
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
    enclosingFunction: null,
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

run("batch: batchCapable call inside forEach → batch finding emitted", () => {
  const match = makeMatch({
    methodChain: "client.embeddings.create",
    batchCapable: true,
    frequency: "bounded-loop",
    loopContext: true,
    line: 5,
  });

  const source = [
    "import OpenAI from 'openai';",
    "const client = new OpenAI();",
    "const texts = ['hello', 'world', 'foo'];",
    "texts.forEach(async (text) => {",
    "  await client.embeddings.create({ model: 'text-embedding-3-small', input: text });",
    "});",
  ].join("\n");

  const findings = detectBatchWaste([match], source, "/project/src/api/embed.ts");
  assert.ok(findings.length > 0, "expected a batch finding");
  assert.ok(
    findings.some((f) => f.type === "batch"),
    "finding type should be 'batch'"
  );
  assert.ok(
    findings.some((f) => f.evidence.some((e) => /batch/i.test(e))),
    "evidence should mention batch alternative"
  );
});

run("batch: batchCapable call in loop with batch guard → suppressed", () => {
  const match = makeMatch({
    methodChain: "client.embeddings.create",
    batchCapable: true,
    frequency: "bounded-loop",
    loopContext: true,
    line: 6,
  });

  // Source has a batch mechanism already in place
  const source = [
    "import OpenAI from 'openai';",
    "const client = new OpenAI();",
    "const texts = ['hello', 'world'];",
    "// using bulk embed",
    "const chunks = chunkArray(texts, 100);",
    "for (const chunk of chunks) {",
    "  await client.embeddings.create({ model: 'text-embedding-3-small', input: chunk });",
    "}",
  ].join("\n");

  const findings = detectBatchWaste([match], source, "/project/src/api/embed.ts");
  const batchFindings = findings.filter((f) => f.type === "batch");
  assert.equal(batchFindings.length, 0, "batch guard should suppress the finding");
});

run("batch: non-batchCapable call inside loop → n_plus_one finding emitted", () => {
  const match = makeMatch({
    provider: "stripe",
    methodChain: "stripe.customers.retrieve",
    batchCapable: false,
    cacheCapable: false,
    frequency: "bounded-loop",
    loopContext: true,
    line: 6,
  });

  const source = [
    "import Stripe from 'stripe';",
    "const stripe = new Stripe(process.env.KEY);",
    "const userIds = await db.getActiveUserIds();",
    "const customers = [];",
    "for (const id of userIds) {",
    "  const customer = await stripe.customers.retrieve(id);",
    "  customers.push(customer);",
    "}",
  ].join("\n");

  const findings = detectBatchWaste([match], source, "/project/src/jobs/sync.ts");
  assert.ok(findings.length > 0, "expected n_plus_one finding");
  assert.ok(
    findings.some((f) => f.type === "n_plus_one"),
    "finding type should be 'n_plus_one'"
  );
  assert.ok(
    findings.some((f) => f.evidence.some((e) => /bounded-loop/i.test(e))),
    "evidence should mention the loop frequency"
  );
});

run("batch: two independent single calls to same provider → Promise.all suggestion", () => {
  const matches = [
    makeMatch({
      provider: "openai",
      methodChain: "client.chat.completions.create",
      frequency: "single",
      loopContext: false,
      line: 5,
    }),
    makeMatch({
      provider: "openai",
      methodChain: "client.chat.completions.create",
      frequency: "single",
      loopContext: false,
      line: 8,
    }),
  ];

  const source = [
    "import OpenAI from 'openai';",
    "const client = new OpenAI();",
    "",
    "async function handleRequest() {",
    "  const summary = await client.chat.completions.create({ model: 'gpt-4o', messages: [{ role: 'user', content: 'summarize' }] });",
    "  doSomethingWith(summary);",
    "  const analysis = await client.chat.completions.create({ model: 'gpt-4o', messages: [{ role: 'user', content: 'analyze' }] });",
    "  doSomethingWith(analysis);",
    "}",
  ].join("\n");

  const findings = detectBatchWaste(matches, source, "/project/src/api/route.ts");
  assert.ok(
    findings.some((f) => f.type === "batch"),
    "should suggest Promise.all for sequential calls"
  );
  assert.ok(
    findings.some((f) => /Promise\.all|parallel|sequential/i.test(f.description)),
    "description should mention parallelisation"
  );
});

run("batch: two single calls with concurrency guard → sequential finding suppressed", () => {
  const matches = [
    makeMatch({ provider: "anthropic", frequency: "single", loopContext: false, line: 5 }),
    makeMatch({ provider: "anthropic", frequency: "single", loopContext: false, line: 8 }),
  ];

  // Source has a p-limit guard already
  const source = [
    "import Anthropic from '@anthropic-ai/sdk';",
    "import pLimit from 'p-limit';",
    "const client = new Anthropic();",
    "const limit = pLimit(3);",
    "",
    "const r1 = await limit(() => client.messages.create({ model: 'claude-opus-4-5', max_tokens: 100, messages: [] }));",
    "// ...",
    "const r2 = await limit(() => client.messages.create({ model: 'claude-opus-4-5', max_tokens: 100, messages: [] }));",
  ].join("\n");

  const findings = detectBatchWaste(matches, source, "/project/src/api/chat.ts");
  const seqFindings = findings.filter((f) => f.type === "batch" && /sequential|parallel/i.test(f.description));
  assert.equal(seqFindings.length, 0, "concurrency guard should suppress sequential finding");
});

run("batch: call already inside Promise.all (parallel) with batchCapable → batch finding emitted", () => {
  const match = makeMatch({
    methodChain: "client.embeddings.create",
    batchCapable: true,
    frequency: "parallel",
    loopContext: true,
    line: 4,
  });

  const source = [
    "import OpenAI from 'openai';",
    "const client = new OpenAI();",
    "const results = await Promise.all(",
    "  texts.map((t) => client.embeddings.create({ model: 'text-embedding-3-small', input: t }))",
    ");",
  ].join("\n");

  const findings = detectBatchWaste([match], source, "/project/src/api/embed.ts");
  assert.ok(
    findings.some((f) => f.type === "batch"),
    "even parallel fan-out of batch-capable calls should suggest using the batch API"
  );
});
