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
  const entries = fs.readdirSync(fixtureDir, { recursive: true }) as string[];
  const files: ScanInputFile[] = entries
    .filter((entry) => typeof entry === "string" && (entry.endsWith(".ts") || entry.endsWith(".js")))
    .map((relName) => ({
      absolutePath: path.join(fixtureDir, relName),
      relativePath: relName.replace(/\\/g, "/"),
    }));
  return {
    files,
    readFile: async (absolutePath: string) => fs.readFileSync(absolutePath, "utf-8"),
  };
}

(async () => {
  const projectRoot = path.resolve(__dirname, "..", "..");
  const fixtureDir = path.resolve(projectRoot, "src", "test", "fixtures", "wrappers");
  const calls = await scanFiles(buildFixtureAccess(fixtureDir));

  await run("Pre-A: scanFiles() output reflects cross-file resolution (callers of wrapper functions get openai provider)", () => {
    const level1Calls = calls.filter((c) => c.file.endsWith("level1Entry.ts"));
    const openaiCalls = level1Calls.filter((c) => c.provider === "openai");
    assert.ok(
      openaiCalls.length >= 1,
      `expected >=1 openai call attributed to level1Entry.ts via wrapper resolution, got ${openaiCalls.length}: ${JSON.stringify(level1Calls.map((c) => ({ line: c.line, provider: c.provider, methodSig: c.methodSignature })))}`
    );
  });
})().catch((err) => { console.error(err); process.exit(1); });
