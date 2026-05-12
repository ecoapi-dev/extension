import assert from "node:assert/strict";
import * as path from "path";
import { parseFile, setWasmDir } from "../ast/parser-loader";
import { extractCalls } from "../ast/call-visitor";
import { enclosingFunctionName } from "../ast/enclosing-function";

const WASM_DIR = path.join(__dirname, "..", "..", "assets", "parsers");
setWasmDir(WASM_DIR);

async function run(name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); console.log(`PASS ${name}`); }
  catch (err) { console.error(`FAIL ${name}`); throw err; }
}

async function nameFor(src: string, chain: string, lang = "typescript"): Promise<string | null> {
  const tree = await parseFile(src, lang);
  if (!tree) throw new Error("parse failed");
  const call = extractCalls(tree).find((c) => c.methodChain === chain);
  if (!call) throw new Error(`call ${chain} not found`);
  return enclosingFunctionName(call.node);
}

(async () => {
  await run("function declaration", async () => {
    const n = await nameFor(
      `function answerQuestion(q: string) { return openai.chat.completions.create({}); }`,
      "openai.chat.completions.create"
    );
    assert.equal(n, "answerQuestion");
  });

  await run("class method", async () => {
    const n = await nameFor(
      `class Svc { async ask(q: string) { return openai.chat.completions.create({}); } }`,
      "openai.chat.completions.create"
    );
    assert.equal(n, "ask");
  });

  await run("arrow function assigned to const", async () => {
    const n = await nameFor(
      `const handler = async () => { await openai.chat.completions.create({}); };`,
      "openai.chat.completions.create"
    );
    assert.equal(n, "handler");
  });

  await run("top-level call → null", async () => {
    const n = await nameFor(
      `openai.chat.completions.create({});`,
      "openai.chat.completions.create"
    );
    assert.equal(n, null);
  });

  await run("python def", async () => {
    const n = await nameFor(
      `def ask(q):\n    return openai.chat.completions.create()\n`,
      "openai.chat.completions.create",
      "python"
    );
    assert.equal(n, "ask");
  });

  console.log("enclosing-function.test PASSED");
})().catch((err) => { console.error(err); process.exit(1); });
