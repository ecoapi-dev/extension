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

function run(name: string, fn: () => void): void {
  try { fn(); console.log(`PASS ${name}`); }
  catch (err) { console.error(`FAIL ${name}`); throw err; }
}

run("inline-parallel: inlineParallelCapable fan-out → n/count suggestion, NOT batch-endpoint text", () => {
  const match = makeMatch({ inlineParallelCapable: true, frequency: "parallel", loopContext: true, line: 4 });
  const source = [
    "import OpenAI from 'openai';",
    "const openai = new OpenAI();",
    "const prompts = ['a', 'b', 'c'];",
    "const imgs = await Promise.all(prompts.map((p) => openai.images.generate({ prompt: p })));",
  ].join("\n");
  const findings = detectBatchWaste([match], source, "/project/src/img.ts");
  assert.ok(
    findings.some((f) => /n\/count parameter|count parameter|single call/i.test(f.description)),
    `expected an inline-parallel (n/count) suggestion, got: ${JSON.stringify(findings.map((f) => f.description))}`
  );
  assert.ok(
    !findings.some((f) => /batch request|batch endpoint|consolidate into a single batch/i.test(f.description)),
    `must not emit batch-endpoint text: ${JSON.stringify(findings.map((f) => f.description))}`
  );
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

run("inline-parallel: Array.from({length:n}) idiom stays fully suppressed", () => {
  const match = makeMatch({ inlineParallelCapable: true, frequency: "parallel", loopContext: true, line: 3 });
  const source = [
    "import OpenAI from 'openai';",
    "const openai = new OpenAI();",
    "const imgs = await Promise.all(Array.from({ length: 4 }).map(() => openai.images.generate({ prompt: 'x' })));",
  ].join("\n");
  const findings = detectBatchWaste([match], source, "/project/src/img.ts");
  assert.equal(findings.length, 0, `expected no findings for the Array.from idiom, got: ${JSON.stringify(findings.map((f) => f.description))}`);
});

run("inline-parallel: inlineParallelCapable in an unbounded for-loop → n/count suggestion fires", () => {
  const match = makeMatch({ inlineParallelCapable: true, frequency: "unbounded-loop", loopContext: true, line: 4 });
  const source = [
    "import OpenAI from 'openai';",
    "const openai = new OpenAI();",
    "for (const p of prompts) {",
    "  const img = await openai.images.generate({ prompt: p });",
    "}",
  ].join("\n");
  const findings = detectBatchWaste([match], source, "/project/src/img.ts");
  assert.ok(
    findings.some((f) => /n\/count parameter|count parameter|single call/i.test(f.description)),
    `expected an inline-parallel suggestion for the loop case, got: ${JSON.stringify(findings.map((f) => f.description))}`
  );
});
