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
  const root = path.resolve(projectRoot, "src", "test", "fixtures", "a5");

  await run("A5.audit.bind: `.bind()`-aliased method ref resolves to openai", async () => {
    const calls = await scanFiles(buildFixtureAccess(path.join(root, "bind-aliased")));
    const consumerCalls = calls.filter((c) => c.file.endsWith("consumer.ts"));
    const openaiCalls = consumerCalls.filter((c) => c.provider === "openai");
    assert.ok(openaiCalls.length >= 1, `bind alias failed: got ${openaiCalls.length} calls`);
  });

  await run("A5.audit.factory: cross-file factory `makeClient()` return resolves to openai", async () => {
    const calls = await scanFiles(buildFixtureAccess(path.join(root, "factory-direct")));
    const consumerCalls = calls.filter((c) => c.file.endsWith("consumer.ts"));
    const openaiCalls = consumerCalls.filter((c) => c.provider === "openai");
    assert.ok(openaiCalls.length >= 1, `factory return failed: got ${openaiCalls.length} calls`);
  });

  await run("A5.audit.di: typed constructor param `private ai: OpenAI` resolves `this.ai.method()` to openai", async () => {
    const calls = await scanFiles(buildFixtureAccess(path.join(root, "di-constructor")));
    const consumerCalls = calls.filter((c) => c.file.endsWith("consumer.ts"));
    const openaiCalls = consumerCalls.filter((c) => c.provider === "openai");
    assert.ok(openaiCalls.length >= 1, `DI constructor failed: got ${openaiCalls.length} calls`);
  });

  await run("A5.regress: simple `const c = new OpenAI(); c.method()` still resolves (no regression from A5 changes)", async () => {
    const tmpDir = path.join(root, "_simple-regression");
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, "consumer.ts"),
      [
        'import OpenAI from "openai";',
        "",
        "const client = new OpenAI();",
        "",
        "export async function ask(p: string): Promise<string> {",
        "  const r = await client.chat.completions.create({",
        '    model: "gpt-4o-mini",',
        '    messages: [{ role: "user", content: p }],',
        "  });",
        '  return r.choices[0].message.content ?? "";',
        "}",
        "",
      ].join("\n")
    );
    try {
      const calls = await scanFiles(buildFixtureAccess(tmpDir));
      const consumerCalls = calls.filter((c) => c.file.endsWith("consumer.ts"));
      assert.ok(
        consumerCalls.some((c) => c.provider === "openai"),
        "simple new OpenAI() must still resolve"
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
  await run("A5.regress.factory-nested: factory with nested helper functions still resolves to outer return type", async () => {
    const calls = await scanFiles(buildFixtureAccess(path.join(root, "factory-nested")));
    const consumerCalls = calls.filter((c) => c.file.endsWith("consumer.ts"));
    const openaiCalls = consumerCalls.filter((c) => c.provider === "openai");
    const anthropicCalls = consumerCalls.filter((c) => c.provider === "anthropic");
    assert.ok(openaiCalls.length >= 1, `expected openai attribution from factory's outer return, got ${openaiCalls.length} openai + ${anthropicCalls.length} anthropic`);
    assert.equal(anthropicCalls.length, 0, `nested helper's Anthropic must not pollute factory attribution; got ${anthropicCalls.length}`);
  });
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
