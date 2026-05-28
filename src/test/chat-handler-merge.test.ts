import assert from "node:assert/strict";
import { collapseSuggestions } from "../scan-results";
import type { Suggestion } from "../analysis/types";

function run(name: string, fn: () => void): void {
  try { fn(); console.log(`PASS ${name}`); }
  catch (e) { console.error(`FAIL ${name}`); throw e; }
}

function sug(p: Partial<Suggestion>): Suggestion {
  return {
    id: p.id ?? "x", projectId: "p", scanId: "s", type: p.type ?? "n_plus_one",
    severity: p.severity ?? "low", affectedEndpoints: p.affectedEndpoints ?? ["ep1"],
    affectedFiles: p.affectedFiles ?? ["src/a.ts"], targetLine: p.targetLine ?? 10,
    estimatedMonthlySavings: 0, description: p.description ?? "d", codeFix: "",
    source: p.source, confidence: p.confidence ?? 0.5, evidence: [], sources: p.sources,
    costImpactUsd: p.costImpactUsd ?? null,
  };
}

run("#84: AI + local on the same endpoint collapse to one with both sources", () => {
  const local = sug({ id: "l", source: "local-rule", sources: ["local-rule"], confidence: 0.7 });
  const ai = sug({ id: "a", source: "ai", sources: ["ai"], confidence: 0.9, description: "richer ai desc" });
  const out = collapseSuggestions([local, ai]);
  assert.equal(out.length, 1);
  assert.deepEqual([...out[0].sources!].sort(), ["ai", "local-rule"]);
  assert.equal(out[0].confidence, 0.9);
});
