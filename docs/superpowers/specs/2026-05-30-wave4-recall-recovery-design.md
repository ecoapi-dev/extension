# Wave 4 — Recover the two C1 false negatives (#117)

**Date:** 2026-05-30
**Issue:** [#117](https://github.com/recost-dev/extension/issues/117) — `wave/4-recall-recovery`, `area/findings`
**Design note backing this work:** [`docs/accuracy/findings.md`](../../accuracy/findings.md) (C1)

## Problem

PR #111 closed C1 (#83) by driving the local waste detector's false positives to zero. Two labeled **false negatives** were intentionally accepted as out-of-scope at the time. Both are cases where a previously-shipped guard now suppresses a real positive:

1. **`batch` FN** at `flask-mixed-providers/src/providers/anthropic_helper.py:11` — `_client.messages.create(...)` is called once each in two module-level functions (`summarize`, `summarize_with_style`). The same SDK method called repeatedly across functions in one module is batchable, but PR-3's `(provider, enclosingFunction)` bucketing suppresses it (calls in different functions land in different buckets, and each bucket has < 3 calls).

2. **`unbatched_parallel` FN** at `langchain-openai/src/libs/langchain-openai/src/tools/dalle.ts:242` — `Promise.all(Array.from({ length: this.n }).map(() => this.client.images.generate(...)))` fans out `n` parallel image-generation requests with identical params. DALL-E's `images.generate` accepts `n` directly in a single request, so this is provably wasteful — but the `BOUNDED_REPLICATION` guard (PR #110) silences it, and even with the guard lifted the detector emits the wrong type string.

Both need a finer structural signal than the AST currently uses. This wave is sequenced last in the accuracy roadmap precisely because the C1 PR-3 → PR-4 loop has historically re-introduced FPs; the guardrails below are the core of the design.

## Goals / Non-goals

**Goals**
- Recover both false negatives so the benchmark shows `batch` and `unbatched_parallel` rows at TP 1 / FP 0 / FN 0.
- Introduce no new false positives — per-type precision must hold on every other row.
- Keep the two fixes file-disjoint so they parallelize across two subagent tracks.

**Non-goals**
- Corpus expansion (#113) or traceability dual-locations (#81) — separate waves.
- Reworking the `concurrency_control` detector or the existing `(provider, enclosingFunction)` batch pass; the new Python pass is additive.

## Design

Two recall-recovery fixes, file-disjoint, one per track.

### Track A — Python cross-function batch FN

**File:** `src/scanner/python-waste-detector.ts` (`detectSequentialBatching`)

Add a **second bucketing pass** that runs after the existing `(providerKey, enclosingFunction)` pass:

- Bucket non-loop matches by `(providerKey, methodChain)` at **module scope** (i.e. across enclosing functions).
- Fire a `batch` finding when the same `(providerKey, methodChain)` appears in **≥ 2 distinct functions** with no nearby `asyncio.gather` / concurrency-limiter guard.
- Anchor the finding at the **earliest** call line in the group (→ line 11 for the fixture, inside the ±2 line tolerance the benchmark matcher allows).
- Dedupe against the primary function-scoped pass so a cluster already flagged is not double-emitted (reuse the existing line/finding dedupe).

**Suggestion copy:** "N calls to `{methodChain}` across multiple functions in this module — consolidate into a single batched call."

**FP guardrail (the PR-3 trap):** keying on `methodChain` equality — not just `providerKey` — is the safeguard. Calls to different SDKs or different methods never merge into one bucket. This directly honors the issue's "must NOT re-introduce the FPs that motivated PR-3 (calls across different SDKs / different methodChains)." The "≥ 2 distinct functions" requirement (vs the primary pass's "≥ 3 in a line cluster") is the looser bar where FP risk lives, so it is gated tightly by exact-method bucketing + the concurrency-guard window check.

### Track B — DALL-E inline-parallel FN + new `unbatched_parallel` type

Two coupled changes.

**1. Lift the guard.** `src/ast/waste/batch-detector.ts` — remove the `BOUNDED_REPLICATION` early-return *inside `detectInlineParallel`* only. Keep it in `detectBatch`, where there is no n-parameter signal and bounded replication may be legitimate. Rationale: `detectInlineParallel` runs only when `inlineParallelCapable` is true (the endpoint has an n/count parameter, per #116). Once that is known, `Array.from({ length: n }).map(call)` is the *symptom* of the waste, not a mitigating factor — the flag is the precision control the guard was providing elsewhere.

**2. New `unbatched_parallel` type.** `detectInlineParallel` emits `type: "unbatched_parallel"` instead of `"batch"`. The benchmark matcher compares type strings **exactly** (no aliasing), and the corpus labels this finding `unbatched_parallel`, so the scanner must produce that literal. It is a **cost / batch-family** finding (you can save money by passing `n`), so it groups with `batch`, **not** with the reliability set (`rate_limit`, `concurrency_control`).

**Type ripple** (traced from how `concurrency_control` threads through the codebase) — register `unbatched_parallel` in:

- **Union (3 declarations):** `src/analysis/types.ts`, `webview/src/types.ts`, `dashboard/src/lib/types.ts`
- **Savings multiplier:** `src/scan-results.ts` `BASE_MULTIPLIERS` — value `0.18`, matching `batch`
- **Labels / icons:** `webview/src/components/ResultsPage.tsx` `TYPE_LABELS` (e.g. `"unbatched parallel"`); `dashboard/src/pages/Suggestions.tsx` (icon map + label map)
- **Intelligence titles:** `src/intelligence/compression.ts` (title maps, e.g. "Unbatched parallel fan-out")
- **Explicitly NOT** added to `RELIABILITY_FINDING_TYPES` in `src/intelligence/scorer.ts` / `src/intelligence/clusters.ts` — it is a cost finding, so it does not contribute to the reliability score.

TypeScript exhaustiveness over the union will force every site that switches on `SuggestionType` to handle the new member; `npm run build` failing is itself a completeness check for the ripple.

## Testing

**Track A** — `src/test/python-waste-detector.test.ts`:
- New: two same-method calls across two functions in a module → exactly one `batch` finding anchored at the earliest line.
- Negative (FP guard): two calls of *different* methods (or *different* providers) across functions → no finding.
- Each test must fail on revert of the implementation.

**Track B** — `src/test/ast-batch-detector.test.ts` plus the type-ripple sites:
- New: `Promise.all(Array.from({ length: n }).map(() => client.images.generate(...)))` on an `inlineParallelCapable` endpoint → one `unbatched_parallel` finding.
- Regression: a non-`inlineParallelCapable` `Array.from({ length: N })` fan-out is still suppressed (guard removal did not widen blast radius).
- Each test must fail on revert.

**Establish the live baseline first.** The issue records the `batch` row as "currently 0/0/1", but the older `docs/accuracy/findings.md` calibration table (2026-05-13) records a `batch` **FP** at `bedrock-raw-fetch/src/index.ts:5` (two sequential `await handleApi(...)` calls, an arguably-true-positive the corpus did not label). These disagree because one is stale. **Before any code change, run `npm run benchmark` to capture the real current `batch` / `unbatched_parallel` rows.** If the bedrock FP still exists, recovering the FN yields TP 1 / FP 1 / FN 0 — failing the "FP 0" bar. That FP is *not* addressed by Track A's code change; it is a corpus-labeling question (label the bedrock case a TP, or tighten separately) and must be surfaced as a blocking finding, not silently absorbed.

**Whole-wave gates (all must pass before merge):**
- `npm run test:scanner` green.
- `npm run build` clean (catches every UI / dashboard ripple site via exhaustiveness).
- `npm run benchmark` against `../extension-benchmark`:
  - `batch` row → TP 1 / FP 0 / FN 0 (currently 0 / 1 / 1).
  - `unbatched_parallel` row → TP 1 / FP 0 / FN 0 (currently 0 / 0 / 1).
  - No per-type precision regression on any other row. This is the issue's real acceptance bar and the FP-risk backstop.
- All 7 existing C1 tests still pass (no regression to PR-3 / PR-4 fixtures).

## Implementation via dynamic subagent workflow

Mirrors the #126 Wave 3 build:

- **Two parallel implementation tracks**, worktree-isolated:
  - **Track A** — `src/scanner/python-waste-detector.ts` + its test.
  - **Track B** — `src/ast/waste/batch-detector.ts` + the `unbatched_parallel` type ripple (union, multiplier, labels, intelligence titles) + its test.
  - File-disjoint: the only shared surface is test infrastructure conventions; the type union is touched by B only.
- Each track: implement → self-verify (`npm run test:scanner` + targeted tests) → code-quality review subagent.
- **Barrier.** Then a final whole-impl pass: `npm run build` + `npm run benchmark`, confirm both rows recovered with zero regression, final review verdict.

## Acceptance criteria

- [ ] `batch` benchmark row at TP 1 / FP 0 / FN 0.
- [ ] `unbatched_parallel` benchmark row at TP 1 / FP 0 / FN 0.
- [ ] No new FPs: per-type precision stays at 100% for both rows and no other row regresses.
- [ ] All 7 existing C1 tests still pass.
- [ ] `npm run build` and `npm run test:scanner` green.

## Risks

- **FP re-introduction (Track A).** The cross-function pass is a looser bar than the existing cluster pass. Mitigated by exact `methodChain` bucketing, the ≥ 2-distinct-functions requirement, and the concurrency-guard window check. The benchmark precision gate is the backstop — if any other row regresses, the pass is too loose.
- **Type-ripple miss (Track B).** A missed switch site would surface the new type with a fallback label or break the build. Exhaustiveness + `npm run build` is the guard.
