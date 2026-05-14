import assert from "node:assert/strict";
import * as path from "node:path";
import * as fs from "node:fs";
import { setWasmDir } from "../ast/parser-loader";
import { scanFiles, type ScanFileAccess, type ScanInputFile } from "../scanner/core-scanner";

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
  const root = path.resolve(projectRoot, "src", "test", "fixtures", "a3-a5");

  await run("A3.0 baseline: direct re-export `export { x } from './foo'` resolves to openai", async () => {
    const calls = await scanFiles(buildFixtureAccess(path.join(root, "barrel-direct")));
    const consumerCalls = calls.filter((c) => c.file.endsWith("consumer.ts"));
    const openaiCalls = consumerCalls.filter((c) => c.provider === "openai");
    assert.ok(
      openaiCalls.length >= 1,
      `baseline failed: got ${openaiCalls.length} openai calls from consumer.ts: ${JSON.stringify(consumerCalls.map((c) => ({ line: c.line, provider: c.provider })))}`
    );
  });

  // AGENT-A3.audit.aliased-INSERT-HERE
  // AGENT-A3.audit.wildcard-INSERT-HERE
  // AGENT-A3.audit.nested-INSERT-HERE
  // AGENT-A3.audit.default-INSERT-HERE
  // AGENT-A3.audit.missing-INSERT-HERE
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
