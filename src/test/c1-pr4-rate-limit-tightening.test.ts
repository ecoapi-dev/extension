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

  await run("TS withRetry() wrapper does NOT trigger rate_limit finding", async () => {
    const access = buildFixtureAccess(fixtureDir, ["ts_retry_wrapper.ts"]);
    const findings = await detectLocalWastePatternsInFiles(access);
    const rateLimitFindings = findings.filter((f) => f.type === "rate_limit");
    assert.equal(
      rateLimitFindings.length, 0,
      `expected 0 rate_limit findings around withRetry() wrapper, got ${rateLimitFindings.length}: ${JSON.stringify(rateLimitFindings.map((f) => ({ file: f.affectedFile, line: f.line, ev: f.evidence })))}`
    );
  });

  await run("TS bare retry loop without backoff STILL triggers rate_limit finding", async () => {
    const access = buildFixtureAccess(fixtureDir, ["ts_retry_loop.ts"]);
    const findings = await detectLocalWastePatternsInFiles(access);
    const rateLimitFindings = findings.filter((f) => f.type === "rate_limit");
    assert.ok(
      rateLimitFindings.length >= 1,
      `expected at least 1 rate_limit finding on bare retry loop, got ${rateLimitFindings.length}: full findings = ${JSON.stringify(findings.map((f) => ({ type: f.type, file: f.affectedFile, line: f.line })))}`
    );
  });
})().catch((err) => { console.error(err); process.exit(1); });
