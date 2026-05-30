import assert from "node:assert/strict";
import * as path from "node:path";
import * as fs from "node:fs";
import { setWasmDir } from "../ast/parser-loader";
import { detectLocalWastePatternsInFiles, type ScanFileAccess, type ScanInputFile } from "../scanner/core-scanner";

const WASM_DIR = path.join(__dirname, "..", "..", "assets", "parsers");
setWasmDir(WASM_DIR);

async function run(name: string, fn: () => void | Promise<void>): Promise<void> {
  try { await fn(); console.log(`PASS ${name}`); }
  catch (err) { console.error(`FAIL ${name}`); throw err; }
}

function buildFixtureAccess(fixtureDir: string, fileNames: string[]): ScanFileAccess {
  const files: ScanInputFile[] = fileNames.map((name) => ({
    absolutePath: path.join(fixtureDir, name),
    relativePath: name,
  }));
  return {
    files,
    readFile: async (absolutePath: string) => fs.readFileSync(absolutePath, "utf-8"),
  };
}

(async () => {
  const projectRoot = path.resolve(__dirname, "..", "..");
  const fixtureDir = path.resolve(projectRoot, "src", "test", "fixtures", "c1-pr3");

  await run("TS two openai calls in DIFFERENT functions do NOT trigger batch finding", async () => {
    const access = buildFixtureAccess(fixtureDir, ["ts_diff_functions.ts"]);
    const findings = await detectLocalWastePatternsInFiles(access);
    const batchFindings = findings.filter(f => f.type === "batch");
    assert.equal(
      batchFindings.length, 0,
      `expected 0 batch findings on cross-function calls, got ${batchFindings.length}: ${JSON.stringify(batchFindings.map(f => ({ file: f.affectedFile, line: f.line, ev: f.evidence })))}`
    );
  });

  await run("TS two openai calls in the SAME function STILL trigger batch finding", async () => {
    const access = buildFixtureAccess(fixtureDir, ["ts_same_function.ts"]);
    const findings = await detectLocalWastePatternsInFiles(access);
    const batchFindings = findings.filter(f => f.type === "batch");
    assert.ok(
      batchFindings.length >= 1,
      `expected at least 1 batch finding on same-function calls, got ${batchFindings.length}: full findings = ${JSON.stringify(findings.map(f => ({ type: f.type, file: f.affectedFile, line: f.line })))}`
    );
  });

  await run("Python calls with DIFFERENT methodChains across functions do NOT trigger batch finding (FP guard: methodChain equality)", async () => {
    const access = buildFixtureAccess(fixtureDir, ["py_diff_functions.py"]);
    const findings = await detectLocalWastePatternsInFiles(access);
    const batchFindings = findings.filter(f => f.type === "batch");
    assert.equal(
      batchFindings.length, 0,
      `expected 0 batch findings on cross-function Python calls with different methodChains, got ${batchFindings.length}: ${JSON.stringify(batchFindings.map(f => ({ file: f.affectedFile, line: f.line, ev: f.evidence })))}`
    );
  });

  await run("Python three anthropic calls in the SAME function STILL trigger batch finding", async () => {
    const access = buildFixtureAccess(fixtureDir, ["py_same_function.py"]);
    const findings = await detectLocalWastePatternsInFiles(access);
    const batchFindings = findings.filter(f => f.type === "batch");
    assert.ok(
      batchFindings.length >= 1,
      `expected at least 1 batch finding on same-function Python calls, got ${batchFindings.length}: full findings = ${JSON.stringify(findings.map(f => ({ type: f.type, file: f.affectedFile, line: f.line })))}`
    );
  });
})().catch((err) => { console.error(err); process.exit(1); });
