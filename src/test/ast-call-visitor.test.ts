/**
 * Tests for ast/call-visitor.ts.
 *
 * Each test parses a code snippet with Tree-sitter and then runs the call
 * visitor over the resulting AST.  No mocking — real WASM parsing.
 */
import assert from "node:assert/strict";
import * as path from "path";
import { parseFile, setWasmDir } from "../ast/parser-loader";
import { extractCalls } from "../ast/call-visitor";

const WASM_DIR = path.join(__dirname, "..", "..", "assets", "parsers");
setWasmDir(WASM_DIR);

// ── Helpers ───────────────────────────────────────────────────────────────────

async function parse(src: string, lang = "javascript") {
  const tree = await parseFile(src, lang);
  if (!tree) throw new Error(`Failed to parse ${lang} source`);
  return tree;
}

async function calls(src: string, lang = "javascript") {
  return extractCalls(await parse(src, lang));
}

function find(
  items: ReturnType<typeof extractCalls>,
  chain: string
) {
  return items.find((c) => c.methodChain === chain);
}

// ── Runner ────────────────────────────────────────────────────────────────────

async function run(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (err) {
    console.error(`FAIL ${name}`);
    throw err;
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

(async () => {
  // ── Basic OpenAI SDK calls ──────────────────────────────────────────────────

  await run("OpenAI SDK: chat.completions.create is extracted", async () => {
    const src = `
      const result = await openai.chat.completions.create({ model: "gpt-4o" });
    `;
    const found = find(await calls(src), "openai.chat.completions.create");
    assert.ok(found, "must find openai.chat.completions.create");
    assert.equal(found!.rootIdentifier, "openai");
    assert.equal(found!.line, 2);
    assert.equal(found!.span.startLine, 2);
    assert.ok(found!.span.endColumn >= found!.span.startColumn);
  });

  await run("span: multi-line call has endLine > startLine", async () => {
    const src = `
const r = await openai.chat.completions.create({
  model: "gpt-4o",
  messages: [{ role: "user", content: "hi" }],
});
`;
    const found = find(await calls(src), "openai.chat.completions.create");
    assert.ok(found, "must find call");
    assert.equal(found!.span.startLine, 2);
    assert.ok(found!.span.endLine > found!.span.startLine, "multi-line call must span >1 line");
  });

  await run("OpenAI SDK: embeddings.create is extracted", async () => {
    const src = `openai.embeddings.create({ input: "hello" });`;
    const found = find(await calls(src), "openai.embeddings.create");
    assert.ok(found, "must find embeddings.create");
    assert.equal(found!.rootIdentifier, "openai");
  });

  // ── Stripe SDK calls ────────────────────────────────────────────────────────

  await run("Stripe SDK: paymentIntents.create is extracted", async () => {
    const src = `
      const pi = await stripe.paymentIntents.create({ amount: 1000, currency: "usd" });
    `;
    const found = find(await calls(src), "stripe.paymentIntents.create");
    assert.ok(found, "must find stripe.paymentIntents.create");
    assert.equal(found!.rootIdentifier, "stripe");
  });

  await run("Stripe SDK: customers.retrieve is extracted", async () => {
    const src = `const c = await stripe.customers.retrieve(customerId);`;
    const found = find(await calls(src), "stripe.customers.retrieve");
    assert.ok(found);
    assert.equal(found!.rootIdentifier, "stripe");
  });

  // ── Plain fetch() calls ─────────────────────────────────────────────────────

  await run("plain fetch: simple identifier call is extracted", async () => {
    const src = `
      const res = await fetch("https://api.example.com/data");
    `;
    const found = find(await calls(src), "fetch");
    assert.ok(found, "must find fetch");
    assert.equal(found!.rootIdentifier, "fetch");
    assert.equal(found!.methodChain, "fetch");
    assert.equal(found!.args.length, 1);
  });

  await run("plain fetch with options: arguments are captured", async () => {
    const src = `fetch("https://api.openai.com/v1/chat", { method: "POST" });`;
    const found = find(await calls(src), "fetch");
    assert.ok(found);
    assert.equal(found!.args.length, 2);
  });

  // ── Deeply nested chains ────────────────────────────────────────────────────

  await run("deeply nested chain: a.b.c.d.e.f() is extracted fully", async () => {
    const src = `a.b.c.d.e.f();`;
    const found = find(await calls(src), "a.b.c.d.e.f");
    assert.ok(found, "must find deeply nested chain");
    assert.equal(found!.rootIdentifier, "a");
    assert.equal(found!.methodChain, "a.b.c.d.e.f");
  });

  // ── Await transparency ──────────────────────────────────────────────────────

  await run("await: call behind await is extracted at same line", async () => {
    const src = `
      const msg = await client.messages.create({ model: "claude-3-5-haiku-latest" });
    `;
    const found = find(await calls(src), "client.messages.create");
    assert.ok(found, "must find call behind await");
    assert.equal(found!.line, 2);
  });

  // ── Optional chaining ───────────────────────────────────────────────────────

  await run("optional chaining: normalised to dots", async () => {
    const src = `openai?.chat?.completions?.create({});`;
    const found = find(await calls(src), "openai.chat.completions.create");
    assert.ok(found, "optional chaining must be normalised to dots");
    assert.equal(found!.rootIdentifier, "openai");
  });

  // ── Computed properties (partial chain) ─────────────────────────────────────

  await run("computed property: chain is truncated, call still recorded", async () => {
    const src = `items[0].create({ amount: 100 });`;
    const results = await calls(src);
    // We expect some call to be recorded (at least "create")
    assert.ok(results.length > 0, "computed property call should still be recorded");
    const found = results.find((c) => c.methodChain.includes("create"));
    assert.ok(found, "should find 'create' in the chain");
  });

  // ── Comments (must NOT be detected) ────────────────────────────────────────

  await run("comments: calls inside comments are NOT detected", async () => {
    const src = `
      // openai.chat.completions.create() should not be found
      /* stripe.paymentIntents.create() also should not be found */
      const x = 1;
    `;
    const result = await calls(src);
    // Only the literal `1` produces no call; comment calls must be absent
    assert.equal(result.length, 0, "no calls should be found in comments");
  });

  // ── String literals (must NOT be detected) ──────────────────────────────────

  await run("string content: calls inside string literals are NOT detected", async () => {
    const src = `const doc = "call openai.chat.completions.create() here";`;
    const result = await calls(src);
    assert.equal(result.length, 0, "no calls should be found in string contents");
  });

  // ── Multiple calls in one file ──────────────────────────────────────────────

  await run("multiple calls: all are extracted", async () => {
    const src = `
      openai.chat.completions.create({});
      stripe.paymentIntents.create({});
      anthropic.messages.create({});
    `;
    const result = await calls(src);
    assert.ok(result.length >= 3, "must find all three calls");
    assert.ok(find(result, "openai.chat.completions.create"));
    assert.ok(find(result, "stripe.paymentIntents.create"));
    assert.ok(find(result, "anthropic.messages.create"));
  });

  // ── Line numbers ────────────────────────────────────────────────────────────

  await run("line numbers: accurate 1-based line reported", async () => {
    const src = `
const a = 1;
const b = openai.chat.completions.create({});
const c = 2;
    `;
    const found = find(await calls(src), "openai.chat.completions.create");
    assert.ok(found);
    assert.equal(found!.line, 3, "call is on line 3");
  });

  // ── TypeScript ──────────────────────────────────────────────────────────────

  await run("TypeScript: generic call expression is extracted", async () => {
    const src = `
      const completion = await client.chat.completions.create<{ content: string }>({ model: "gpt-4o" });
    `;
    const result = await calls(src, "typescript");
    const found = find(result, "client.chat.completions.create");
    assert.ok(found, "TS generic call must be found");
    assert.equal(found!.rootIdentifier, "client");
  });

  await run("TypeScript: class method calls are extracted", async () => {
    const src = `
      class ApiService {
        async callOpenAI() {
          return await this.openai.chat.completions.create({});
        }
      }
    `;
    const result = await calls(src, "typescript");
    const found = result.find((c) => c.methodChain.endsWith("chat.completions.create"));
    assert.ok(found, "method call inside class must be found");
  });

  // ── Arguments ──────────────────────────────────────────────────────────────

  await run("arguments: argument nodes are captured", async () => {
    const src = `openai.embeddings.create({ input: items, model: "text-embedding-3-small" });`;
    const found = find(await calls(src), "openai.embeddings.create");
    assert.ok(found);
    assert.equal(found!.args.length, 1); // one object argument
    assert.equal(found!.args[0].type, "object");
  });

  // ── Nested calls ──────────────────────────────────────────────────────────

  await run("nested calls: inner and outer calls are both extracted", async () => {
    const src = `Promise.all([openai.chat.completions.create({}), stripe.paymentIntents.create({})]);`;
    const result = await calls(src);
    assert.ok(find(result, "Promise.all"));
    assert.ok(find(result, "openai.chat.completions.create"));
    assert.ok(find(result, "stripe.paymentIntents.create"));
  });
})().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
