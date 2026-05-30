/**
 * Unit tests for ast/cross-file-resolver.ts (Phase 3.5).
 *
 * Uses synthetic PerFileResult objects with pre-built AstScanResult data.
 * No Tree-sitter WASM is needed — classRegistry and matches are mocked directly.
 *
 * Scenarios:
 *  1. Utility wrapper  — caller imports fn, fn wraps SDK call; caller calls fn in loop → propagated with loop frequency
 *  2. Class service    — callee exports class with embed(); caller calls embed() in Promise.all → propagated with "parallel"
 *  3. Middleware       — caller's middlewareQueue lists imported fn; callee fn has API call → propagated with isMiddleware=true
 *  4. Barrel re-export — utils/index.ts re-exports from utils/openai.ts; feature.ts imports from utils → 2-hop resolution
 *  5. Non-relative import — import from npm package should NOT propagate
 */
import assert from "node:assert/strict";
import { runCrossFileResolution, type PerFileResult } from "../ast/cross-file-resolver";
import type { AstCallMatch, AstScanResult } from "../ast/ast-scanner";
import { pointSpan } from "../scanner/source-span";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeMatch(overrides: Partial<AstCallMatch>): AstCallMatch {
  const line = overrides.line ?? 5;
  const column = overrides.column ?? 0;
  return {
    kind: "sdk",
    provider: "openai",
    packageName: "openai",
    methodChain: "client.chat.completions.create",
    confidence: 1,
    method: "POST",
    line,
    column,
    span: pointSpan(line, column),
    frequency: "single",
    loopContext: false,
    enclosingFunction: null,
    batchCapable: false,
    cacheCapable: false,
    isMiddleware: false,
    ...overrides,
  };
}

function makeResult(overrides: Partial<AstScanResult> = {}): AstScanResult {
  return {
    matches: [],
    classRegistry: new Map(),
    middlewareQueue: [],
    factoryReturnMap: new Map(),
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

run("1. Utility wrapper: caller imports fn called in loop → propagated with loop frequency", () => {
  // lib/ai.ts exports callAI() which contains a chat.completions.create call
  const calleeFile: PerFileResult = {
    filePath: "/project/lib/ai.ts",
    relativePath: "lib/ai.ts",
    source: `
import OpenAI from "openai";
const client = new OpenAI();
export async function callAI(prompt: string) {
  return await client.chat.completions.create({ model: "gpt-4o", messages: [] });
}
`.trim(),
    result: makeResult({
      matches: [makeMatch({ line: 4, frequency: "single", loopContext: false })],
    }),
  };

  // app.ts imports callAI and calls it inside a for...of loop
  // The AST scanner detected callAI as a "bounded-loop" call on line 10
  const callerFile: PerFileResult = {
    filePath: "/project/app.ts",
    relativePath: "app.ts",
    source: `
import { callAI } from "./lib/ai";
async function handleAll(prompts: string[]) {
  for (const p of prompts) {
    await callAI(p);
  }
}
`.trim(),
    result: makeResult({
      matches: [
        makeMatch({
          methodChain: "callAI",
          provider: undefined,
          packageName: undefined,
          line: 4,
          frequency: "bounded-loop",
          loopContext: true,
        }),
      ],
    }),
  };

  const output = runCrossFileResolution([calleeFile, callerFile]);
  const callerMatches = output.get("app.ts")!;

  // Should have original match + propagated match
  const propagated = callerMatches.filter((m) => m.crossFile);
  assert.ok(propagated.length > 0, "Expected at least one propagated match");
  assert.equal(propagated[0].frequency, "bounded-loop", "Propagated match should inherit caller frequency");
  assert.equal(propagated[0].provider, "openai", "Propagated match should carry provider from callee");
  assert.equal(propagated[0].isMiddleware, false);
  assert.equal(propagated[0].sourceFile, "/project/lib/ai.ts");
});

run("2. Class service method exported directly: caller calls embed() in Promise.all → propagated with 'parallel'", () => {
  // services/embedding.ts exports embed() (a class method exposed as a standalone export)
  // The AST scanner puts the underlying API call in the class registry under EmbeddingService.embed
  // AND also exposes the bare name "embed" → same matches via buildExportRegistry
  const calleeFile: PerFileResult = {
    filePath: "/project/services/embedding.ts",
    relativePath: "services/embedding.ts",
    source: `
import OpenAI from "openai";
const client = new OpenAI();
export async function embed(text: string) {
  return await client.embeddings.create({ model: "text-embedding-3-small", input: text });
}
`.trim(),
    result: makeResult({
      matches: [makeMatch({
        methodChain: "client.embeddings.create",
        line: 4,
        frequency: "single",
        loopContext: false,
        batchCapable: true,
      })],
    }),
  };

  // handler.ts imports embed and calls it inside Promise.all
  const callerFile: PerFileResult = {
    filePath: "/project/handler.ts",
    relativePath: "handler.ts",
    source: `
import { embed } from "./services/embedding";
async function embedAll(texts: string[]) {
  return Promise.all(texts.map((t) => embed(t)));
}
`.trim(),
    result: makeResult({
      matches: [
        makeMatch({
          methodChain: "embed",
          provider: undefined,
          packageName: undefined,
          line: 3,
          frequency: "parallel",
          loopContext: true,
        }),
      ],
    }),
  };

  const output = runCrossFileResolution([calleeFile, callerFile]);
  const callerMatches = output.get("handler.ts")!;

  const propagated = callerMatches.filter((m) => m.crossFile);
  assert.ok(propagated.length > 0, "Expected propagated match from class service");
  assert.equal(propagated[0].frequency, "parallel");
  assert.equal(propagated[0].batchCapable, true);
});

run("3. Middleware: middlewareQueue entry resolved → propagated with isMiddleware=true", () => {
  // middleware/auth.ts exports authMiddleware which calls stripe.customers.retrieve
  const calleeFile: PerFileResult = {
    filePath: "/project/middleware/auth.ts",
    relativePath: "middleware/auth.ts",
    source: `
import Stripe from "stripe";
const stripe = new Stripe(process.env.STRIPE_KEY!);
export async function authMiddleware(req: any, res: any, next: any) {
  const customer = await stripe.customers.retrieve(req.user.stripeId);
  next();
}
`.trim(),
    result: makeResult({
      matches: [makeMatch({
        provider: "stripe",
        methodChain: "stripe.customers.retrieve",
        line: 4,
        frequency: "single",
        loopContext: false,
      })],
    }),
  };

  // server.ts has authMiddleware in its middlewareQueue
  const callerFile: PerFileResult = {
    filePath: "/project/server.ts",
    relativePath: "server.ts",
    source: `
import express from "express";
import { authMiddleware } from "./middleware/auth";
const app = express();
app.use(authMiddleware);
`.trim(),
    result: makeResult({
      middlewareQueue: ["authMiddleware"],
    }),
  };

  const output = runCrossFileResolution([calleeFile, callerFile]);
  const callerMatches = output.get("server.ts")!;

  const propagated = callerMatches.filter((m) => m.crossFile);
  assert.ok(propagated.length > 0, "Expected propagated match for middleware");
  assert.equal(propagated[0].isMiddleware, true, "Propagated match should have isMiddleware=true");
  assert.equal(propagated[0].frequency, "single");
  assert.equal(propagated[0].provider, "stripe");
});

run("4. Barrel re-export: 2-hop resolution finds the original API call", () => {
  // utils/openai.ts exports embed() with an embeddings.create call
  const deepFile: PerFileResult = {
    filePath: "/project/utils/openai.ts",
    relativePath: "utils/openai.ts",
    source: `
import OpenAI from "openai";
const client = new OpenAI();
export async function embed(text: string) {
  return client.embeddings.create({ model: "text-embedding-3-small", input: text });
}
`.trim(),
    result: makeResult({
      matches: [makeMatch({
        methodChain: "client.embeddings.create",
        batchCapable: true,
        line: 4,
        frequency: "single",
        loopContext: false,
      })],
    }),
  };

  // utils/index.ts re-exports embed from ./openai
  const barrelFile: PerFileResult = {
    filePath: "/project/utils/index.ts",
    relativePath: "utils/index.ts",
    source: `export { embed } from "./openai";`,
    result: makeResult(),
  };

  // feature.ts imports embed from ../utils (the barrel)
  const callerFile: PerFileResult = {
    filePath: "/project/feature.ts",
    relativePath: "feature.ts",
    source: `
import { embed } from "./utils";
async function run(text: string) {
  return embed(text);
}
`.trim(),
    result: makeResult({
      matches: [
        makeMatch({
          methodChain: "embed",
          provider: undefined,
          packageName: undefined,
          line: 3,
          frequency: "single",
          loopContext: false,
        }),
      ],
    }),
  };

  const output = runCrossFileResolution([deepFile, barrelFile, callerFile]);
  const callerMatches = output.get("feature.ts")!;

  const propagated = callerMatches.filter((m) => m.crossFile);
  assert.ok(propagated.length > 0, "Expected 2-hop propagated match via barrel file");
  assert.equal(propagated[0].provider, "openai");
  assert.equal(propagated[0].batchCapable, true);
});

run("5. Non-relative import: npm package import should NOT trigger propagation", () => {
  const callerFile: PerFileResult = {
    filePath: "/project/consumer.ts",
    relativePath: "consumer.ts",
    source: `
import OpenAI from "openai";
const client = new OpenAI();
async function run() {
  return client.chat.completions.create({ model: "gpt-4o", messages: [] });
}
`.trim(),
    result: makeResult({
      matches: [makeMatch({ line: 4, frequency: "single", loopContext: false })],
    }),
  };

  const output = runCrossFileResolution([callerFile]);
  const callerMatches = output.get("consumer.ts")!;

  const propagated = callerMatches.filter((m) => m.crossFile);
  assert.equal(propagated.length, 0, "npm imports should never trigger cross-file propagation");
  assert.equal(callerMatches.length, 1, "Original match should be preserved");
});

run("B2: propagated match carries a trace (hops=1, callSite=caller, resolvedSite=callee)", () => {
  const calleeFile: PerFileResult = {
    filePath: "/project/lib/ai.ts",
    relativePath: "lib/ai.ts",
    source: `
import OpenAI from "openai";
const client = new OpenAI();
export async function callAI(prompt: string) {
  return await client.chat.completions.create({ model: "gpt-4o", messages: [] });
}
`.trim(),
    result: makeResult({ matches: [makeMatch({ line: 4 })] }),
  };
  const callerFile: PerFileResult = {
    filePath: "/project/app.ts",
    relativePath: "app.ts",
    source: `
import { callAI } from "./lib/ai";
async function handle() {
  await callAI("hi");
}
`.trim(),
    result: makeResult({
      matches: [makeMatch({ methodChain: "callAI", provider: undefined, packageName: undefined, line: 3 })],
    }),
  };

  const output = runCrossFileResolution([calleeFile, callerFile]);
  const propagated = output.get("app.ts")!.filter((m) => m.crossFile);
  assert.ok(propagated.length > 0, "expected a propagated match");
  const trace = propagated[0].trace;
  assert.ok(trace, "propagated match should carry a trace");
  assert.equal(trace!.hops, 1, "single wrapper hop");
  assert.equal(trace!.callSite.file, "app.ts", "callSite is the caller file");
  assert.equal(trace!.callSite.span.startLine, 3, "callSite span points at the caller's call line (not the callee's)");
  assert.equal(trace!.resolvedSite.file, "lib/ai.ts", "resolvedSite is the callee file");
  assert.equal(trace!.resolvedSite.span.startLine, 4, "resolvedSite span points at the SDK call line");
});

run("B2: direct (non-propagated) match has no trace", () => {
  const file: PerFileResult = {
    filePath: "/project/solo.ts",
    relativePath: "solo.ts",
    source: `
import OpenAI from "openai";
const client = new OpenAI();
await client.chat.completions.create({ model: "gpt-4o", messages: [] });
`.trim(),
    result: makeResult({ matches: [makeMatch({ line: 3 })] }),
  };
  const output = runCrossFileResolution([file]);
  const direct = output.get("solo.ts")!.filter((m) => !m.crossFile);
  assert.equal(direct[0].trace, undefined, "direct matches carry no trace (defaulted downstream)");
});

console.log("\nAll ast-cross-file-resolver tests passed.");
