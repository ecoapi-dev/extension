/**
 * Unit tests for ast/waste/cache-detector.ts.
 *
 * These tests construct AstCallMatch objects directly (no Tree-sitter parsing)
 * so they run fast and don't require WASM. Structural frequency data that the
 * AST scanner would normally derive is set directly on the mock objects.
 *
 * Covered scenarios:
 *  1. API call in a loop with no cache guard → finding emitted
 *  2. API call in a loop with a cache guard in preceding source lines → suppressed
 *  3. Same method chain repeated twice (redundant) → finding emitted
 *  4. cacheCapable call inside middleware (isMiddleware=true) → finding emitted
 *  5. Single call in a startup-like file path with no other signals → suppressed
 */
import assert from "node:assert/strict";
import { detectCacheWaste } from "../ast/waste/cache-detector";
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

run("cache: API call in bounded-loop with no cache → finding emitted", () => {
  const match = makeMatch({
    method: "GET",
    methodChain: "client.embeddings.create",
    frequency: "bounded-loop",
    loopContext: true,
    cacheCapable: true,
  });

  const source = `
import OpenAI from "openai";
const client = new OpenAI();
const items = ["a", "b", "c"];
for (const item of items) {
  await client.embeddings.create({ model: "text-embedding-3-small", input: item });
}
`.trimStart();

  // line 6 — no cache guard in preceding lines
  const findings = detectCacheWaste([match], source, "/project/src/api/handler.ts");
  assert.equal(findings.length, 1, "expected one finding");
  assert.equal(findings[0].type, "cache");
  assert.ok(findings[0].severity === "medium" || findings[0].severity === "high");
  assert.ok(
    findings[0].evidence.some((e) => /bounded-loop/i.test(e)),
    "evidence should mention loop context"
  );
});

run("cache: API call in loop but cache guard is present → suppressed", () => {
  const match = makeMatch({
    method: "GET",
    methodChain: "client.embeddings.create",
    frequency: "bounded-loop",
    loopContext: true,
    cacheCapable: true,
    line: 7, // line 7 in the source below
  });

  // Lines 1-6 include a `cache.get` call — window scan should detect the guard.
  const source = [
    "import OpenAI from 'openai';",
    "const client = new OpenAI();",
    "const items = ['a', 'b'];",
    "for (const item of items) {",
    "  const cached = cache.get(item);",
    "  if (cached) continue;",
    "  await client.embeddings.create({ model: 'text-embedding-3-small', input: item });",
    "}",
  ].join("\n");

  const findings = detectCacheWaste([match], source, "/project/src/api/handler.ts");
  assert.equal(findings.length, 0, "cache guard should suppress the finding");
});

run("cache: same read-like methodChain called twice → redundancy finding emitted", () => {
  // Simulates fetching the same subscription data in two separate functions
  // without caching the result. Both are read-like (GET, cacheCapable=true).
  const chain = "stripe.subscriptions.retrieve";
  const matches = [
    makeMatch({
      methodChain: chain,
      provider: "stripe",
      method: "GET",
      cacheCapable: true,
      frequency: "single",
      loopContext: false,
      line: 5,
    }),
    makeMatch({
      methodChain: chain,
      provider: "stripe",
      method: "GET",
      cacheCapable: true,
      frequency: "single",
      loopContext: false,
      line: 15,
    }),
  ];

  // Source has no cache guard near either call.
  const source = [
    "import Stripe from 'stripe';",
    "const stripe = new Stripe(process.env.KEY);",
    "",
    "async function checkPlan(userId) {",
    "  return stripe.subscriptions.retrieve(userId);",
    "}",
    "",
    "async function getPlanDetails(userId) {",
    "  return stripe.subscriptions.retrieve(userId);",
    "}",
  ].join("\n");

  const findings = detectCacheWaste(matches, source, "/project/src/utils/billing.ts");
  assert.ok(findings.length > 0, "expected at least one finding for redundant read-like calls");
  assert.ok(
    findings.every((f) => f.type === "cache"),
    "all findings should be type 'cache'"
  );
  assert.ok(
    findings.some((f) => f.evidence.some((e) => /2×/i.test(e))),
    "evidence should report occurrence count"
  );
});

run("cache: cacheCapable call in middleware (isMiddleware=true) → finding emitted", () => {
  const match = makeMatch({
    method: "GET",
    methodChain: "stripe.subscriptions.retrieve",
    provider: "stripe",
    frequency: "single",
    loopContext: false,
    cacheCapable: true,
    isMiddleware: true,
    line: 5,
  });

  const source = [
    "import Stripe from 'stripe';",
    "const stripe = new Stripe(process.env.STRIPE_KEY);",
    "export function checkSubscription(req, res, next) {",
    "  const sub = await stripe.subscriptions.retrieve(req.user.subId);",
    "  req.subscription = sub;",
    "  next();",
    "}",
  ].join("\n");

  const findings = detectCacheWaste([match], source, "/project/src/middleware/auth.ts");
  assert.equal(findings.length, 1, "expected finding for middleware API call");
  assert.equal(findings[0].type, "cache");
  assert.ok(
    findings[0].evidence.some((e) => /middleware/i.test(e)),
    "evidence should mention middleware"
  );
  // confidence bump from cacheCapable
  assert.ok(findings[0].confidence > 0.5, "confidence should be above baseline for cacheCapable");
});

run("cache: single call in startup file with no other signals → suppressed", () => {
  const match = makeMatch({
    method: "GET",
    methodChain: "client.models.list",
    frequency: "single",
    loopContext: false,
    cacheCapable: false,
    isMiddleware: false,
    line: 4,
  });

  const source = [
    "import OpenAI from 'openai';",
    "const client = new OpenAI();",
    "// Fetch available models at startup",
    "const models = await client.models.list();",
  ].join("\n");

  // Startup-like path: no loop, no hot path, no redundancy, no auth/config
  const findings = detectCacheWaste([match], source, "/project/src/scripts/init.ts");
  assert.equal(findings.length, 0, "startup one-time call should not be flagged");
});

run("cache: frequency=cache-guarded (AST-detected) → suppressed without text scan", () => {
  // Simulates: if (!cache.has(key)) { client.chat.completions.create(...) }
  // The AST frequency-analyzer sets frequency="cache-guarded" structurally.
  const match = makeMatch({
    method: "POST",
    methodChain: "client.chat.completions.create",
    frequency: "cache-guarded",
    loopContext: false,
    cacheCapable: true,
    line: 5,
  });

  // Source intentionally has no cache-guard text in the window to verify
  // that the AST frequency field alone is sufficient to suppress the finding.
  const source = [
    "import OpenAI from 'openai';",
    "const client = new OpenAI();",
    "const map = new Map();",
    "if (!map.has(key)) {",
    "  map.set(key, await client.chat.completions.create({ model: 'gpt-4o', messages: [] }));",
    "}",
  ].join("\n");

  const findings = detectCacheWaste([match], source, "/project/src/api/route.ts");
  assert.equal(findings.length, 0, "cache-guarded frequency should suppress finding");
});
