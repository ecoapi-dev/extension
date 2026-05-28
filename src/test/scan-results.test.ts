import assert from "node:assert/strict";
import { deriveSeverity, computeCostImpact, buildRemoteScanResults } from "../scan-results";
import { buildLocalScanResults } from "../scan-results";
import type { ApiCallInput, EndpointRecord, ScanSummary } from "../analysis/types";
import type { LocalWasteFinding } from "../scanner/local-waste-detector";

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

run("deriveSeverity: exact threshold boundaries (>= semantics) hold", () => {
  // structural floor boundaries (cost zeroed out)
  assert.equal(deriveSeverity({ riskScore: 5, confidence: 0, costImpactUsd: 0 }), "high");
  assert.equal(deriveSeverity({ riskScore: 3, confidence: 0, costImpactUsd: 0 }), "medium");
  // cost amplifier boundaries (confidence=1 for clean arithmetic, structural floored)
  assert.equal(deriveSeverity({ riskScore: 1, confidence: 1.0, costImpactUsd: 100 }), "high");
  assert.equal(deriveSeverity({ riskScore: 1, confidence: 1.0, costImpactUsd: 10 }), "medium");
});

run("buildLocalScanResults: every suggestion has costImpactUsd defined and sources set", () => {
  const calls: ApiCallInput[] = [{
    file: "src/a.ts", line: 5, method: "POST", url: "https://api.openai.com/v1/chat/completions",
    library: "openai", provider: "openai", frequency: "per-request", frequencyClass: "unbounded-loop",
    methodSignature: "chat.completions.create", costModel: "per_token",
  }];
  const findings: LocalWasteFinding[] = [{
    id: "f1", type: "n_plus_one", severity: "low", riskScore: 6, confidence: 0.9,
    description: "loop-driven openai call", affectedFile: "src/a.ts", line: 5,
    evidence: ["Outbound call occurs inside a loop."],
  }];
  const { suggestions } = buildLocalScanResults(calls, findings, "proj", "scan");
  assert.ok(suggestions.length >= 1);
  for (const s of suggestions) {
    assert.ok(s.costImpactUsd !== undefined, "costImpactUsd must be populated (null allowed)");
    assert.ok(Array.isArray(s.sources) && s.sources.length >= 1, "sources must be set");
    assert.ok(["high", "medium", "low"].includes(s.severity));
  }
});

run("buildRemoteScanResults: aggressive suggestion from endpoint status is labeled local-rule with cost impact", () => {
  const endpoint: EndpointRecord = {
    id: "ep-cache", projectId: "p", scanId: "s", provider: "openai",
    method: "GET", url: "https://api.openai.com/v1/models", files: ["src/x.ts"],
    callSites: [{ file: "src/x.ts", line: 3, library: "openai", frequency: "per-request" }],
    callsPerDay: 100, monthlyCost: 45, status: "cacheable", frequencyClass: "polling",
  };
  const summary: ScanSummary = { totalEndpoints: 1, totalCallsPerDay: 100, totalMonthlyCost: 45, highRiskCount: 0 };
  const { suggestions } = buildRemoteScanResults([endpoint], [], summary, [], [], "p", "s");
  const aggressive = suggestions.find((sug) => sug.id.startsWith("local-"));
  assert.ok(aggressive, "expected an aggressive suggestion from the cacheable endpoint");
  assert.deepEqual(aggressive!.sources, ["local-rule"]);
  assert.ok(aggressive!.costImpactUsd !== undefined);
  assert.ok(["high", "medium", "low"].includes(aggressive!.severity));
});
