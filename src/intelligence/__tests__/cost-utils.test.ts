import assert from "node:assert/strict";
import { estimateLocalMonthlyCost } from "../cost-utils";

async function runTests() {
  // Null-safety contract
  assert.equal(estimateLocalMonthlyCost("", 100), null);
  assert.equal(estimateLocalMonthlyCost("unknown", 100), null);
  assert.equal(estimateLocalMonthlyCost("nonexistent-provider", 100), null);
  assert.equal(estimateLocalMonthlyCost("openai", NaN), null);
  assert.equal(estimateLocalMonthlyCost("openai", -5), null);

  // Zero calls -> zero for a known provider
  assert.equal(estimateLocalMonthlyCost("openai", 0), 0);

  // Known table provider produces positive cost
  const stripe = estimateLocalMonthlyCost("stripe", 100);
  assert.ok(stripe !== null && stripe > 0, `expected positive cost, got ${stripe}`);

  // Method-fingerprint path returns non-null when the method is registered.
  // "chat.completions.create" exists in src/scanner/fingerprints/openai.json.
  const openaiChat = estimateLocalMonthlyCost("openai", 1000, "chat.completions.create");
  assert.ok(openaiChat !== null, "fingerprint path should return a number for a known method");

  console.log("PASS cost-utils");
}

runTests().catch((e) => { console.error(e); process.exit(1); });
