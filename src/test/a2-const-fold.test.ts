import assert from "node:assert/strict";
import { foldStringConstants } from "../scanner/constant-fold";

async function run(name: string, fn: () => void | Promise<void>): Promise<void> {
  try { await fn(); console.log(`PASS ${name}`); }
  catch (err) { console.error(`FAIL ${name}`); throw err; }
}

(async () => {
  await run("resolves a simple const string", () => {
    const src = `const BASE = "https://api.openai.com";\nfetch(\`\${BASE}/v1/chat\`);`;
    const folded = foldStringConstants("`${BASE}/v1/chat`", src);
    assert.equal(folded, "https://api.openai.com/v1/chat");
  });

  await run("resolves with let or var", () => {
    const src = `let BASE = "https://api.x.ai";\nfetch(\`\${BASE}/path\`);`;
    const folded = foldStringConstants("`${BASE}/path`", src);
    assert.equal(folded, "https://api.x.ai/path");
  });

  await run("returns null for runtime-dependent interpolation", () => {
    const src = `fetch(\`/users/\${req.params.id}\`);`;
    const folded = foldStringConstants("`/users/${req.params.id}`", src);
    assert.equal(folded, null);
  });

  await run("returns null when const is shadowed (multiple defs)", () => {
    const src = `const BASE = "https://a.com"; const BASE = "https://b.com";\nfetch(\`\${BASE}/x\`);`;
    const folded = foldStringConstants("`${BASE}/x`", src);
    assert.equal(folded, null);
  });

  await run("resolves identifier-only fetch arg", () => {
    const src = `const URL = "https://api.openai.com/v1/chat";\nfetch(URL);`;
    const folded = foldStringConstants("URL", src);
    assert.equal(folded, "https://api.openai.com/v1/chat");
  });

  await run("resolves multiple interpolations", () => {
    const src = `const HOST = "https://api.openai.com";\nconst VER = "v1";\nfetch(\`\${HOST}/\${VER}/chat\`);`;
    const folded = foldStringConstants("`${HOST}/${VER}/chat`", src);
    assert.equal(folded, "https://api.openai.com/v1/chat");
  });

  await run("returns null when one interpolation is non-const", () => {
    const src = `const HOST = "https://api.openai.com";\nfetch(\`\${HOST}/\${req.path}\`);`;
    const folded = foldStringConstants("`${HOST}/${req.path}`", src);
    assert.equal(folded, null);
  });

  await run("passes through plain quoted strings unchanged", () => {
    const folded = foldStringConstants(`"https://api.openai.com/v1/chat"`, "");
    assert.equal(folded, "https://api.openai.com/v1/chat");
  });
})().catch((err) => { console.error(err); process.exit(1); });
