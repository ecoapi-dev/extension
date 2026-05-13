# C1 — Waste Detector Calibration (per-detector measurement infrastructure)

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` to implement this plan task-by-task. PR-1 (this plan) wires per-detector-type FPR measurement into the D1 gate. PR-2+ (later sessions) tighten worst-offender detectors based on measurements.

**Goal:** Extend the D1 benchmark gate so that finding precision is measured **per detector type** (not just globally) and per-type regressions fail CI. Document baseline per-detector FPRs in `docs/accuracy/findings.md`. This unblocks subsequent PRs that tighten individual detectors.

**Why:** Today `findingPrecision` is a single global number (6.25% on main). One worst-offender detector can hide behind a marginally-better one. We can't say "no detector has FPR > 30%" without per-type numbers. Issue #83 requires per-detector calibration.

**Scope (PR-1 only):**
- Per-detector-type TP/FP/FN counts in `MetricsReport`.
- Per-detector entries in `benchmark/baseline.json`.
- Per-detector regression gate (only fires on types with sufficient sample size).
- Console + markdown report shows per-type breakdown.
- One-line documentation of measured FPRs in `docs/accuracy/findings.md`.

**Out of scope (PR-2+):**
- Tightening individual detector logic (`src/scanner/local-waste-detector.ts` etc.).
- Severity downgrades.
- Confidence calibration.

---

## Current measured baseline (main, 2026-05-13)

| Metric | Value |
|---|---|
| Detection precision | 36.26% |
| Detection recall | 48.53% |
| Provider attribution accuracy | 82.14% |
| Finding precision | 6.25% |
| Finding recall | 33.33% |

Per-type baseline numbers are unknown until this PR runs.

**Corpus shape (read from `expected.json` files):**
- Expected findings across 7 fixtures: 3 total — `n_plus_one` (×1, flask-mixed-providers), `batch` (×1, flask-mixed-providers), `unbatched_parallel` (×1, langchain-openai).
- Scanner emits these SuggestionTypes: `cache`, `batch`, `redundancy`, `n_plus_one`, `rate_limit`, `concurrency_control` (from `src/analysis/types.ts`).
- Note: scanner emits `concurrency_control` for fan-out problems; corpus uses `unbatched_parallel`. These should be treated as either the same type or kept distinct depending on what the metric already does.

---

## Files relevant

- `benchmark/metrics.ts` — `computeMetrics`, `aggregate`, `MetricsReport`, `PerFixtureMetrics` types
- `benchmark/runner.ts` — `--update-baseline` writer, baseline loader, `computeDrops` gate
- `benchmark/report.ts` — `formatConsoleReport`, `formatMarkdownReport`
- `benchmark/baseline.json` — current 5 top-level numbers, add new `findingPrecisionByType` map
- `src/test/benchmark-metrics.test.ts` — tests for `computeMetrics`/`aggregate`; add per-type cases
- `docs/accuracy/findings.md` — calibration table is empty placeholder; fill it in

---

## Naming decision: "precision" vs "FPR"

Issue #83 uses "FPR > 30%" (false-positive rate). In our setting (no true negatives in the corpus), this is `FP / (TP + FP) = 1 - precision` among emitted findings. To keep code consistent with existing `findingPrecision`, this PR stores **precision per type** in the schema. The docs translate to FPR for the issue's acceptance criterion: "FPR > 30%" ≡ "precision < 70%".

---

## Schema additions

```ts
// benchmark/metrics.ts
export interface PerTypeCounts {
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  precision: number;      // TP / (TP+FP); 1 if denominator is 0
  recall: number;         // TP / (TP+FN); 1 if denominator is 0
}

// Added to PerFixtureMetrics:
findingCountsByType: Record<string, { truePositives: number; falsePositives: number; falseNegatives: number; }>;

// Added to MetricsReport:
findingMetricsByType: Record<string, PerTypeCounts>;
```

```json
// benchmark/baseline.json
{
  "detectionPrecision": 0.3626373626373626,
  "detectionRecall": 0.4852941176470588,
  "providerAttributionAccuracy": 0.8214285714285714,
  "findingPrecision": 0.0625,
  "findingRecall": 0.3333333333333333,
  "findingMetricsByType": {
    "n_plus_one":          { "truePositives": 1, "falsePositives": 3, "falseNegatives": 0, "precision": 0.25, "recall": 1.0 },
    "cache":               { "truePositives": 0, "falsePositives": 4, "falseNegatives": 0, "precision": 0.0,  "recall": 1.0 },
    "...":                 { "...": "..." }
  }
}
```

Numbers above are illustrative — actual values come from measurement in Task C1.2.

---

## Per-detector regression gate

Adds to `computeDrops` in `benchmark/runner.ts`:

1. For each `type` present in **both** `baseline.findingMetricsByType` and `current.findingMetricsByType`, compute `precisionDelta`.
2. Skip when sample size is too small to be meaningful: require `current.truePositives + current.falsePositives >= 3` AND `baseline.truePositives + baseline.falsePositives >= 3`. Reasoning: with the v1 corpus emitting only a handful of findings per type, single-count noise would otherwise dominate the gate.
3. Fail when `precisionDelta < -thresholdPp` (reuse the existing `--threshold` flag).
4. Emit a clear failure message: `"  - findings[n_plus_one].precision: 25.0% → 18.0% (Δ -7.00pp)"`.

New types appearing in `current` but absent in `baseline` do NOT fail the gate (additive). New types appearing in `baseline` but absent in `current` (i.e. the detector stopped emitting that type entirely) do NOT fail either — better to suppress than to keep noise.

---

## Tasks

### Task C1.1 — Per-type metrics in `metrics.ts` (TDD)

**Files:**
- Modify: `benchmark/metrics.ts`
- Modify: `src/test/benchmark-metrics.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `src/test/benchmark-metrics.test.ts` (inside the IIFE before `process.exit`):

```ts
await run("per-type counts: each finding type tracked separately", () => {
  const expected = expectedFixture(
    [],
    [
      { file: "a.ts", line: 10, type: "n_plus_one", is_true_positive: true },
      { file: "a.ts", line: 20, type: "cache",      is_true_positive: true },
    ],
  );
  const detectedFindings: DetectedFinding[] = [
    { file: "a.ts", line: 10, type: "n_plus_one" },           // TP
    { file: "a.ts", line: 99, type: "n_plus_one" },           // FP
    { file: "a.ts", line: 20, type: "cache" },                // TP
    { file: "b.ts", line: 7,  type: "unbounded_loop" },       // FP (type not in expected)
  ];
  const m = computeMetrics(expected, [], detectedFindings);
  assert.equal(m.findingCountsByType.n_plus_one.truePositives, 1);
  assert.equal(m.findingCountsByType.n_plus_one.falsePositives, 1);
  assert.equal(m.findingCountsByType.cache.truePositives, 1);
  assert.equal(m.findingCountsByType.cache.falsePositives, 0);
  assert.equal(m.findingCountsByType.unbounded_loop.truePositives, 0);
  assert.equal(m.findingCountsByType.unbounded_loop.falsePositives, 1);
});

await run("per-type counts: false negative counted by expected.type", () => {
  const expected = expectedFixture(
    [],
    [{ file: "a.ts", line: 10, type: "n_plus_one", is_true_positive: true }],
  );
  const m = computeMetrics(expected, [], []);
  assert.equal(m.findingCountsByType.n_plus_one.falseNegatives, 1);
  assert.equal(m.findingCountsByType.n_plus_one.truePositives, 0);
});

await run("aggregate computes per-type precision and recall correctly", () => {
  const { aggregate } = await import("../../benchmark/metrics");
  const perFixture = [
    {
      fixtureSlug: "f1",
      detectionPrecision: 1, detectionRecall: 1, providerAttributionAccuracy: 1,
      findingPrecision: 1, findingRecall: 1,
      truePositiveEndpoints: 0, falsePositiveEndpoints: 0, falseNegativeEndpoints: 0,
      truePositiveFindings: 1, falsePositiveFindings: 1, falseNegativeFindings: 0,
      providerAttributionTotal: 0, providerAttributionCorrect: 0,
      findingCountsByType: {
        n_plus_one: { truePositives: 1, falsePositives: 0, falseNegatives: 0 },
        cache:      { truePositives: 0, falsePositives: 1, falseNegatives: 0 },
      },
    },
    {
      fixtureSlug: "f2",
      detectionPrecision: 1, detectionRecall: 1, providerAttributionAccuracy: 1,
      findingPrecision: 1, findingRecall: 1,
      truePositiveEndpoints: 0, falsePositiveEndpoints: 0, falseNegativeEndpoints: 0,
      truePositiveFindings: 0, falsePositiveFindings: 1, falseNegativeFindings: 1,
      providerAttributionTotal: 0, providerAttributionCorrect: 0,
      findingCountsByType: {
        n_plus_one: { truePositives: 0, falsePositives: 1, falseNegatives: 1 },
      },
    },
  ];
  const report = aggregate(perFixture);
  assert.equal(report.findingMetricsByType.n_plus_one.truePositives, 1);
  assert.equal(report.findingMetricsByType.n_plus_one.falsePositives, 1);
  assert.equal(report.findingMetricsByType.n_plus_one.falseNegatives, 1);
  // precision = 1/2 = 0.5
  assert.equal(report.findingMetricsByType.n_plus_one.precision, 0.5);
  // recall = 1/2 = 0.5
  assert.equal(report.findingMetricsByType.n_plus_one.recall, 0.5);
  // cache: 0 TP, 1 FP, 0 FN → precision 0, recall 1 (denominator zero)
  assert.equal(report.findingMetricsByType.cache.precision, 0);
  assert.equal(report.findingMetricsByType.cache.recall, 1);
});

await run("empty per-type counts: no types observed yields empty record", () => {
  const m = computeMetrics(expectedFixture([], []), [], []);
  assert.deepEqual(m.findingCountsByType, {});
});
```

- [ ] **Step 2: Implement in `benchmark/metrics.ts`**

Extend `PerFixtureMetrics` and `MetricsReport` with the new fields. In `computeMetrics`:

1. Build a set of all observed types from both `expected.findings` and `detectedFindings`.
2. For each type, count TP/FP/FN scoped to that type using the same line-tolerance matching already in `matchPairs` (segregated by type).
3. Build the `findingCountsByType` record.

In `aggregate`:

1. Union all types across `perFixture` entries.
2. Sum TP/FP/FN per type.
3. Compute `precision` and `recall` using the existing `safeRatio` (1 when denominator is 0).
4. Populate `findingMetricsByType`.

Keep existing global `findingPrecision`/`findingRecall` untouched — sum of all TP / sum of all (TP+FP). Just add the new fields alongside.

- [ ] **Step 3: Run tests**

```bash
cd /home/andresl/Projects/recost/extension-c1
npm test 2>&1 | grep -E "(PASS|FAIL).*(per-type|aggregate computes per-type|empty per-type)"
```

All 4 new test cases PASS. Existing tests still pass (run full `npm test`).

---

### Task C1.2 — Wire per-type into baseline + runner + report

**Files:**
- Modify: `benchmark/runner.ts` — read/write per-type from baseline, extend `computeDrops`
- Modify: `benchmark/report.ts` — render per-type table in console + markdown
- Modify: `benchmark/baseline.json` — re-generate with measured per-type numbers

- [ ] **Step 1: Update baseline writer in `runner.ts`**

In the `args.updateBaseline` branch (lines ~199-209), include the new `findingMetricsByType` field in the JSON written. Strip the inner `precision`/`recall` fields if you want a smaller diff — or keep them so the file is self-documenting. Recommendation: keep them (the file is checked into git, readability matters more than file size).

- [ ] **Step 2: Update baseline reader**

In the `fs.existsSync(args.baselinePath)` branch (lines ~213-216), accept the new field. Fall back to empty `{}` when absent — backwards compat for any pre-PR baseline.

```ts
const raw = JSON.parse(fs.readFileSync(args.baselinePath, "utf8"));
baseline = {
  ...raw,
  findingMetricsByType: raw.findingMetricsByType ?? {},
  perFixture: [],
};
```

- [ ] **Step 3: Extend `computeDrops`**

Add per-type drop computation per the gate logic above (skip when sample size < 3; fire on `precision` deltas only — recall regressions are usually tied to the detector type going silent, which we explicitly don't fail on). Test by hand-rolling a baseline with `n_plus_one.precision = 0.5` and a current with `0.3` → must fail.

- [ ] **Step 4: Extend console report in `report.ts`**

After the existing per-fixture block, add (only when `current.findingMetricsByType` is non-empty):

```
Per finding type:
  n_plus_one         TP 1  FP 3  FN 0   precision 25.0%  recall 100.0%
  cache              TP 0  FP 4  FN 0   precision  0.0%  recall  100.0%
  ...
```

Sort by `precision` ascending (worst first) so the eye lands on the FP problem types.

- [ ] **Step 5: Extend markdown report in `report.ts`**

Same data as console but as a markdown table. Goes into `GITHUB_STEP_SUMMARY`.

```md
### Finding precision by type

| Type | TP | FP | FN | Precision | Recall | Δ Precision (pp) |
|---|---|---|---|---|---|---|
| n_plus_one | 1 | 3 | 0 | 25.00% | 100.00% | +0.00 |
```

When baseline is present, include the Δ column; otherwise omit it.

- [ ] **Step 6: Measure: regenerate baseline**

```bash
cd /home/andresl/Projects/recost/extension-c1
[ -d ../extension-benchmark ] || git clone https://github.com/recost-dev/extension-benchmark.git ../extension-benchmark
npm run benchmark -- --update-baseline | tee /tmp/c1-baseline.log
git diff benchmark/baseline.json
```

Verify the per-type entries look sane. Capture the numbers for the next step.

- [ ] **Step 7: Gate self-test**

Sanity-check that the gate would fire on a regression. Edit a copy of `baseline.json` to bump one type's precision up, then run `npm run benchmark` (NOT `--update-baseline`) and confirm it fails with the new per-type drop message. Discard the temp baseline change.

```bash
# Temporary verification — do NOT commit the modified baseline
cp benchmark/baseline.json /tmp/c1-baseline-backup.json
# Hand-edit benchmark/baseline.json: pick a type whose current precision is, say, 0.25
# and bump its baseline `precision` to 0.5. Then:
npm run benchmark 2>&1 | tail -20
# Expected: exit 1 with a per-type drop message.
# Restore:
cp /tmp/c1-baseline-backup.json benchmark/baseline.json
```

The gate fires correctly → step verified. The baseline.json on disk should be the real measured one (not the bumped test value) before commit.

---

### Task C1.3 — Document FPRs in `docs/accuracy/findings.md`

**Files:**
- Modify: `docs/accuracy/findings.md` — fill in calibration table

- [ ] Update the "Calibration table" with the numbers measured in Task C1.2 step 6. Convert precision to FPR (FPR = 1 - precision among emitted findings) for the issue's terminology. Also include sample size column so the reader can judge confidence.

Replace the placeholder table with one like:

```md
### Calibration table (measured 2026-05-13 against corpus v1 — 7 fixtures)

| Detector | TP | FP | FN | FPR | Precision | Severity (current) | Notes |
|---|---|---|---|---|---|---|---|
| `n_plus_one`         | X | X | X | XX% | XX% | high   | — |
| `cache`              | X | X | X | XX% | XX% | medium | Corpus has no expected `cache` findings; all emitted are FPs. |
| `batch`              | X | X | X | XX% | XX% | medium | — |
| `concurrency_control`| X | X | X | XX% | XX% | low    | Corpus expects `unbatched_parallel`; treat as alias or separate. |
| `redundancy`         | X | X | X | XX% | XX% | medium | — |
| `rate_limit`         | X | X | X | XX% | XX% | low    | — |

Sample size is tiny (corpus v1 has 3 expected findings total). FPRs here are diagnostic, not statistically robust. Acceptance criterion "no detector with FPR > 30%" applies once the corpus grows past N≥10 expected findings per type; until then, this PR establishes the measurement loop, not the final calibration.
```

Add a short paragraph above the table explaining:
- The numbers come from the D1 benchmark gate.
- Per-detector gates fire on any per-type precision drop > 1pp where sample size ≥ 3.
- The follow-up PRs (PR-2+) tighten the worst-offender detectors based on this data.

---

### Task C1.4 — Run full benchmark; commit; push; open PR

- [ ] **Step 1: Run the full benchmark**

```bash
cd /home/andresl/Projects/recost/extension-c1
npm run benchmark 2>&1 | tee /tmp/c1-final.log
```

Should pass (no regressions against the new baseline). Capture the per-type table from the output.

- [ ] **Step 2: Commit**

```bash
git add benchmark/metrics.ts benchmark/runner.ts benchmark/report.ts benchmark/baseline.json
git add src/test/benchmark-metrics.test.ts
git add docs/accuracy/findings.md
git add docs/superpowers/plans/2026-05-13-c1-waste-detector-calibration.md
git commit -m "$(cat <<'EOF'
feat(benchmark): per-detector finding-precision measurement (C1 step 1, #83)

Adds per-finding-type TP/FP/FN tracking to the D1 benchmark gate.
Baseline now records precision per detector type; CI fails on any
per-type precision drop > 1pp where sample size ≥ 3. Worst-offender
detectors can now be tightened one at a time in follow-up PRs.

Per-detector FPRs documented in docs/accuracy/findings.md.
EOF
)"
```

- [ ] **Step 3: Push + open PR**

```bash
git push -u origin claude/c1-waste-calibration
gh pr create --title "C1 step 1: per-detector finding-precision measurement (#83)" --body "$(cat <<'EOF'
## Summary

PR-1 of issue #83. Adds per-detector-type precision/recall to the D1 benchmark gate so that subsequent PRs can tighten the worst-offender waste detectors one at a time without regressions sneaking through under the global `findingPrecision` average.

- `benchmark/metrics.ts` — new `findingCountsByType` per fixture and `findingMetricsByType` aggregate.
- `benchmark/runner.ts` — baseline reader/writer extended; per-type regression gate (>1pp drop with sample size ≥3) added.
- `benchmark/report.ts` — per-type table in console output + GITHUB_STEP_SUMMARY.
- `benchmark/baseline.json` — bumped with measured per-type numbers.
- `docs/accuracy/findings.md` — calibration table filled in with measured numbers.

Does not change any detector behavior. Pure measurement infrastructure.

## D1 measurement

| Metric | Prior | This PR | Δ (pp) |
|---|---|---|---|
| Detection precision | 36.26% | XX.XX% | ±X.XX |
| Detection recall | 48.53% | XX.XX% | ±X.XX |
| Provider attribution | 82.14% | XX.XX% | ±X.XX |
| Finding precision | 6.25% | XX.XX% | ±X.XX |
| Finding recall | 33.33% | XX.XX% | ±X.XX |

(Global numbers should be unchanged — this PR only adds the per-type breakdown.)

### Per-detector breakdown (new)

| Type | TP | FP | FN | Precision |
|---|---|---|---|---|
| n_plus_one | X | X | X | XX% |
| cache | X | X | X | XX% |
| ... | | | | |

## Test plan

- [ ] CI `benchmark` passes (no metric drops > 1pp from new baseline)
- [ ] CI `test:scanner` passes; new per-type tests pass
- [ ] Manual: hand-bump one per-type precision in baseline.json → re-run benchmark → confirm gate fails with the per-type drop message

Closes part 1 of #83. PR-2+ will tighten individual detectors based on the per-type FPR data.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-review (controller)

**Spec coverage (issue #83):**

| Acceptance criterion | Covered by | Notes |
|---|---|---|
| Each detector has documented FPR in `docs/accuracy/findings.md` | Task C1.3 | Filled in from measured baseline |
| No detector has FPR > 30% | **Not in this PR** | Out of scope — PR-1 measures, PR-2+ tightens |
| FPR re-measured on every benchmark CI run | Task C1.1+C1.2 | Per-type metrics computed every run |
| Per-detector regressions fail the build | Task C1.2 step 3 | Gate fires on per-type precision drops |
| Documented exceptions for by-design conservative detectors | **Deferred** | Will be added when individual detectors are tightened (PR-2+) |

**Type consistency:** `PerTypeCounts` has the same shape used in both `PerFixtureMetrics.findingCountsByType` (without precision/recall — they're derived in aggregate) and `MetricsReport.findingMetricsByType` (with precision/recall). The asymmetry is intentional: per-fixture, only raw counts make sense; aggregate is where ratios are computed.

**Test coverage:** The 4 new test cases exercise: per-type TP/FP/FN tracking, FN attribution via expected.type, aggregate precision/recall math, and empty inputs. Existing tests are untouched.

**Risk:** The corpus v1 sample size per detector type is tiny (3 expected findings total across all types). The sample-size-≥-3 gate threshold sidesteps spurious failures, but the FPR numbers in `docs/accuracy/findings.md` are diagnostic, not statistically robust. The doc paragraph in Task C1.3 calls this out explicitly so future readers don't over-interpret the numbers.

**Parallel-session conflict:** Another session is on `claude/a1-multi-hop-wrappers` (issue #73) and may touch:
- `package.json` `test:scanner` — no overlap (this PR doesn't add new test scripts; it adds tests to an existing one).
- `benchmark/baseline.json` — likely overlap. Rebase right before push; re-run `npm run benchmark -- --update-baseline` from the rebased state to get the merged-state numbers.

---

## Execution handoff

Plan saved to `docs/superpowers/plans/2026-05-13-c1-waste-detector-calibration.md`.

Subagent-driven execution: implementer subagent dispatched on Tasks C1.1–C1.4 sequentially. Each task is small enough that a single implementer pass should clear it; reviewers run between tasks. The PR ships when all four tasks are committed and the gate self-test (C1.2 step 7) is verified.
