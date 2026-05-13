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
  const fixtureDir = path.resolve(projectRoot, "src", "test", "fixtures", "c1-pr2");

  await run("Python chat.completions.create does NOT trigger cache finding", async () => {
    const access = buildFixtureAccess(fixtureDir, ["python_chat_completion.py"]);
    const findings = await detectLocalWastePatternsInFiles(access);
    const cacheFindings = findings.filter(f => f.type === "cache");
    assert.equal(
      cacheFindings.length, 0,
      `expected 0 cache findings on chat completion, got ${cacheFindings.length}: ${JSON.stringify(cacheFindings.map(f => ({ file: f.affectedFile, line: f.line, ev: f.evidence })))}`
    );
  });

  await run("Python real GET-shaped read (stripe.Customer.retrieve) STILL triggers cache finding", async () => {
    const access = buildFixtureAccess(fixtureDir, ["python_real_read.py"]);
    const findings = await detectLocalWastePatternsInFiles(access);
    const cacheFindings = findings.filter(f => f.type === "cache");
    assert.ok(
      cacheFindings.length >= 1,
      `expected at least 1 cache finding on stripe.Customer.retrieve, got ${cacheFindings.length}: full findings = ${JSON.stringify(findings.map(f => ({ type: f.type, file: f.affectedFile, line: f.line })))}`
    );
  });

  await run("TS three different fetch URLs do NOT trigger cache redundancy", async () => {
    const access = buildFixtureAccess(fixtureDir, ["ts_diff_fetch_urls.ts"]);
    const findings = await detectLocalWastePatternsInFiles(access);
    const cacheFindings = findings.filter(f => f.type === "cache");
    assert.equal(
      cacheFindings.length, 0,
      `expected 0 cache findings on three different fetch URLs, got ${cacheFindings.length}: ${JSON.stringify(cacheFindings.map(f => ({ line: f.line, ev: f.evidence })))}`
    );
  });

  await run("TS two fetches to the same URL STILL trigger cache redundancy", async () => {
    const access = buildFixtureAccess(fixtureDir, ["ts_same_fetch_url.ts"]);
    const findings = await detectLocalWastePatternsInFiles(access);
    const cacheFindings = findings.filter(f => f.type === "cache");
    assert.ok(
      cacheFindings.length >= 1,
      `expected at least 1 cache finding on duplicate fetch URLs, got ${cacheFindings.length}: full findings = ${JSON.stringify(findings.map(f => ({ type: f.type, line: f.line })))}`
    );
  });

  await run("Python POST to a URL containing a read keyword does NOT trigger cache finding", async () => {
    const access = buildFixtureAccess(fixtureDir, ["python_post_embed.py"]);
    const findings = await detectLocalWastePatternsInFiles(access);
    const cacheFindings = findings.filter(f => f.type === "cache");
    assert.equal(
      cacheFindings.length, 0,
      `expected 0 cache findings on POST /v1/embed, got ${cacheFindings.length}: ${JSON.stringify(cacheFindings.map(f => ({ file: f.affectedFile, line: f.line, ev: f.evidence })))}`
    );
  });

  await run("TS GET and POST to the same URL do NOT trigger cache redundancy on the GET", async () => {
    const access = buildFixtureAccess(fixtureDir, ["ts_get_post_same_url.ts"]);
    const findings = await detectLocalWastePatternsInFiles(access);
    const cacheFindings = findings.filter(f => f.type === "cache");
    assert.equal(
      cacheFindings.length, 0,
      `expected 0 cache findings when sibling POST shares the URL with a GET, got ${cacheFindings.length}: ${JSON.stringify(cacheFindings.map(f => ({ file: f.affectedFile, line: f.line, ev: f.evidence })))}`
    );
  });
})().catch((err) => { console.error(err); process.exit(1); });
