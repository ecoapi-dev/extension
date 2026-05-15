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
  const fixtureDir = path.resolve(projectRoot, "src", "test", "fixtures", "c1-pr4");

  await run("TS two cross-file wrapper calls in same function do NOT trigger batch finding", async () => {
    const access = buildFixtureAccess(fixtureDir, [
      "ts_wrapper_sequential_main.ts",
      "ts_wrapper_sequential_helper.ts",
    ]);
    const findings = await detectLocalWastePatternsInFiles(access);
    const batchFindings = findings.filter((f) => f.type === "batch");
    assert.equal(
      batchFindings.length, 0,
      `expected 0 batch findings on cross-file wrapper sequence, got ${batchFindings.length}: ${JSON.stringify(batchFindings.map((f) => ({ file: f.affectedFile, line: f.line, ev: f.evidence })))}`
    );
  });
})().catch((err) => { console.error(err); process.exit(1); });
