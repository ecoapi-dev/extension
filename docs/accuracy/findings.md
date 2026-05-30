# C. Finding Accuracy

Detection is finding *the call*. Findings are the *issues* we surface to the user — N+1, unbounded loops, missing cache guards, etc. These need to be calibrated, deduped properly, and carry honest confidence.

---

## C1. Calibrate the local waste detector

### Problem
`src/scanner/local-waste-detector.ts` produces findings for:
- N+1 patterns
- Unbounded loops
- Polling without backoff
- Missing cache guards
- Unbatched parallel calls

There is no measured false-positive rate for any of these. We have no idea if "unbounded loop" fires correctly 95% of the time or 60% of the time. Anecdotal user feedback is the only signal today.

### Target behavior
Each detector has a measured false-positive rate against the benchmark corpus (D1). Detectors with FPR > 30% are either:
1. Tightened (add an AST guard, raise the bar for detection), or
2. Downgraded in severity until the FPR drops, or
3. Removed entirely if no signal can be found.

### Investigation steps
1. Build a labeled set: take the benchmark corpus (D1), have a human (or careful manual review) label every finding produced by each waste detector as TP or FP.
2. Compute FPR per detector type.
3. For each detector with FPR > 30%, inspect the false positives. Common categories likely to show up:
   - "Unbounded loop": looping over a known-bounded `const` array or `Object.keys()` of a literal.
   - "Missing cache guard": cache exists but is in a separate function called inside the loop.
   - "Polling without backoff": single retry, not actual polling.
   - "N+1": parallelized with `Promise.all`, so it's a one-roundtrip pattern, not N+1.
4. Add the AST guard that distinguishes each.

### Acceptance criteria
- [ ] Each detector has a documented FPR in this file (table below).
- [ ] No detector has FPR > 30% in the calibrated state.
- [ ] FPR is re-measured on every benchmark CI run; regressions fail the build.
- [ ] False positives that remain are by-design (documented exceptions, e.g., "we choose to flag this conservatively because the cost of missing it is high").

### Calibration table (measured 2026-05-13 against corpus v1 — 7 fixtures, 3 expected findings; refreshed after C1 PR-3 merged; updated after Wave 4 / #117)

| Detector (scanner `type`) | TP | FP | FN | FPR | Precision | Severity (current) | Notes |
|---|---|---|---|---|---|---|---|
| `n_plus_one`           | 1 | 0 | 0 | 0%   | 100% | high    | Only detector with a corpus TP. Sample size = 1. |
| `cache`                | 0 | 0 | 0 | —    | —    | medium  | C1 PR-2 dropped emissions from 7 to 0 — Python detector now suppresses generative endpoints + explicit write-shaped HTTP methods, AST detector buckets fetch/axios redundancy by URL. No emissions, no expected entries; row collapses to absent in `findingMetricsByType`. |
| `batch`                | 0 | 0 | 1 | —    | 100% | medium  | C1 PR-3 bucketed sequential-batching detectors by `(provider, enclosingFunction)` + line-dedup. The prior bedrock FP (`bedrock-raw-fetch/src/index.ts:5`) is gone — live benchmark shows `batch` clean at 0 FP. The expected TP at `flask-mixed-providers/src/providers/anthropic_helper.py:11` is still missed (FN = 1, recall 0%). Wave 4 / #117 attempted a cross-function `(provider, methodChain)` batching pass to recover this FN, but it fired equally on structurally-identical sibling helpers (`openai_helper.py`, `cohere_helper.py`) that are unlabeled in `expected.json`, producing 6 FPs and dropping `batch` precision to 14.3%. Because no AST signal distinguishes the labeled-TP case from the unlabeled-but-equivalent cases, this is a **corpus-labeling inconsistency**: either the sibling helpers should also be labeled as batch findings, or the FN should be accepted as unrecoverable without cross-file call-graph signal. The cross-function pass was reverted. Tracked as a corpus follow-up, not a detector fix. |
| `unbatched_parallel`   | 1 | 0 | 0 | 0%   | 100% | derived | Wave 4 / #117 recovered the DALL-E `Promise.all(Array.from({length:n}).map(() => images.generate()))` FN. A dedicated `unbatched_parallel` SuggestionType was added; `detectInlineParallel` (AST) and `detectInlineParallelFinding` (regex fallback) now emit it. The `BOUNDED_REPLICATION` guard was removed from the inline-parallel path because `inlineParallelCapable` is the precision control. Severity is derived from the score-based `deriveSeverity()` pipeline (not hardcoded). AST + regex paths both emit it. |
| `rate_limit`           | 0 | 1 | 0 | 100% | 0%   | low     | One FP. No expected entries. |
| `concurrency_control`  | — | — | — | —    | —    | low     | Scanner emits nothing on the corpus; not in the table. |

**Wave 4 / #117 outcome (2026-05-29):** Two benchmark finding false-negatives were targeted. One shipped: the DALL-E `unbatched_parallel` FN is recovered — finding recall rose from 33.33% → 66.67%, precision held at 100%. One did not ship: the Python cross-function `batch` FN at `flask-mixed-providers/anthropic_helper.py:11` remains open. The attempted recovery pass produced 6 FPs on structurally-identical but unlabeled sibling helper files — a corpus-labeling inconsistency, not a detector gap. The pass was reverted; the `batch` row is now clean (0 FP, precision 100%) with recall 0%. Recommended corpus follow-up: either label `openai_helper.py` and `cohere_helper.py` as batch findings too, or formally accept this FN as unrecoverable without cross-file call-graph signal.

Acceptance criterion "no detector with FPR > 30%" passes for `n_plus_one` and `cache` after PR-2 and effectively passes for `batch` after PR-3 (sample size 1 below per-type gate threshold; remaining FP is borderline TP). Still fails for `rate_limit` (sample size 1). Sample sizes remain small (corpus v1 has 3 expected findings total), so the FPR numbers are diagnostic, not statistically robust. Wait until the corpus grows past N ≥ 10 expected findings per type before defending an "FPR < 30%" target as final.

### Measurement plumbing

These numbers come from the D1 benchmark gate. `benchmark/metrics.ts` computes per-type TP/FP/FN per fixture; `aggregate()` rolls them up; `benchmark/runner.ts` writes `findingMetricsByType` to `benchmark/baseline.json` on `--update-baseline`. CI fails on any per-type precision drop > 1pp where the sample size (TP+FP) is at least 3 on both the current run and the baseline — types with fewer emissions are skipped to avoid single-count noise.

The follow-up PRs (PR-2+ in the C1 plan, `docs/superpowers/plans/2026-05-13-c1-waste-detector-calibration.md`) tighten one detector at a time using the per-type gate to prove each change is a real improvement.

### Files
- `src/scanner/local-waste-detector.ts`
- `src/scanner/python-waste-detector.ts`
- `src/ast/waste/*` (specific detectors)

### Depends on
- D1 (need a benchmark to measure against).

---

## C2. Proper dedupe of AI + local-rule findings

### Problem
The same N+1 may be flagged twice:
1. By `local-waste-detector` (source: `local-rule`).
2. By the AI review pass (source: `remote`).

The two won't phrase the description the same way. Today `finding-dedupe.ts` has a `makeFindingDedupeKey` that includes `description` text in the dedupe key — so two findings about the same call with different wording survive as duplicates.

There is a richer `makeFindingContextDedupeKey` that buckets by line + provider + method + library + originFile + originFunction. That's better, but it's not the default and it's not obvious it's used at the AI-vs-local merge point.

### Target behavior
Findings from `remote` and `local-rule` that describe the *same underlying issue* at the *same location* dedupe to a single finding, preferring the higher-confidence source. The dedupe key is:

```ts
function findingMergeKey(f: FindingNode): string {
  return [
    f.filePath,
    f.type,                              // "n_plus_one", "unbounded_loop", etc.
    f.endpointId ?? "no-endpoint",       // stable ID from B3
    f.lineRange ?? lineFromSpan(f.span), // bucketed by call expression, not exact line
  ].join("::");
}
```

The `lineRange` bucket means "lines 12–18" matches "lines 14–16" (one is a superset). Implementation: round to 5-line buckets or use range overlap.

### Investigation steps
1. Find where AI findings and local findings are merged today (likely in `webview-provider.ts` after both arrive).
2. Audit which dedupe key is used at that merge point.
3. Replace with the structural key above.
4. When duplicates collapse, preserve the higher-confidence finding and append the other's source as metadata so the UI can show "detected by 2 sources."

### Acceptance criteria
- [x] Two findings of the same `type` on the same `endpointId` collapse to one.
- [x] The collapsed finding lists both sources (e.g., `sources: ["local-rule", "remote"]`).
- [x] Confidence of the collapsed finding is `max()` of inputs, not averaged.
- [x] Description picked: prefer the AI's (richer wording), fall back to local-rule's if no AI version exists.

### Landed (2026-05-28)
Implemented on the `Suggestion` pipeline, not the idealized `FindingNode` graph: the real AI-vs-local merge point is `chat-handler.ts:mergeAiSuggestions`, and the user-facing findings are `Suggestion[]`. A single `collapseSuggestions()` in `scan-results.ts` dedupes by `type :: file :: (endpointId | floor(line/5) bucket)`, unions `sources`, takes `max()` confidence/cost/savings, and prefers the highest-ranked source's description (ai > remote > local-rule). `mergeAiSuggestions` is now a thin wrapper over it (collapse, not drop); both scan builders apply it once. `sources` is mirrored onto `FindingNode` for graph parity. UI: a "detected by N sources" badge renders when `sources.length > 1` (interactive EDH check pending). Full benchmark Δ +0.00pp on all metrics.

### Files
- `src/scan-results.ts` (`collapseSuggestions`, applied at both builders)
- `src/webview/chat-handler.ts` (`mergeAiSuggestions` merge point)
- `src/analysis/types.ts` (`sources?`/`costImpactUsd?` on `Suggestion`) + `src/intelligence/types.ts` (`sources`/`costImpactUsd` on `FindingNode`)
- `webview/src/components/ResultsPage.tsx` + `webview/src/types.ts` (sources badge)

### Depends on
- B3 (stable endpoint IDs for the merge key).

---

## C3. Confidence as a first-class field; severity derived from signals

### Problem
Today:
- AI findings carry confidence (filtered by `eco.aiReview.minConfidence`).
- Local-rule findings have no confidence at all.
- Severity (`high` / `medium` / `low`) is hardcoded per detector in `local-waste-detector.ts` and ignores actual cost impact.

This means:
- A `high` severity finding on a `free` endpoint and a `high` severity finding on a `gpt-4o` polling loop look identical to the user, even though one is ~$0 and the other is ~$thousands.
- The user can't filter by confidence in the UI (only AI findings have it).
- The severity / confidence model can't be calibrated against benchmark data.

### Target behavior

**Every finding carries:**
```ts
interface FindingSignals {
  confidence: number;            // 0..1, how sure we are this is real
  costImpactUsd: number | null;  // estimated monthly $ saved if fixed (null if unknown)
  frequencyClass: FrequencyClass; // from AST
}
```

**Severity is derived, not authored:**
```ts
function deriveSeverity(s: FindingSignals): "high" | "medium" | "low" {
  const score = s.confidence * (s.costImpactUsd ?? 0);
  if (score >= 100) return "high";
  if (score >= 10)  return "medium";
  return "low";
}
```

(Tune thresholds against the benchmark — these are placeholders.)

This means an unbounded loop on a free endpoint (cost impact ≈ $0) automatically becomes low severity. A cache miss on a per-token call in a polling loop becomes high without anyone writing that rule.

### Investigation steps
1. Add `confidence: number` to every detector emission site. Local detectors start with a fixed value per type (0.9 for clear N+1, 0.6 for "unbounded loop" which has higher FPR — adjust based on C1 calibration).
2. Add `costImpactUsd` computation: estimated savings × confidence × frequency-class multiplier.
3. Replace hardcoded `severity` in each detector with a single `deriveSeverity()` call at the end of the pipeline.
4. Add UI controls: filter by confidence, sort by cost impact.

### Acceptance criteria
- [x] Every finding carries `confidence` and `costImpactUsd` (populated; `FindingNode` mirrors both, `costImpactUsd` null at graph-build time and resolved in the `Suggestion` layer where endpoint cost is known).
- [x] Severity is computed at one place from those signals (`deriveSeverity()` in `scan-results.ts`).
- [~] Filtering by confidence in the webview hides low-confidence findings (code-complete + builds/typechecks; interactive EDH check pending).
- [x] Two findings of the same type on different-cost endpoints get different severities (unit-tested).
- [~] Existing severity-based UI grouping still works (groups derive from the filtered set; interactive EDH check pending).

### Landed (2026-05-28) — Hybrid severity model
Severity is **not** the spec's literal `confidence × costImpactUsd`. That pure formula would zero-out free-endpoint risk and re-baseline the calibrated detectors. Instead `deriveSeverity({riskScore, confidence, costImpactUsd})` is a **hybrid floor + amplifier**: the C1-calibrated structural `riskScore` sets a floor (thresholds 5/3, matching `scoreToSeverity`) and a confidence-weighted cost term (thresholds 100/10) can only escalate via `Math.max`. This keeps free-endpoint structural risks visible, lets expensive endpoints rise, and is benchmark-safe — severity reassignment never adds or drops a finding, so per-type precision/recall is untouched (full benchmark Δ +0.00pp). `costImpactUsd` reuses the existing heuristic (`monthlyCost × FREQUENCY_CLASS_MULTIPLIERS`) and stays internal — it drives severity/ordering but is never rendered. Detectors carry a `riskScore`; severity is overridden at every `Suggestion`-construction site (incl. AI findings, whose self-reported severity maps to a riskScore floor).

### Files
- `src/scan-results.ts` (`deriveSeverity`, `computeCostImpact`, `SEVERITY_TO_RISK_SCORE`; applied at all construction sites)
- `src/scanner/local-waste-detector.ts` (+ python variant + `ast/waste/*`): emit `riskScore`
- `src/analysis/types.ts` / `src/intelligence/types.ts` (`costImpactUsd`)
- `webview/src/components/ResultsPage.tsx` + `webview/src/types.ts` (confidence filter)

### Depends on
- C1 (per-detector confidence values come from the calibration).
- D1 (benchmark for threshold tuning).

---
