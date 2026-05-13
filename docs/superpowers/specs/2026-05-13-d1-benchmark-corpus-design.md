# D1 — Labeled Benchmark Corpus + CI Precision/Recall Gate (Design)

**Issue:** [#86](https://github.com/recost-dev/extension/issues/86)
**Roadmap doc:** `docs/accuracy/measurement.md`
**Date:** 2026-05-13
**Status:** Spec — pending implementation plan

## Goal

Build a labeled benchmark corpus of real OSS repo subsets, **vendored into a separate `recost-dev/extension_benchmark` repo**, hand-annotated with expected endpoints and findings. A `runner.ts` in the extension repo runs the live scanner against each fixture, computes precision/recall/attribution metrics, and compares against a committed `baseline.json`. A GitHub Actions workflow runs the same on every PR and fails the build if precision or recall drops > 1pp on any tracked metric.

This is the foundation for every other accuracy-track issue. A1, A2, A3, A5, A6, A7, C1, C3 all reference "benchmark shows no precision/recall regression" as acceptance criteria. Without D1, those bars are unenforceable.

## Repo split

D1's code and data live in two repos:

- **`extension`** (this repo) — runner, metrics, schema, baseline, smoke fixture, CI workflow. Gate-relevant logic lives with the gated code.
- **`recost-dev/extension_benchmark`** (separate repo, already created and empty) — the real fixtures (vendored OSS subsets + `expected.json` + `FIXTURE.md`).

The CI workflow in `extension` clones `extension_benchmark` at a pinned SHA before running the benchmark. The pinned SHA is the single source of truth for "which fixtures are we measured against right now."

**Why split:**
- Keeps `extension` slim — no hundreds of vendored OSS files bloating clones, IDE indexing, or developer scans
- Vendored OSS code is excluded from the VSIX automatically (it would be anyway via `.vscodeignore`'s allowlist, but now it's not even in the repo)
- Fixtures can be added/updated/refreshed independently of extension PRs
- Pinning by SHA in `extension` keeps CI deterministic — same SHA = same fixtures = same baseline expectations

**Editing model (post-ship):**

| Change | Edit which repo |
|---|---|
| Add / fix / refresh a fixture | `extension_benchmark` |
| Use newer fixtures for the gate | `extension` — bump `.benchmark-fixtures-sha` |
| Improve scanner; baseline legitimately moves | `extension` — code change + `baseline.json` update in same PR |
| Change gate threshold or runner logic | `extension` |

## Non-goals

- **Not** a replacement for unit tests. Unit tests check that a function does what it says; the benchmark checks the system end-to-end against real-world code.
- **Not** exhaustive. 5 repos for the v1 ship; up to 10 in a follow-up. The corpus is a representative sample, not coverage.
- **Not** a runtime telemetry tool. That is what `automated-parser` is for. D1 is a deterministic CI gate over pinned, vendored fixtures in a separate repo.
- **Not** sharing engine code with `automated-parser`. D1's runner invokes the **live** scanner via the extension's own `dist/cli/scan.js`, which is built from the current PR's source. `automated-parser`'s engine is a frozen snapshot; D1 tests the current PR.
- **Not** using git submodules. Pinning by SHA in a workflow step is simpler, has no local-dev ceremony, and doesn't infect contributors who don't run the benchmark.

## Architecture

```
extension/                              # this repo
  benchmark/                            # NEW
    runner.ts                           # orchestrates scan + compare per fixture
    metrics.ts                          # pure precision/recall math
    schema.ts                           # ExpectedJson types + validator
    report.ts                           # JSON + console output formatting
    baseline.json                       # committed metric baseline (LIVES HERE, not in fixtures repo)
    _smoke/                             # tiny in-repo fixture for runner unit tests
      src/example.ts                    # ~2 hand-crafted endpoints
      expected.json
    README.md                           # docs: where real fixtures live, how to add one
  .github/workflows/
    benchmark.yml                       # NEW — clones fixtures repo, runs benchmark
  .benchmark-fixtures-sha               # NEW — pinned SHA of extension_benchmark
  docs/accuracy/
    measurement.md                      # UPDATE — fill in initial baseline table
  package.json                          # ADD "benchmark" + "benchmark:smoke" scripts

extension_benchmark/                    # separate repo (recost-dev/extension_benchmark)
  langchain-openai/
    src/...                             # vendored 10-50 files from upstream
    expected.json                       # ground-truth annotations
    FIXTURE.md                          # provenance + scope
  openai-cookbook/
    src/...
    expected.json
    FIXTURE.md
  stripe-sample/...
  bedrock-raw-fetch/...
  flask-mixed-providers/...
  README.md                             # how to add a fixture
```

**Data flow per PR (extension repo):**

1. CI checks out `extension` at the PR head.
2. CI runs `npm ci` and `npm run build:ext`.
3. CI reads `.benchmark-fixtures-sha`, clones `extension_benchmark` at that SHA into `./benchmark-fixtures/` (shallow, no history).
4. CI runs `npm run benchmark -- --fixtures ./benchmark-fixtures`.
5. `runner.ts` enumerates `<fixtures-dir>/*/` (excluding `_*` and dotfiles), scans each by spawning `node dist/cli/scan.js <fixture>/src --format json` (the live scanner built from current PR source), loads `expected.json`, computes per-fixture and aggregate metrics.
6. Runner compares aggregate to `benchmark/baseline.json`. Exits non-zero if any tracked metric drops > 1pp.
7. Runner writes a markdown report to `$GITHUB_STEP_SUMMARY` showing per-metric current vs baseline vs delta, and per-fixture details for any regression.

**Local dev:**

- `npm run benchmark:smoke` — runs only against `benchmark/_smoke/`. No network. Used while developing the runner or for fast iteration.
- `npm run benchmark` — defaults to `--fixtures ../extension_benchmark` (sibling-dir convention). Errors with a clear message if the path doesn't exist, telling the user how to clone or override with `--fixtures <path>`.

**Key boundary:** `runner.ts` consumes scanner output through the same JSON shape `src/cli/scan.ts` already emits: `{ endpoints, suggestions, summary, scannedFileCount, target }`. It does not import scanner modules and does not poke at internals. When the scanner changes, the runner does not — as long as the JSON contract holds.

## Fixture strategy

**Vendor (in `extension_benchmark`), do not live-clone from upstream.** Each fixture is a committed subset (10-50 files) of a real OSS repo at a pinned upstream commit. Vendoring buys:

- Reproducible CI (no network to upstream GitHub, no rate limits, no upstream changes mid-flight)
- Stable line numbers for hand-annotated `expected.json`
- Offline development (once cloned, fully self-contained)
- Trivially diff-able regressions in PR review

The scope of each fixture: just enough code to exercise the surface that fixture represents (a few SDK call sites, the helpers that wrap them, the entry points that call those helpers). Trim out unrelated files (tests, docs, build configs) unless they're load-bearing for the scan.

Note: CI **does** clone `extension_benchmark` from GitHub at run time, but at a pinned SHA — so determinism is preserved. The "no upstream cloning" rule applies to the original OSS sources (LangChain, Stripe samples, etc.) which we vendor once into `extension_benchmark`.

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
  fixturesDir: string;          // CLI flag --fixtures; default: "../extension_benchmark" (sibling dir)
  baselinePath: string;         // default: "benchmark/baseline.json"
  thresholdPp: number;          // default: 1.0
  updateBaseline: boolean;      // when true, overwrite baseline.json instead of gating
  reportPath?: string;          // optional — write JSON report
  smokeOnly: boolean;           // when true, ignore fixturesDir and use benchmark/_smoke only
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
  1. `actions/checkout@v4` (extension repo at PR head)
  2. `actions/setup-node@v4` with Node 20 + npm cache
  3. `npm ci`
  4. `npm run build:ext`
  5. Read SHA: `FIXTURES_SHA=$(cat .benchmark-fixtures-sha)`
  6. Clone fixtures: `git clone --depth 1 https://github.com/recost-dev/extension_benchmark.git benchmark-fixtures && cd benchmark-fixtures && git fetch --depth 1 origin $FIXTURES_SHA && git checkout $FIXTURES_SHA && cd ..`
  7. `npm run benchmark -- --fixtures ./benchmark-fixtures` — exits non-zero on regression
  8. On failure, the report markdown is written to `$GITHUB_STEP_SUMMARY` so the PR shows a diff table in checks
- Concurrency: cancel-in-progress on the same PR head — prevents stacking runs as commits push.
- The fixtures clone uses the default `GITHUB_TOKEN` (sufficient for public repos; if `extension_benchmark` is later made private, switch to a PAT secret).

This is a separate workflow from `test.yml`. The benchmark is heavier per fixture than unit tests, and isolating it makes the gate failure obvious in PR status checks.

## Baseline bootstrap

Two-repo bootstrap. Order matters:

1. **In `extension_benchmark`:** land all 5 fixtures (vendored sources + `expected.json` + `FIXTURE.md`). Tag the head as `v1` for reference; capture the merge commit's SHA.
2. **In `extension`:** land the runner, schema, metrics, smoke fixture, and `.benchmark-fixtures-sha` pointing at the SHA from step 1. No `baseline.json` yet.
3. Locally in `extension`: clone `extension_benchmark` at that SHA into `../extension_benchmark`, run `npm run benchmark -- --update-baseline` to produce initial numbers.
4. Commit `baseline.json` and update the **Initial baseline** table in `docs/accuracy/measurement.md` in the same PR (or as a fast follow-up to step 2).
5. Land `benchmark.yml` last. Its first run on `main` after merge establishes the green baseline.

Rationale: if `benchmark.yml` lands before `baseline.json`, the workflow fails on its own introducing PR (no baseline → can't compare). Land the gate after the baseline is in.

## Subagent-driven parallelism

The slow part of D1 is fixture annotation. Each fixture is independent — different repo, different files, different ground truth. This is fan-out work. With the repo split, the parallelism shape splits cleanly across the two repos.

**Phase 1 — Schema-first (in `extension`, single agent, must finish first):**

- One agent lands `benchmark/schema.ts` (the `ExpectedJson` v1 schema). This is the contract the fixture-annotation agents will adhere to.
- Same agent lands `benchmark/_smoke/` (a tiny hand-crafted fixture with ~2 endpoints + 1 finding) to validate the schema.
- This phase blocks Phase 2A.

**Phase 2A — Runner in `extension` (single agent, parallel with Phase 2B):**

- Builds `metrics.ts`, `runner.ts`, `report.ts` against the smoke fixture.
- Adds `npm run benchmark` / `npm run benchmark:smoke` scripts.
- Lands as a self-contained PR in `extension`.

**Phase 2B — Fixtures in `extension_benchmark` (5 agents in parallel, one per fixture):**

- Each agent works in `extension_benchmark` repo (with `isolation: "worktree"`).
- Each agent: pick the upstream commit, vendor the chosen subset into `<fixture-slug>/`, write `FIXTURE.md`, hand-annotate `expected.json` against the v1 schema.
- Each fixture lands as a separate PR to `extension_benchmark`. Review is per-fixture; one stuck fixture doesn't block the others.

**Phase 3 — Integration (in `extension`, single agent, sequential):**

- After Phase 2A and all 5 of Phase 2B's PRs are merged:
- Bump `.benchmark-fixtures-sha` to point at `extension_benchmark` HEAD
- Clone fixtures locally, run `--update-baseline`, commit `baseline.json`
- Update `docs/accuracy/measurement.md` initial baseline table with real numbers
- Add `benchmark.yml` workflow
- Open final integrating PR in `extension`

**Why this works:**

- Phase 2A and 2B share only `schema.ts` — and schema lands in Phase 1 before either starts.
- 2A and 2B are in different repos; they cannot stomp on each other.
- The 5 fixture agents in 2B are in different directories within the same repo; with worktree isolation they cannot stomp on each other.
- Phase 3 is purely mechanical — collect + bump + measure + add workflow.

**Agent dispatch shape (for the implementation plan):**

- Phase 1: 1 sequential message.
- Phase 2: **1 message launching 6 agents in parallel** — 1 for Phase 2A (extension repo, runner) + 5 for Phase 2B (extension_benchmark, one per fixture). All use `isolation: "worktree"`.
- Phase 3: 1 sequential message after Phase 2 completes, with the merged-fixture SHA.

Each agent gets:
- A pointer to this spec
- The contract it must produce (file paths, schema, acceptance criteria)
- The repo to work in (`extension` or `extension_benchmark`)
- Worktree isolation

## Acceptance criteria

In `extension_benchmark`:
- [ ] ≥5 hand-labeled fixtures, each with vendored source, `expected.json` (schemaVersion 1), `FIXTURE.md`
- [ ] `README.md` documents how to add a fixture and the license policy

In `extension`:
- [ ] `benchmark/runner.ts`, `metrics.ts`, `schema.ts`, `report.ts` implemented
- [ ] `benchmark/_smoke/` exists with a hand-crafted fixture
- [ ] `.benchmark-fixtures-sha` pinned to `extension_benchmark` HEAD
- [ ] `npm run benchmark` and `npm run benchmark:smoke` scripts present and working
- [ ] `benchmark/baseline.json` committed with measured initial values
- [ ] `docs/accuracy/measurement.md` "Initial baseline" table filled in with real numbers
- [ ] `.github/workflows/benchmark.yml` runs on every PR and push to main
- [ ] Workflow fails when precision or recall drops > 1pp vs baseline (verified on a deliberately-regressed test branch)
- [ ] `metrics.ts` has unit tests for: exact match, ±2 line tolerance, missing detection, false positive, provider mismatch
- [ ] `benchmark/README.md` documents how to point at fixtures, update baseline, bump fixtures SHA

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
- Live-clone from upstream OSS at runtime (out of v1; that pattern stays in `automated-parser`).
- Git submodules (rejected; pinned SHA is simpler).
- V2 fixtures 6-10.
- Cost-impact accuracy (depends on C3, blocked).
- Making `extension_benchmark` a private repo or restricting access (it's public for now; auth swap is trivial later).

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
