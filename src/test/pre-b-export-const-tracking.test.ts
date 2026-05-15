/**
 * Pre-B: AST scanner must track `export const x = new Sdk()` declarations.
 *
 * Empirical regression: `export const apiClient = new OpenAI()` was not tracked
 * by varMap because the variable-tracking pass only matched bare `lexical_declaration`
 * nodes — missing the `export_statement` wrapper that Tree-sitter inserts for
 * exported declarations.
 */
import assert from "node:assert/strict";
import * as path from "node:path";
import * as fs from "node:fs";
import { setWasmDir } from "../ast/parser-loader";
import { scanFileWithAst } from "../ast/ast-scanner";

const WASM_DIR = path.join(__dirname, "..", "..", "assets", "parsers");
setWasmDir(WASM_DIR);

async function run(name: string, fn: () => void | Promise<void>): Promise<void> {
  try { await fn(); console.log(`PASS ${name}`); }
  catch (err) { console.error(`FAIL ${name}`); throw err; }
}

(async () => {
  const projectRoot = path.resolve(__dirname, "..", "..");
  const fixtureDir = path.resolve(projectRoot, "src", "test", "fixtures", "pre-b");
  fs.mkdirSync(fixtureDir, { recursive: true });

  // ── Fixture 1: export const client = new OpenAI() ────────────────────────────
  const fp1 = path.join(fixtureDir, "exported-client.ts");
  fs.writeFileSync(fp1, [
    'import OpenAI from "openai";',
    '',
    'export const apiClient = new OpenAI();',
    '',
    'export async function ask(prompt: string): Promise<string> {',
    '  const r = await apiClient.chat.completions.create({',
    '    model: "gpt-4o-mini",',
    '    messages: [{ role: "user", content: prompt }],',
    '  });',
    '  return r.choices[0].message.content ?? "";',
    '}',
    ''
  ].join("\n"));

  await run("Pre-B: AST scanner tracks `export const x = new OpenAI()` and resolves x.method() to openai", async () => {
    const result = await scanFileWithAst(fp1, async (p) => fs.readFileSync(p, "utf-8"));
    const openaiMatches = result.matches.filter((m) => m.provider === "openai");
    assert.ok(
      openaiMatches.length >= 1,
      `expected >=1 openai match in exported-client.ts, got ${openaiMatches.length}: ${JSON.stringify(result.matches.map((m) => ({ line: m.line, provider: m.provider, methodChain: m.methodChain })))}`
    );
  });

  // ── Fixture 2: plain const should still work (regression guard) ───────────────
  const fp2 = path.join(fixtureDir, "plain-client.ts");
  fs.writeFileSync(fp2, [
    'import OpenAI from "openai";',
    '',
    'const apiClient = new OpenAI();',
    '',
    'export async function ask(prompt: string): Promise<string> {',
    '  const r = await apiClient.chat.completions.create({',
    '    model: "gpt-4o-mini",',
    '    messages: [{ role: "user", content: prompt }],',
    '  });',
    '  return r.choices[0].message.content ?? "";',
    '}',
    ''
  ].join("\n"));

  await run("Pre-B (regression): plain `const x = new OpenAI()` still resolves to openai", async () => {
    const result = await scanFileWithAst(fp2, async (p) => fs.readFileSync(p, "utf-8"));
    const openaiMatches = result.matches.filter((m) => m.provider === "openai");
    assert.ok(
      openaiMatches.length >= 1,
      `expected >=1 openai match in plain-client.ts, got ${openaiMatches.length}: ${JSON.stringify(result.matches.map((m) => ({ line: m.line, provider: m.provider, methodChain: m.methodChain })))}`
    );
  });

  // ── Fixture 3: export const with Anthropic SDK ────────────────────────────────
  const fp3 = path.join(fixtureDir, "exported-anthropic.ts");
  fs.writeFileSync(fp3, [
    'import Anthropic from "@anthropic-ai/sdk";',
    '',
    'export const client = new Anthropic();',
    '',
    'export async function chat(text: string) {',
    '  return client.messages.create({',
    '    model: "claude-opus-4-5",',
    '    max_tokens: 1024,',
    '    messages: [{ role: "user", content: text }],',
    '  });',
    '}',
    ''
  ].join("\n"));

  await run("Pre-B: AST scanner tracks `export const x = new Anthropic()` and resolves to anthropic", async () => {
    const result = await scanFileWithAst(fp3, async (p) => fs.readFileSync(p, "utf-8"));
    const anthropicMatches = result.matches.filter((m) => m.provider === "anthropic");
    assert.ok(
      anthropicMatches.length >= 1,
      `expected >=1 anthropic match in exported-anthropic.ts, got ${anthropicMatches.length}: ${JSON.stringify(result.matches.map((m) => ({ line: m.line, provider: m.provider, methodChain: m.methodChain })))}`
    );
  });

})().catch((err) => { console.error(err); process.exit(1); });
