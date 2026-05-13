import assert from "node:assert/strict";
import { pointSpan, spanFromMatch } from "../scanner/source-span";

async function run(name: string, fn: () => Promise<void> | void): Promise<void> {
  try { await fn(); console.log(`PASS ${name}`); }
  catch (err) { console.error(`FAIL ${name}`); throw err; }
}

(async () => {
  await run("pointSpan: zero-width at line/col", () => {
    const s = pointSpan(5, 12);
    assert.deepEqual(s, { startLine: 5, startColumn: 12, endLine: 5, endColumn: 12 });
  });

  await run("spanFromMatch: single-line match", () => {
    const s = spanFromMatch(10, 4, `fetch("https://x")`);
    assert.equal(s.startLine, 10);
    assert.equal(s.startColumn, 4);
    assert.equal(s.endLine, 10);
    assert.equal(s.endColumn, 4 + `fetch("https://x")`.length);
  });

  await run("spanFromMatch: multi-line match", () => {
    const s = spanFromMatch(7, 0, `fetch(\n  "u",\n  { method: "POST" }\n)`);
    assert.equal(s.startLine, 7);
    assert.equal(s.endLine, 10);
    // The character after the last newline is `)`, so endColumn = 1 (one char on that line).
    assert.equal(s.endColumn, 1);
  });

  console.log("source-span.test PASSED");
})().catch((err) => { console.error(err); process.exit(1); });
