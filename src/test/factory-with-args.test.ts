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
    .filter((e) => typeof e === "string" && (e.endsWith(".ts") || e.endsWith(".js")))
    .map((relName) => ({ absolutePath: path.join(fixtureDir, relName), relativePath: relName.replace(/\\/g, "/") }));
  return { files, readFile: async (p: string) => fs.readFileSync(p, "utf-8") };
}

(async () => {
  const root = path.resolve(__dirname, "..", "..", "src", "test", "fixtures", "factory-args");
  await run("A5-followup: factory calls with arguments resolve the assigned client to openai", async () => {
    const calls = await scanFiles(buildFixtureAccess(path.join(root)));
    const consumerCalls = calls.filter((c) => c.file.endsWith("consumer.ts") && c.provider === "openai");
    assert.ok(
      consumerCalls.length >= 5,
      `expected >=5 openai calls (one per factory variant), got ${consumerCalls.length}: ${JSON.stringify(consumerCalls.map((c) => ({ line: c.line, provider: c.provider })))}`
    );
  });
})().catch((err) => { console.error(err); process.exit(1); });
