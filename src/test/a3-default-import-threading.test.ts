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
  const root = path.resolve(__dirname, "..", "..", "src", "test", "fixtures", "a3-followup");

  await run("A3-followup: named import in a mixed barrel resolves to its OWN provider, not the default re-export's", async () => {
    const calls = await scanFiles(buildFixtureAccess(path.join(root, "mixed-barrel")));
    const consumerCalls = calls.filter((c) => c.file.endsWith("consumer.ts"));
    assert.ok(
      consumerCalls.some((c) => c.provider === "anthropic"),
      `named import leaked to the default's provider: ${JSON.stringify(consumerCalls.map((c) => ({ line: c.line, provider: c.provider })))}`
    );
    assert.ok(
      consumerCalls.some((c) => c.provider === "openai"),
      `default import failed to resolve: ${JSON.stringify(consumerCalls.map((c) => ({ line: c.line, provider: c.provider })))}`
    );
  });
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
