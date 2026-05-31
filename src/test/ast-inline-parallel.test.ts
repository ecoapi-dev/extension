import assert from "node:assert/strict";
import { detectBatchWaste } from "../ast/waste/batch-detector";
import type { AstCallMatch } from "../ast/ast-scanner";
import { pointSpan } from "../scanner/source-span";

function makeMatch(overrides: Partial<AstCallMatch>): AstCallMatch {
  const line = overrides.line ?? 10;
  const column = overrides.column ?? 0;
  return {
    kind: "sdk", provider: "openai", packageName: "openai",
    methodChain: "openai.images.generate", confidence: 1, method: "POST",
    endpoint: "/v1/images/generations", line, column, span: pointSpan(line, column),
    frequency: "single", loopContext: false, enclosingFunction: null,
    streaming: false, batchCapable: false, inlineParallelCapable: false,
    cacheCapable: false, isMiddleware: false, ...overrides,
  };
}

function findInline(findings: ReturnType<typeof detectBatchWaste>) {
  return findings.filter((f) => f.id.includes("inline_parallel"));
}

function run(name: string, fn: () => void): void {
  try { fn(); console.log(`PASS ${name}`); }
  catch (err) { console.error(`FAIL ${name}`); throw err; }
}

run("inline-parallel: inlineParallelCapable fan-out → unbatched_parallel type, NOT batch-endpoint text", () => {
  const match = makeMatch({ inlineParallelCapable: true, frequency: "parallel", loopContext: true, line: 4 });
  const source = [
    "import OpenAI from 'openai';",
    "const openai = new OpenAI();",
    "const prompts = ['a', 'b', 'c'];",
    "const imgs = await Promise.all(prompts.map((p) => openai.images.generate({ prompt: p })));",
  ].join("\n");
  const findings = detectBatchWaste([match], source, "/project/src/img.ts");
  const inline = findInline(findings);
  assert.ok(
    findings.some((f) => /n\/count parameter|count parameter|single call/i.test(f.description)),
    `expected an inline-parallel (n/count) suggestion, got: ${JSON.stringify(findings.map((f) => f.description))}`
  );
  assert.ok(
    !findings.some((f) => /batch request|batch endpoint|consolidate into a single batch/i.test(f.description)),
    `must not emit batch-endpoint text: ${JSON.stringify(findings.map((f) => f.description))}`
  );
  assert.equal(inline.length, 1, `expected 1 inline_parallel finding, got ${inline.length}`);
  assert.equal(inline[0].type, "unbatched_parallel", `expected type unbatched_parallel, got ${inline[0].type}`);
});

run("inline-parallel: a real batchCapable API in the same shape still emits batch text", () => {
  const match = makeMatch({ methodChain: "client.embeddings.create", batchCapable: true, frequency: "parallel", loopContext: true, line: 4 });
  const source = [
    "import OpenAI from 'openai';",
    "const client = new OpenAI();",
    "const r = await Promise.all(texts.map((t) => client.embeddings.create({ model: 'text-embedding-3-small', input: t })));",
  ].join("\n");
  const findings = detectBatchWaste([match], source, "/project/src/embed.ts");
  assert.ok(findings.some((f) => f.type === "batch" && /batch/i.test(f.description)), "real batch API should still get batch text");
});

run("inline-parallel: Array.from({length:n}) idiom now flagged as unbatched_parallel", () => {
  const match = makeMatch({ inlineParallelCapable: true, frequency: "parallel", loopContext: true, line: 3 });
  const source = [
    "import OpenAI from 'openai';",
    "const openai = new OpenAI();",
    "const imgs = await Promise.all(Array.from({ length: 4 }).map(() => openai.images.generate({ prompt: 'x' })));",
  ].join("\n");
  const findings = detectBatchWaste([match], source, "/project/src/img.ts");
  const inline = findInline(findings);
  assert.equal(inline.length, 1, `expected 1 inline_parallel finding for Array.from idiom, got: ${JSON.stringify(findings.map((f) => f.description))}`);
  assert.equal(inline[0].type, "unbatched_parallel", `expected type unbatched_parallel, got ${inline[0].type}`);
});

run("inline-parallel: inlineParallelCapable in an unbounded for-loop → unbatched_parallel type fires", () => {
  const match = makeMatch({ inlineParallelCapable: true, frequency: "unbounded-loop", loopContext: true, line: 4 });
  const source = [
    "import OpenAI from 'openai';",
    "const openai = new OpenAI();",
    "for (const p of prompts) {",
    "  const img = await openai.images.generate({ prompt: p });",
    "}",
  ].join("\n");
  const findings = detectBatchWaste([match], source, "/project/src/img.ts");
  const inline = findInline(findings);
  assert.ok(
    findings.some((f) => /n\/count parameter|count parameter|single call/i.test(f.description)),
    `expected an inline-parallel suggestion for the loop case, got: ${JSON.stringify(findings.map((f) => f.description))}`
  );
  assert.equal(inline.length, 1, `expected 1 inline_parallel finding for loop case, got ${inline.length}`);
  assert.equal(inline[0].type, "unbatched_parallel", `expected type unbatched_parallel for loop case, got ${inline[0].type}`);
});

run("inline-parallel: inlineParallelCapable:false → zero inline findings (precision gate)", () => {
  const match = makeMatch({ inlineParallelCapable: false, frequency: "parallel", loopContext: true, line: 3 });
  const source = [
    "import OpenAI from 'openai';",
    "const openai = new OpenAI();",
    "const imgs = await Promise.all(Array.from({ length: 5 }).map(() => openai.images.generate({ prompt: 'x' })));",
  ].join("\n");
  const findings = detectBatchWaste([match], source, "/project/src/img.ts");
  const inline = findInline(findings);
  assert.equal(inline.length, 0, `expected no inline_parallel findings when inlineParallelCapable:false, got: ${JSON.stringify(inline.map((f) => f.description))}`);
});
