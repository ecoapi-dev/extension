import assert from "node:assert/strict";
import { deriveSeverity, computeCostImpact, buildRemoteScanResults, collapseSuggestions } from "../scan-results";
import { buildLocalScanResults } from "../scan-results";
import type { ApiCallInput, EndpointRecord, ScanSummary } from "../analysis/types";
import type { Suggestion } from "../analysis/types";
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

function sug(p: Partial<Suggestion>): Suggestion {
  return {
    id: p.id ?? "x", projectId: "p", scanId: "s",
    type: p.type ?? "n_plus_one", severity: p.severity ?? "low",
    affectedEndpoints: p.affectedEndpoints ?? [], affectedFiles: p.affectedFiles ?? ["src/a.ts"],
    targetLine: p.targetLine, estimatedMonthlySavings: p.estimatedMonthlySavings ?? 0,
    description: p.description ?? "d", codeFix: "", source: p.source, confidence: p.confidence,
    evidence: p.evidence ?? [], sources: p.sources, costImpactUsd: p.costImpactUsd ?? null,
  };
}

run("collapseSuggestions: same type+endpoint collapses, unions sources, max confidence, prefers AI desc", () => {
  const local = sug({ id: "l", type: "n_plus_one", affectedEndpoints: ["ep1"], confidence: 0.7,
    description: "loop call", source: "local-rule", sources: ["local-rule"], severity: "medium" });
  const ai = sug({ id: "a", type: "n_plus_one", affectedEndpoints: ["ep1"], confidence: 0.9,
    description: "N+1: this fetch runs once per user in the loop", source: "ai", sources: ["ai"], severity: "low" });
  const out = collapseSuggestions([local, ai]);
  assert.equal(out.length, 1);
  assert.deepEqual([...out[0].sources!].sort(), ["ai", "local-rule"]);
  assert.equal(out[0].confidence, 0.9);
  assert.match(out[0].description, /N\+1/);
});

run("collapseSuggestions: different endpoints do not collapse", () => {
  const a = sug({ id: "a", affectedEndpoints: ["ep1"] });
  const b = sug({ id: "b", affectedEndpoints: ["ep2"] });
  assert.equal(collapseSuggestions([a, b]).length, 2);
});

run("collapseSuggestions: no endpoint -> 5-line bucket collapses nearby same-type findings", () => {
  const a = sug({ id: "a", affectedEndpoints: [], targetLine: 12, sources: ["local-rule"] });
  const b = sug({ id: "b", affectedEndpoints: [], targetLine: 14, sources: ["ai"], description: "richer", source: "ai" });
  const out = collapseSuggestions([a, b]);
  assert.equal(out.length, 1);
  assert.deepEqual([...out[0].sources!].sort(), ["ai", "local-rule"]);
});

run("buildLocalScanResults collapses a local finding that duplicates an aggressive one", () => {
  const calls: ApiCallInput[] = [{
    file: "src/b.ts", line: 8, method: "GET", url: "https://api.openai.com/v1/models",
    library: "openai", provider: "openai", frequency: "per-request", frequencyClass: "polling",
  }];
  const findings: LocalWasteFinding[] = [{
    id: "f1", type: "n_plus_one", severity: "medium", riskScore: 4, confidence: 0.8,
    description: "dup", affectedFile: "src/b.ts", line: 8, evidence: [],
  }];
  const { suggestions } = buildLocalScanResults(calls, findings, "p", "s");
  const nplus = suggestions.filter((s) => s.type === "n_plus_one" && s.affectedFiles[0] === "src/b.ts");
  assert.ok(nplus.length <= 1, "duplicate n_plus_one on same endpoint should collapse");
});
