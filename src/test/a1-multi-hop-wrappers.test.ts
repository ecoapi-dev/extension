import assert from "node:assert/strict";
import * as path from "node:path";
import * as fs from "node:fs";
import { setWasmDir } from "../ast/parser-loader";
import { scanFileWithAst } from "../ast/ast-scanner";
import { runCrossFileResolution, type PerFileResult } from "../ast/cross-file-resolver";

const WASM_DIR = path.join(__dirname, "..", "..", "assets", "parsers");
setWasmDir(WASM_DIR);

async function run(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (err) {
    console.error(`FAIL ${name}`);
    throw err;
  }
}

async function buildPerFileResults(fixtureDir: string, fileNames: string[]): Promise<PerFileResult[]> {
  const reader = async (fp: string): Promise<string | null> => {
    try {
      return fs.readFileSync(fp, "utf-8");
    } catch {
      return null;
    }
  };

  const out: PerFileResult[] = [];
  for (const name of fileNames) {
    const absolutePath = path.join(fixtureDir, name);
    const source = fs.readFileSync(absolutePath, "utf-8");
    const result = await scanFileWithAst(absolutePath, reader);
    out.push({
      filePath: absolutePath,
      relativePath: name,
      source,
      result,
    });
  }
  return out;
}

(async () => {
  const projectRoot = path.resolve(__dirname, "..", "..");
  const fixtureDir = path.resolve(projectRoot, "src", "test", "fixtures", "wrappers");

  await run("3-hop wrapper chain: openai match propagates to all 3 caller layers", async () => {
    const files = await buildPerFileResults(fixtureDir, [
      "callOpenAi.ts",
      "level3Helper.ts",
      "level2Helper.ts",
      "level1Entry.ts",
    ]);

    const augmented = runCrossFileResolution(files);

    const leafMatches = augmented.get("callOpenAi.ts") ?? [];
    const openaiAtLeaf = leafMatches.filter((m) => m.provider === "openai");
    assert.ok(
      openaiAtLeaf.length > 0,
      `callOpenAi.ts should keep its original openai match; got ${JSON.stringify(leafMatches.map((m) => ({ provider: m.provider, methodChain: m.methodChain })))}`
    );

    const level3Matches = augmented.get("level3Helper.ts") ?? [];
    const openaiAtL3 = level3Matches.filter((m) => m.provider === "openai");
    assert.ok(
      openaiAtL3.length > 0,
      `level3Helper.ts should see openai propagated (1 hop); got ${JSON.stringify(level3Matches.map((m) => ({ provider: m.provider, methodChain: m.methodChain, crossFile: m.crossFile })))}`
    );

    const level2Matches = augmented.get("level2Helper.ts") ?? [];
    const openaiAtL2 = level2Matches.filter((m) => m.provider === "openai");
    assert.ok(
      openaiAtL2.length > 0,
      `level2Helper.ts should see openai propagated (2 hops); got ${JSON.stringify(level2Matches.map((m) => ({ provider: m.provider, methodChain: m.methodChain, crossFile: m.crossFile })))}`
    );

    const level1Matches = augmented.get("level1Entry.ts") ?? [];
    const openaiAtL1 = level1Matches.filter((m) => m.provider === "openai");
    assert.ok(
      openaiAtL1.length > 0,
      `level1Entry.ts should see openai propagated (3 hops); got ${JSON.stringify(level1Matches.map((m) => ({ provider: m.provider, methodChain: m.methodChain, crossFile: m.crossFile })))}`
    );
  });

  await run("cycle protection: re-export cycle terminates without infinite loop", async () => {
    // cycleA.ts:    export { something } from "./cycleB";
    // cycleB.ts:    export { something } from "./cycleA";
    // cycleCaller.ts: import { something } from "./cycleA"; useIt() { return something(); }
    //
    // The caller forces resolveExportedMatches("something", cycleA, ...). Since
    // `something` is not defined directly in cycleA, the resolver follows the
    // re-export to cycleB. cycleB also re-exports `something` from cycleA →
    // back to the start. Without the `visited` set guard, this is infinite
    // recursion and the test will hang well past any sane time budget.
    const files = await buildPerFileResults(fixtureDir, [
      "cycleA.ts",
      "cycleB.ts",
      "cycleCaller.ts",
    ]);

    const start = Date.now();
    const augmented = runCrossFileResolution(files);
    const elapsedMs = Date.now() - start;

    assert.ok(
      elapsedMs < 1000,
      `mutual re-export cycle should terminate quickly; took ${elapsedMs}ms`
    );

    // All three files should be present in the output, and nothing should have
    // been propagated for the made-up symbol (it doesn't resolve to any match).
    assert.ok(augmented.has("cycleA.ts"), "cycleA.ts should be present in output map");
    assert.ok(augmented.has("cycleB.ts"), "cycleB.ts should be present in output map");
    assert.ok(augmented.has("cycleCaller.ts"), "cycleCaller.ts should be present in output map");
    const callerMatches = augmented.get("cycleCaller.ts") ?? [];
    const propagated = callerMatches.filter((m) => m.crossFile);
    assert.equal(
      propagated.length,
      0,
      `no propagation expected from cycle with no real SDK match; got ${JSON.stringify(propagated.map((m) => ({ provider: m.provider, methodChain: m.methodChain })))}`
    );
  });

  await run("maxDepth=1 clamps wrapper-chain propagation to a single hop", async () => {
    const files = await buildPerFileResults(fixtureDir, [
      "callOpenAi.ts",
      "level3Helper.ts",
      "level2Helper.ts",
      "level1Entry.ts",
    ]);

    const augmented = runCrossFileResolution(files, { maxDepth: 1 });

    // Leaf retains its own original SDK match.
    const leafMatches = augmented.get("callOpenAi.ts") ?? [];
    const openaiAtLeaf = leafMatches.filter((m) => m.provider === "openai");
    assert.ok(
      openaiAtLeaf.length > 0,
      "callOpenAi.ts should keep its original openai match even with maxDepth=1"
    );

    // 1 hop reaches level3Helper.
    const level3Matches = augmented.get("level3Helper.ts") ?? [];
    const openaiAtL3 = level3Matches.filter(
      (m) => m.provider === "openai" && m.crossFile
    );
    assert.ok(
      openaiAtL3.length > 0,
      `level3Helper.ts should see openai propagated within 1 hop; got ${JSON.stringify(level3Matches.map((m) => ({ provider: m.provider, methodChain: m.methodChain, crossFile: m.crossFile })))}`
    );

    // 2+ hops MUST be clamped off.
    const level2Matches = augmented.get("level2Helper.ts") ?? [];
    const openaiAtL2 = level2Matches.filter(
      (m) => m.provider === "openai" && m.crossFile
    );
    assert.equal(
      openaiAtL2.length,
      0,
      `level2Helper.ts should NOT see openai with maxDepth=1 (needs 2 hops); got ${JSON.stringify(level2Matches.map((m) => ({ provider: m.provider, methodChain: m.methodChain, crossFile: m.crossFile })))}`
    );

    const level1Matches = augmented.get("level1Entry.ts") ?? [];
    const openaiAtL1 = level1Matches.filter(
      (m) => m.provider === "openai" && m.crossFile
    );
    assert.equal(
      openaiAtL1.length,
      0,
      `level1Entry.ts should NOT see openai with maxDepth=1 (needs 3 hops); got ${JSON.stringify(level1Matches.map((m) => ({ provider: m.provider, methodChain: m.methodChain, crossFile: m.crossFile })))}`
    );
  });

  console.log("\nAll a1-multi-hop-wrappers tests passed.");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
