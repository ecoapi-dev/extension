import assert from "node:assert/strict";
import { deriveSeverity, computeCostImpact } from "../scan-results";

function run(name: string, fn: () => void): void {
  try { fn(); console.log(`PASS ${name}`); }
  catch (error) { console.error(`FAIL ${name}`); throw error; }
}

run("computeCostImpact amplifies by frequency class and rounds", () => {
  assert.equal(computeCostImpact(10, "polling"), 80);          // 10 * 8
  assert.equal(computeCostImpact(10, "unbounded-loop"), 100);  // 10 * 10
  assert.equal(computeCostImpact(10, undefined), 10);          // no class → 1x
  assert.equal(computeCostImpact(0, "polling"), null);         // no baseline → null
  assert.equal(computeCostImpact(10, "cache-guarded"), 1);     // 10 * 0.1
});

run("deriveSeverity keeps the structural floor when cost is ~0 (benchmark-safe)", () => {
  assert.equal(deriveSeverity({ riskScore: 6, confidence: 0.9, costImpactUsd: 0 }), "high");
  assert.equal(deriveSeverity({ riskScore: 4, confidence: 0.9, costImpactUsd: null }), "medium");
  assert.equal(deriveSeverity({ riskScore: 1, confidence: 0.9, costImpactUsd: 0 }), "low");
});

run("deriveSeverity escalates a cheap-structure finding on an expensive endpoint", () => {
  assert.equal(deriveSeverity({ riskScore: 1, confidence: 0.9, costImpactUsd: 200 }), "high");  // 0.9*200=180
  assert.equal(deriveSeverity({ riskScore: 1, confidence: 0.9, costImpactUsd: 20 }), "medium");  // 0.9*20=18
});

run("deriveSeverity: same type, different cost -> different severity (#85 acceptance)", () => {
  const cheap = deriveSeverity({ riskScore: 2, confidence: 0.8, costImpactUsd: 0 });
  const pricey = deriveSeverity({ riskScore: 2, confidence: 0.8, costImpactUsd: 500 });
  assert.notEqual(cheap, pricey);
});
