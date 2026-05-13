# D1 — Labeled Benchmark Corpus + CI Precision/Recall Gate (Design)

**Issue:** [#86](https://github.com/recost-dev/extension/issues/86)
**Roadmap doc:** `docs/accuracy/measurement.md`
**Date:** 2026-05-13
**Status:** Spec — pending implementation plan

## Goal

Build a labeled benchmark corpus of real OSS repo subsets, vendored into `benchmark/fixtures/`, hand-annotated with expected endpoints and findings. A `runner.ts` runs the live scanner against each fixture, computes precision/recall/attribution metrics, and compares against a committed `baseline.json`. A GitHub Actions workflow runs the same on every PR and fails the build if precision or recall drops > 1pp on any tracked metric.

This is the foundation for every other accuracy-track issue. A1, A2, A3, A5, A6, A7, C1, C3 all reference "benchmark shows no precision/recall regression" as acceptance criteria. Without D1, those bars are unenforceable.

## Non-goals

- **Not** a replacement for unit tests. Unit tests check that a function does what it says; the benchmark checks the system end-to-end against real-world code.
- **Not** exhaustive. 5 repos for the v1 ship; up to 10 in a follow-up. The corpus is a representative sample, not coverage.
- **Not** a runtime telemetry tool. That is what `automated-parser` is for. D1 is a deterministic CI gate over pinned, vendored fixtures.
- **Not** sharing engine code with `automated-parser`. D1's runner invokes the **live** scanner via the extension's own `dist/cli/scan.js`, which is built from the current PR's source. `automated-parser`'s engine is a frozen snapshot; D1 tests the current PR.

## Architecture

```
extension/
  benchmark/                          # NEW
    fixtures/
      <fixture-slug>/
        src/...                       # vendored 10-50 files from upstream
        expected.json                 # ground-truth annotations
        FIXTURE.md                    # provenance + scope
    runner.ts                         # orchestrates scan + compare per fixture
    metrics.ts                        # pure precision/recall math
    schema.ts                         # ExpectedJson types + validator
    report.ts                         # JSON + console output formatting
    baseline.json                     # committed metric baseline
    README.md                         # how to add a fixture, how to update baseline
  .github/workflows/
    benchmark.yml                     # NEW — PR gate
  docs/accuracy/
    measurement.md                    # UPDATE — fill in initial baseline table
  package.json                        # ADD "benchmark" script
```

**Data flow per PR:**

1. CI installs deps and runs `npm run build:ext` (scanner needs compiled output).
2. CI runs `npm run benchmark`.
3. `runner.ts` enumerates `benchmark/fixtures/*/`, scans each by spawning `node dist/cli/scan.js <fixture> --format json` (the live scanner built from current PR source), loads `expected.json`, computes per-fixture and aggregate metrics.
4. Runner compares aggregate to `benchmark/baseline.json`. Exits non-zero if any tracked metric drops > 1pp.
5. Runner writes a markdown report to `$GITHUB_STEP_SUMMARY` showing per-metric current vs baseline vs delta, and per-fixture details for any regression.

**Key boundary:** `runner.ts` consumes scanner output through the same JSON shape `src/cli/scan.ts` already emits: `{ endpoints, suggestions, summary, scannedFileCount, target }`. It does not import scanner modules and does not poke at internals. When the scanner changes, the runner does not — as long as the JSON contract holds.

## Fixture strategy

**Vendor, do not live-clone.** Each fixture is a checked-in subset (10-50 files) of a real OSS repo at a pinned commit. Vendoring buys:

- Reproducible CI (no network, no GitHub rate limits, no upstream changes)
- Stable line numbers for hand-annotated `expected.json`
- Offline development
- Trivially diff-able regressions in PR review

The scope of each fixture: just enough code to exercise the surface that fixture represents (a few SDK call sites, the helpers that wrap them, the entry points that call those helpers). Trim out unrelated files (tests, docs, build configs) unless they're load-bearing for the scan.

**Provenance.** Each fixture has a `FIXTURE.md` recording:

- Source repo URL
- Commit SHA the subset was taken from
- License (must be permissive — MIT / Apache-2.0 / BSD)
- Scope statement: "This fixture exercises X." (e.g., "Wrapper-rich OpenAI SDK usage, multi-hop helper chains")

License notices from the upstream repo are preserved in the vendored subset where present.

### V1 corpus (5 fixtures)

Picked to span the highest-leverage surfaces — paired with the A-track issues they will measure:

| Slug | Source | Surface tested | Pairs with |
|---|---|---|---|
| `langchain-openai` | `langchain-ai/langchain` subset (Python or JS — pick the one with denser OpenAI usage) | Wrapper-heavy OpenAI SDK + multi-hop helpers | A1, A5 |
| `openai-cookbook` | `openai/openai-cookbook` selected files | Canonical OpenAI SDK chains | A6, baseline detection |
| `stripe-sample` | `stripe-samples/checkout-one-time-payments` or similar | Stripe SDK | A6 (object-literal FPs), general |
| `bedrock-raw-fetch` | A minimal Bedrock + raw-fetch demo (`aws-samples/...` permissive sample) | AWS SDK + raw `fetch` to known host | A2, A7 |
| `flask-mixed-providers` | A small Flask app calling 2-3 providers (LangChain or hand-picked Python OSS) | Python coverage, mixed SDK + raw HTTP | Python detector, A2 |

V2 follow-up (post-gate-live, separate PR) adds: `vercel-ai-examples`, `barrel-monorepo`, `dynamic-urls-repo`, `deep-wrapper-chains`, `express-generic-http`.

### Phased ship rationale

C path from prior brainstorm. The CI gate's value is binary: live or not live. Once 5 fixtures are in and the workflow blocks regressions, every A-track PR ships with measurement. Adding fixtures 6-10 in a follow-up does not lose anything and gets the gate working sooner.

## Annotation schema (`expected.json`)

Versioned. v1 schema:

```ts
interface ExpectedJson {
  schemaVersion: 1;
  fixtureSlug: string;
  endpoints: ExpectedEndpoint[];
  findings: ExpectedFinding[];
}

interface ExpectedEndpoint {
  /** Path relative to the fixture root (NOT the repo root). */
  file: string;
  /** Optional — the enclosing function name, for human readability and provider attribution checks. */
  function?: string;
  /** 1-based line number where the call appears. */
  line: number;
  /** Canonical provider id, matching `src/intelligence/provider-normalization.ts`. */
  provider: string;
  /** SDK method signature OR URL-path key. Either matches against fingerprint registry. */
  method: string;
  /** When true, missing this in scanner output counts as a recall miss. */
  must_detect: true;
  /** Optional notes for annotators / reviewers — never consumed by metrics. */
  notes?: string;
}

interface ExpectedFinding {
  file: string;
  function?: string;
  line: number;
  /** Finding type, e.g. "n_plus_one", "unbounded_loop", "missing_cache_guard". */
  type: string;
  /** When true, the matching finding in scanner output counts as a true positive. */
  is_true_positive: true;
  notes?: string;
}
```

**Matching rules** (in `metrics.ts`, kept pure and testable):

- An expected endpoint matches a detected endpoint when `file` + `provider` + `method` align AND the detected `line` falls within ±2 lines of the expected line. The ±2 tolerance absorbs multi-line call expressions and span normalization differences without letting unrelated calls match.
- Provider attribution accuracy is measured **only on detected endpoints** (cannot attribute what was not detected).
- A detected endpoint with `provider: "unknown"` counts against precision **only** if no expected endpoint matches its `file` + line. (Otherwise it's a recall miss, not a precision miss — we already know we failed to attribute it.)
- An expected finding matches a detected finding when `file` + `type` align AND `line` is within ±2 lines.
- Expected entries not present in the scanner output → false negatives (hurt recall).
- Detected entries not matched to any expected entry → false positives (hurt precision).
- **`schemaVersion: 1` is checked at load.** Mismatch is a hard error.

## Metrics

Five tracked aggregates, computed in `metrics.ts`:

| Metric | Formula |
|---|---|
| Detection precision | TP_endpoints / (TP_endpoints + FP_endpoints) |
| Detection recall | TP_endpoints / (TP_endpoints + FN_endpoints) |
| Provider attribution accuracy | correctly_attributed / detected_with_provider |
| Finding precision | TP_findings / (TP_findings + FP_findings) |
| Finding recall | TP_findings / (TP_findings + FN_findings) |

Each is reported globally (across all fixtures) and per-fixture (for diagnosis). The **gate** is on the global aggregate only — per-fixture noise should not block PRs, but per-fixture deltas are surfaced in the report so authors can see where a regression landed.

`metrics.ts` is a pure function: `(expected: ExpectedJson[], detected: ScanResult[]) → MetricsReport`. No I/O. Unit-tested directly with handcrafted small inputs.

## Runner contract

```ts
// benchmark/runner.ts
async function runBenchmark(opts: {
  fixturesDir: string;          // default: "benchmark/fixtures"
  baselinePath: string;         // default: "benchmark/baseline.json"
  thresholdPp: number;          // default: 1.0
  updateBaseline: boolean;      // when true, overwrite baseline.json instead of gating
  reportPath?: string;          // optional — write JSON report
}): Promise<{ exitCode: 0 | 1; report: MetricsReport }>;
```

The runner is invoked by `package.json`'s `npm run benchmark`. Two modes:

- **Default mode (CI gate):** compares to `baseline.json`. Exits 1 if any tracked metric drops > `thresholdPp`.
- **Update mode:** `npm run benchmark -- --update-baseline`. Overwrites `baseline.json` with current numbers. Used when a PR legitimately improves accuracy — author runs it locally and commits the new baseline alongside their fix.

The runner uses `src/cli/scan.ts` indirectly: it spawns the same compiled CLI (`node dist/cli/scan.js <fixture> --format json`) per fixture. This buys:

- The runner inherits whatever the CLI inherits (same code paths the user runs).
- No need to embed scanner internals into the runner.
- Crash isolation per fixture — a scanner crash on fixture N doesn't take down the whole run.

Fixtures run sequentially (not parallel) in CI — keeps logs deterministic and avoids tree-sitter WASM contention. A 10-fixture run on 10-50 files each should complete in well under a minute.

## CI workflow

`.github/workflows/benchmark.yml`:

- Trigger: `pull_request: branches: [main]` and `push: branches: [main]`.
- Steps:
  1. `actions/checkout@v4`
  2. `actions/setup-node@v4` with Node 20 + npm cache
  3. `npm ci`
  4. `npm run build:ext`
  5. `npm run benchmark` — exits non-zero on regression
  6. On failure, the report markdown is written to `$GITHUB_STEP_SUMMARY` so the PR comments show a diff table
- Concurrency: cancel-in-progress on the same PR head — prevents stacking runs as commits push.

This is a separate workflow from `test.yml`. The benchmark is heavier per fixture than unit tests, and isolating it makes the gate failure obvious in PR status checks.

## Baseline bootstrap

First-ship bootstrap, in order:

1. Land the runner, schema, metrics, and the 5 fixtures' code + `expected.json` (no `baseline.json` yet).
2. Run `npm run benchmark -- --update-baseline` locally to produce the initial numbers.
3. Commit `baseline.json` and update the **Initial baseline** table in `docs/accuracy/measurement.md` in the same PR.
4. Land `benchmark.yml` last — its first run on `main` after merge establishes the green baseline.

Rationale: if `benchmark.yml` lands before `baseline.json`, the workflow fails on its own introducing PR (no baseline → can't compare). Land the gate after the baseline is in.

## Subagent-driven parallelism

The slow part of D1 is fixture annotation. Each fixture is independent — different repo, different files, different ground truth. This is fan-out work.

**V1 implementation parallelism (5 streams, can run concurrently):**

- **Stream A (1 agent):** Build `benchmark/schema.ts`, `metrics.ts`, `runner.ts`, `report.ts` against a stub fixture. Stream A produces a complete runner before any real fixture lands.
- **Streams B1-B5 (5 agents in parallel, one per fixture):**
  - Each agent: pick the upstream commit, vendor the chosen subset into `benchmark/fixtures/<slug>/`, write `FIXTURE.md`, hand-annotate `expected.json`, run the live scanner locally against the fixture, sanity-check that the scanner output is broadly plausible (not validating against expected — just smoke).
  - Each fixture lands as a separate sub-branch / sub-PR off the D1 integration branch, so review is per-fixture and a stuck fixture doesn't block the others.

**Integration phase (sequential, after streams converge):**

- One agent: assemble all 5 fixtures into the integration branch, run `--update-baseline`, commit `baseline.json`, update `docs/accuracy/measurement.md`, add `benchmark.yml`, open final PR.

**Why this works:**

- Streams B1-B5 only share the **schema** with each other and the runner — and the schema lands in Stream A before B1-B5 start labeling. They don't touch each other's directories.
- Stream A can run against a tiny `_smoke/` fixture (hand-crafted toy with 2 endpoints, 1 finding) to develop the runner without waiting on real fixtures.
- The final integration is the only sequential bottleneck. It's mechanical.

**Agent dispatch shape (for the implementation plan):**

- 1 message launches Stream A (general-purpose agent) AND B1-B5 (5 general-purpose agents, one per fixture) **in parallel** in a single tool call block.
- Each agent gets:
  - A pointer to this spec
  - The contract it must produce (file paths, schema)
  - A worktree isolation flag (`isolation: "worktree"`) so they don't stomp on each other's working directory
- An integration agent runs **after** all 6 streams complete — it consumes their worktrees, merges, and produces the final PR.

## Acceptance criteria

- [ ] `benchmark/` directory exists with ≥5 hand-labeled fixtures
- [ ] Each fixture has `expected.json` (schemaVersion 1), `FIXTURE.md`, vendored source
- [ ] `npm run benchmark` runs to completion, produces a metrics report
- [ ] `benchmark/baseline.json` committed with measured initial values
- [ ] `docs/accuracy/measurement.md` "Initial baseline" table filled in with real numbers
- [ ] `.github/workflows/benchmark.yml` runs on every PR and push to main
- [ ] Workflow fails when precision or recall drops > 1pp vs baseline (verified on a deliberately-regressed test branch)
- [ ] `metrics.ts` has unit tests for: exact match, ±2 line tolerance, missing detection, false positive, provider mismatch
- [ ] `benchmark/README.md` documents how to add a fixture and how to update the baseline

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Hand-annotation is wrong → bad baseline | Each fixture's `expected.json` is reviewed in its own sub-PR by a human before merge. `FIXTURE.md` documents the labeler's reasoning. |
| Scanner non-determinism leaks into metrics | Fix any non-deterministic ordering at scanner-output read time in the runner (sort detected endpoints by `file:line` before metric computation). |
| Vendored fixture license issues | Only permissive-licensed repos (MIT / Apache-2.0 / BSD). License notice preserved per fixture. `FIXTURE.md` records the license. |
| Fixture size bloat slows CI | Per-fixture cap of 50 files. CI step timeout of 5 min. |
| Baseline drift gaming (PRs that update baseline to mask regressions) | Baseline updates require an explanation in the PR description. Review process flags "baseline changed without code change to detection" as a smell. (Cultural, not enforced.) |
| Tree-sitter WASM init cost dominates a fixture | Fixtures run sequentially; WASM is initialized once per process. Negligible. |

## Out of scope (explicitly deferred)

- Per-fixture gating (only aggregate gates v1).
- HTML report (markdown step-summary only).
- Historical metric tracking / graphing.
- Live-clone mode (out of v1; the recycle from `automated-parser` does this and stays in `automated-parser`).
- V2 fixtures 6-10.
- Cost-impact accuracy (depends on C3, blocked).

## Open questions

None — all questions raised in brainstorm have been resolved in the design above.

## Reference

- Original roadmap: `docs/accuracy/measurement.md`
- Issue: [#86](https://github.com/recost-dev/extension/issues/86)
- Precedent for runnable measurement script: `src/test/waste-calibration.ts` (calibrate-detectors npm script)
- Precedent for fixture-driven testing: `src/test/parity.ts` + `src/test/fixtures/parity/`
- Code patterns to recycle from `~/Projects/recost/automated-parser`:
  - `src/index.ts` clone-and-scan loop (informs CLI invocation shape)
  - `.github/workflows/run.yml` (workflow skeleton)
  - `package.json:build:engine` (engine-build pattern; we use the extension's own build instead)
