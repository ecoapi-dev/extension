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

  await run("A3.audit.aliased: `export { x as y }` re-export resolves consumer call to openai", async () => {
    const calls = await scanFiles(buildFixtureAccess(path.join(root, "barrel-aliased")));
    const consumerCalls = calls.filter((c) => c.file.endsWith("consumer.ts"));
    const openaiCalls = consumerCalls.filter((c) => c.provider === "openai");
    assert.ok(openaiCalls.length >= 1, `aliased re-export failed: got ${openaiCalls.length} calls: ${JSON.stringify(consumerCalls.map((c) => ({ line: c.line, provider: c.provider })))}`);
  });

  await run("A3.audit.wildcard: `export *` re-export resolves consumer call to openai", async () => {
    const calls = await scanFiles(buildFixtureAccess(path.join(root, "barrel-wildcard")));
    const consumerCalls = calls.filter((c) => c.file.endsWith("consumer.ts"));
    const openaiCalls = consumerCalls.filter((c) => c.provider === "openai");
    assert.ok(openaiCalls.length >= 1, `wildcard re-export failed: got ${openaiCalls.length} calls`);
  });

  await run("A3.audit.nested: 2-level nested barrels (`index → providers → openai`) resolve consumer call", async () => {
    const calls = await scanFiles(buildFixtureAccess(path.join(root, "barrel-nested")));
    const consumerCalls = calls.filter((c) => c.file.endsWith("consumer.ts"));
    const openaiCalls = consumerCalls.filter((c) => c.provider === "openai");
    assert.ok(openaiCalls.length >= 1, `nested barrel failed: got ${openaiCalls.length} calls`);
  });

  await run("A3.audit.default: `export { default } from` resolves consumer's default import to openai", async () => {
    const calls = await scanFiles(buildFixtureAccess(path.join(root, "barrel-default")));
    const consumerCalls = calls.filter((c) => c.file.endsWith("consumer.ts"));
    const openaiCalls = consumerCalls.filter((c) => c.provider === "openai");
    assert.ok(openaiCalls.length >= 1, `default re-export failed: got ${openaiCalls.length} calls`);
  });

  await run("A3.audit.missing: barrel re-exports a non-existent symbol; scan completes without throwing", async () => {
    const calls = await scanFiles(buildFixtureAccess(path.join(root, "barrel-missing")));
    assert.ok(Array.isArray(calls), "scanFiles must return an array even with broken barrels");
  });

  await run("A3.audit.wildcard-then-named: wildcard barrel followed by named re-export resolves `ask` via the second entry", async () => {
    const calls = await scanFiles(buildFixtureAccess(path.join(root, "barrel-wildcard-then-named")));
    const consumerCalls = calls.filter((c) => c.file.endsWith("consumer.ts"));
    const openaiCalls = consumerCalls.filter((c) => c.provider === "openai");
    assert.ok(openaiCalls.length >= 1, `multi-entry wildcard barrel failed: got ${openaiCalls.length} calls`);
  });
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
