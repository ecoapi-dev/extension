import assert from "node:assert/strict";
import * as path from "node:path";
import * as fs from "node:fs";
import { setWasmDir } from "../ast/parser-loader";
import { scanFiles, type ScanFileAccess, type ScanInputFile } from "../scanner/core-scanner";

const WASM_DIR = path.join(__dirname, "..", "..", "assets", "parsers");
setWasmDir(WASM_DIR);

async function run(name: string, fn: () => void | Promise<void>): Promise<void> {
  try { await fn(); console.log(`PASS ${name}`); }
  catch (err) { console.error(`FAIL ${name}`); throw err; }
}

function buildFixtureAccess(fixtureDir: string): ScanFileAccess {
  const files: ScanInputFile[] = fs
    .readdirSync(fixtureDir)
    .filter((name) => name.endsWith(".ts"))
    .map((name) => ({
      absolutePath: path.join(fixtureDir, name),
      relativePath: name,
    }));
  return {
    files,
    readFile: async (absolutePath: string) => fs.readFileSync(absolutePath, "utf-8"),
  };
}

(async () => {
  // tsc rootDir=src outputs this test to dist-test/test/, so the project root
  // sits two directories above the compiled test file.
  const projectRoot = path.resolve(__dirname, "..", "..");
  const fixtureDir = path.resolve(projectRoot, "src", "test", "fixtures", "a6");

  // Scan once; reuse the result across the three behavioural assertions.
  const access = buildFixtureAccess(fixtureDir);
  const apiCalls = await scanFiles(access);

  await run("data file with method-chain string keys produces zero detections", () => {
    const fromDataFile = apiCalls.filter((c) => c.file.endsWith("pricing-config.ts"));
    assert.equal(
      fromDataFile.length, 0,
      `expected 0 detections from pricing-config.ts, got ${fromDataFile.length}: ${JSON.stringify(fromDataFile.map((c) => ({ method: c.methodSignature ?? c.method, lib: c.library, line: c.line })))}`
    );
  });

  await run("real service.ts call is still detected", () => {
    const openaiCalls = apiCalls.filter((c) => c.provider === "openai");
    assert.ok(openaiCalls.length >= 1, `expected at least 1 openai detection in service.ts, got ${openaiCalls.length}`);
    const fromService = openaiCalls.filter((c) => c.file.endsWith("service.ts"));
    assert.ok(fromService.length >= 1, "openai detection should come from service.ts");
  });

  await run("service.ts emits exactly one openai call site (no import/constructor FPs)", () => {
    const serviceCallSites = apiCalls.filter((c) => c.file.endsWith("service.ts"));
    // The real call is on line 5 (client.chat.completions.create). Lines 1
    // (import) and 2 (new OpenAI()) should NOT produce extra call sites.
    const phantomLines = serviceCallSites.filter((c) => c.line === 1 || c.line === 2);
    assert.equal(
      phantomLines.length, 0,
      `expected no call sites at service.ts:1 or :2, got ${phantomLines.length}: ${JSON.stringify(phantomLines.map((c) => ({ line: c.line, library: c.library })))}`
    );
  });

  await run("filename-based workaround patterns are removed from file-discovery.ts", () => {
    const fdSource = fs.readFileSync(
      path.resolve(projectRoot, "src", "scanner", "file-discovery.ts"),
      "utf8"
    );
    const bannedPatterns = ["pricing.ts", "pricing.js", "pricing.tsx", "costs.ts", "costs.js", "rates.ts", "rates.js", "api-config.ts", "api-config.js", "provider-config.ts", "provider-config.js", "api-pricing.ts", "api-pricing.js"];
    for (const p of bannedPatterns) {
      assert.ok(
        !fdSource.includes(`"**/${p}"`),
        `file-discovery.ts still contains filename-based workaround for **/${p}`
      );
    }
  });
})().catch((err) => { console.error(err); process.exit(1); });
