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

### Calibration table (measured 2026-05-13 against corpus v1 — 7 fixtures, 3 expected findings)

| Detector (scanner `type`) | TP | FP | FN | FPR | Precision | Severity (current) | Notes |
|---|---|---|---|---|---|---|---|
| `n_plus_one`           | 1 | 0 | 0 | 0%   | 100% | high   | Only detector with a corpus TP. Sample size = 1. |
| `cache`                | 0 | 7 | 0 | 100% | 0%   | medium | All 7 emissions are FPs against this corpus. No expected `cache` findings yet. |
| `batch`                | 0 | 7 | 1 | 100% | 0%   | medium | All 7 emissions are FPs; the one expected `batch` finding (flask-mixed-providers) is missed. |
| `rate_limit`           | 0 | 1 | 0 | 100% | 0%   | low    | One FP. No expected entries. |
| `concurrency_control`  | — | — | — | —    | —    | low    | Scanner emits nothing on the corpus; not in the table. See "Type-name mismatch" below. |

The corpus labels one fan-out finding as `unbatched_parallel`; the scanner emits `concurrency_control` for the same pattern. The matcher compares type strings exactly, so the expected `unbatched_parallel` shows up as a recall miss (FN = 1) and the scanner's `concurrency_control` (if it were ever emitted on this corpus) would show up as a separate row of FPs. As of 2026-05-13 the scanner emits zero `concurrency_control` findings on the corpus, so only the FN side appears. The label gap is tracked as a corpus follow-up — either rename the expected type to `concurrency_control` or have the scanner emit `unbatched_parallel` for this specific pattern.

Acceptance criterion "no detector with FPR > 30%" currently fails for `cache`, `batch`, and `rate_limit`. Sample sizes are small (corpus v1 has 3 expected findings total), so the FPR numbers are diagnostic, not statistically robust. Treat them as ordering signal for the follow-up PRs: tighten `cache` and `batch` first (each 7 FPs), then `rate_limit`. Wait until the corpus grows past N ≥ 10 expected findings per type before defending an "FPR < 30%" target as final.

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
- [ ] Two findings of the same `type` on the same `endpointId` collapse to one.
- [ ] The collapsed finding lists both sources (e.g., `sources: ["local-rule", "remote"]`).
- [ ] Confidence of the collapsed finding is `max()` of inputs, not averaged.
- [ ] Description picked: prefer the AI's (richer wording), fall back to local-rule's if no AI version exists.

### Files
- `src/intelligence/finding-dedupe.ts`
- `src/webview-provider.ts` (merge point)
- `src/intelligence/types.ts` (add `sources: string[]` to FindingNode)

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
- [ ] Every `FindingNode` has `confidence` and `costImpactUsd` populated.
- [ ] Severity is computed at one place from those signals.
- [ ] Filtering by confidence in the webview hides low-confidence findings.
- [ ] Two findings of the same type on different-cost endpoints get different severities.
- [ ] Existing severity-based UI grouping still works (groups derived from new computation).

### Files
- `src/scanner/local-waste-detector.ts` (and python variant + ast/waste/*)
- `src/intelligence/types.ts` (FindingNode shape)
- `webview/src/components/ResultsPage.tsx` (filter UI)
- `src/webview-provider.ts` (severity computation)

### Depends on
- C1 (per-detector confidence values come from the calibration).
- D1 (benchmark for threshold tuning).

---
