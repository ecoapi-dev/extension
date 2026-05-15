# C1 PR-4 — Tighten `rate_limit` + the residual `batch` FP

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` to implement this plan. PR-4 of issue #83. Builds on PR-1 (#106 measurement infra), PR-2 (#108 cache detector), PR-3 (#109 batch detector — same-function bucketing).

**Goal:** Drive the two lingering single-emission false positives to zero so the per-finding-type metrics no longer carry rows with 0% precision. Target: `rate_limit` (TP 0 / FP 1 / FN 0 → TP 0 / FP 0 / FN 0) and `batch` (TP 0 / FP 1 / FN 1 → TP 0 / FP 0 / FN 1). Refresh `benchmark/baseline.json` so future PRs measure against post-A3/A5 numbers, not the stale pre-#110 baseline.

**Why now:** PR-3 cleared the `batch` cluster from 9 FPs to 1, leaving exactly one residual emission per detector. Both are concentrated in one fixture (`bedrock-raw-fetch`), the fix shape is mechanical, and the baseline has been stale since PR #110 merged — refreshing it as part of a tiny calibration PR (rather than a separate housekeeping commit) keeps history easy to bisect. C1 (#83) cannot be closed while any detector sits at 0% precision.

**Architecture:** Two surgical detector changes (one regex extension, one bucketing-eligibility filter) + a baseline refresh. Each detector change ships behind its own TDD task with an in-repo fixture mirroring the live FP, matching the small-PR shape of PR-2 (#108) and PR-3 (#109). One PR, three commits.

**Tech stack:** TypeScript 5, `web-tree-sitter` (already wired), node:test-style hand-rolled runner under `src/test/`, `benchmark/runner.ts` (compiled via `tsconfig.benchmark.json`).

---

## Investigation (already done — read before editing)

Ran the live scanner against all 7 corpus fixtures (`for f in bedrock-raw-fetch dynamic-fetch-urls flask-mixed-providers langchain-openai openai-cookbook raw-fetch-elevenlabs stripe-sample; do node dist/cli/scan.js .../$f/src --format json; done`). Only `bedrock-raw-fetch` produces any waste-finding FPs after PR-3:

| Fixture | File:line | Type | Confidence | Detector path | Emitting ID |
|---|---|---|---|---|---|
| bedrock-raw-fetch | `src/index.ts:5` | `batch` | 0.57 | `src/ast/waste/batch-detector.ts` → `detectSequential()` | `local-batch-seq-index.ts:5` |
| bedrock-raw-fetch | `src/summarize.ts:10` | `rate_limit` | 0.69 | `src/ast/waste/concurrency-detector.ts` → `detectRetryStorm()` | `local-rate_limit-retry-summarize.ts:10` |

The Python detector (`src/scanner/python-waste-detector.ts`) emits zero rate_limit findings — there is no Python `detectRetryStorm`. All rate_limit emissions come from the TS AST path.

### Per-type metrics at HEAD (commit `75ea6b4`, post-#110)

```
batch                  TP 0  FP 1  FN 1   precision   0.0%  recall   0.0%  Δ +0.00pp
rate_limit             TP 0  FP 1  FN 0   precision   0.0%  recall 100.0%  Δ +0.00pp
n_plus_one             TP 1  FP 0  FN 0   precision 100.0%  recall 100.0%  Δ +0.00pp
unbatched_parallel     TP 0  FP 0  FN 1   precision 100.0%  recall   0.0%  Δ +0.00pp
```

The per-type gate from PR-1 only fires when `TP+FP >= 3`. Both target rows are below threshold today — they don't gate, but they keep the global `findingPrecision` at 33.33% (1 TP / 3 emissions). Dropping both FPs lifts it to 50.00% (1 TP / 2 emissions) and removes the noise rows from `findingMetricsByType`.

### Detection metrics at HEAD (stale baseline)

`benchmark/baseline.json` still records pre-A3/A5 numbers. Current actuals:

| Metric | baseline.json | current | Δ |
|---|---|---|---|
| Detection precision | 36.26% | 35.35% | −0.91 |
| Detection recall | 48.53% | 51.47% | +2.94 |
| Provider attribution | 82.14% | 82.76% | +0.62 |
| Finding precision | 33.33% | 33.33% | 0.00 |
| Finding recall | 33.33% | 33.33% | 0.00 |

The stale baseline means every future PR sees an inflated −0.91pp detection-precision delta on first run. Refreshing as part of this PR is non-negotiable.

### FP 1 — `rate_limit` at `bedrock-raw-fetch/src/summarize.ts:10`

```ts
// src/summarize.ts (verbatim, with line numbers)
1   import { invokeClaude, converseWithClaude } from "./bedrock-client";
2   import { MODEL_HAIKU, MODEL_SONNET, DEFAULT_MAX_TOKENS } from "./config";
3   import { withRetry } from "./retry";
4
5   const SUMMARIZE_INSTRUCTIONS =
6     "Summarize the following text in 2-3 sentences, preserving key facts:";
7
8   export async function summarizeShort(text: string): Promise<string> {
9     const prompt = `${SUMMARIZE_INSTRUCTIONS}\n\n${text}`;
10    return withRetry(() => invokeClaude(prompt, MODEL_HAIKU));
11  }
```

`detectRetryStorm()` (file: `src/ast/waste/concurrency-detector.ts:189-232`) fires here because of these three checks:

```ts
if (match.frequency === "polling") return null;             // ✗ frequency="single"
if (!RETRY_PATTERN.test(win)) return null;                  // ✓ "withRetry" and "./retry" both match \bretry\b case-insensitive
if (BACKOFF_GUARD.test(win)) return null;                   // ✗ window has no backoff/jitter/sleep(/delay(/exponential
if (CONCURRENCY_GUARD.test(win)) return null;               // ✗ no p-limit/bottleneck/etc.
```

The actual exponential-backoff lives in `src/retry.ts` (the implementation of `withRetry`). The ±8-line window can't see it. From the detector's perspective there is a retry pattern with no visible pacing → ship a rate-limit warning. **`withRetry` is the convention for "I've already handled backoff" — not a sign of retry-storm risk.**

The current BACKOFF_GUARD regex (line 27-28):

```ts
const BACKOFF_GUARD =
  /\b(backoff|jitter|retryAfter|exponential|sleep\s*\(|delay\s*\(|retryDelay|retryAfterMs)\b/i;
```

It catches *raw pacing primitives* but no *wrapper-function names*. Established Node ecosystem retry helpers are `withRetry`, `with_retry`, `pRetry` (p-retry npm), `asyncRetry` / `retryAsync` (async-retry npm), `withBackoff`, `with_backoff`. When any of these appears as a call (`name\s*\(`) in the window, treat as backoff-guarded.

### FP 2 — `batch` at `bedrock-raw-fetch/src/index.ts:5`

```ts
// src/index.ts (verbatim, with line numbers)
1   import { handleApi } from "./routes/api";
2   import { log } from "./utils/log";
3
4   async function main(): Promise<void> {
5     const summary = await handleApi({
6       path: "/summarize",
7       body: { text: "AWS Bedrock provides foundation models from multiple providers.", mode: "short" },
8     });
9     log.info("summary result", { summary });
10
11    const answer = await handleApi({
12      path: "/answer",
13      body: { question: "What is the capital of France?" },
14    });
15    log.info("answer result", { answer });
16  }
```

`detectSequential()` (file: `src/ast/waste/batch-detector.ts:201-256`) buckets by `(provider, enclosingFunction)` — both calls are in `main()` and both resolve to `aws-bedrock`. The cluster reaches `uniqueLines.size === 2` and fires.

**These are not batchable.** `handleApi({path:"/summarize", ...})` and `handleApi({path:"/answer", ...})` dispatch to two distinct business endpoints through a project-local wrapper. The shared `aws-bedrock` attribution comes from deep cross-file resolution propagating the provider up through `routes/api.ts` → `summarize.ts` → `bedrock-client.ts`. Both matches are `crossFile: true` (verified via the CLI JSON — `callSites[].crossFileOrigin` is set for both).

Two distinguishing facts make this principled to filter:

1. The user wrote ONE call expression per line at the visible site (`handleApi(...)`). The "second" emission is the resolver echoing the same wrapper twice into the same function, not the user writing duplicate work.
2. Direct sequential SDK calls — the case the detector *should* catch — have `crossFile: false` because the SDK methodChain is recognized at the call site (`client.chat.completions.create(...)`).

**Fix:** skip `crossFile === true` matches in `detectSequential()`. Direct SDK clusters keep firing; resolver-echoed wrapper clusters don't.

Verification this preserves the legitimate path: PR-3's `ts_same_function.ts` regression fixture uses two `client.chat.completions.create(...)` calls — kind `sdk`, `crossFile` is unset (falsy). The new filter leaves it untouched. PR-3's `py_same_function.py` fixture is unaffected because Python sequential batching lives in a different code path (`src/scanner/python-waste-detector.ts`).

### Out of scope (do NOT widen the PR)

- **The `batch` FN at `flask-mixed-providers/src/providers/anthropic_helper.py:11`.** Expected.json's note states the scanner historically emitted at line 7 (module-level constructor); PR-3's `(provider, enclosingFunction)` bucketing now suppresses that emission entirely. Recovering it requires either un-doing PR-3's tightening or adding a separate "same-resource call across different functions in the same module" detector — neither fits the small-PR shape. Tracked as PR-5 candidate.
- **Lifting global finding precision above 50% .** This PR yields 50% (1 TP / 2 emissions). Going higher needs more positive corpus labels, not detector changes.
- **Corpus label edits.** The bedrock-raw-fetch index.ts:5 case is arguably a TP that the corpus didn't label (PR-3 status note). The user's directive is to calibrate detectors, not modify truth.
- **`CACHE_GUARD` / `BATCH_GUARD` literal-word leak.** Documented gotcha from PR-2 and PR-3 — bare words "cache" and "batch" in surrounding comments suppress findings. Worth a separate tightening pass; this PR's fixtures will avoid the trap by keeping those words out of docstrings.

---

## Issue #83 acceptance criteria — coverage table

| #83 acceptance criterion | Addressed by | Status after PR-4 |
|---|---|---|
| Each detector has documented FPR in `docs/accuracy/findings.md` | (already documented through PR-3) | unchanged — no new doc churn this PR |
| No detector has FPR > 30% | Task PR4.1 (rate_limit → 0 emissions), Task PR4.2 (batch → 0 emissions) | satisfied; both target rows disappear from `findingMetricsByType` |
| FPR re-measured on every benchmark CI run; regressions fail the build | (PR-1 #106 already shipped this) | unchanged |
| Documented exceptions for by-design conservative detectors | (no by-design conservatism left after PR-4) | `unbatched_parallel` remains at 0% recall by design; note added in Task PR4.3 commit message |

After PR-4 merges, every C1 acceptance row is checked. The issue can be closed.

---

## File structure

| File | Action | Responsibility |
|---|---|---|
| `src/ast/waste/concurrency-detector.ts` | modify (lines 26-28: extend `BACKOFF_GUARD`) | adds wrapper-function-name retry guards |
| `src/ast/waste/batch-detector.ts` | modify (lines 207-219: filter `detectSequential` inputs) | suppresses crossFile-echoed clusters |
| `src/test/fixtures/c1-pr4/ts_retry_wrapper.ts` | create | mirrors `summarize.ts:10` (negative — `withRetry` should not fire) |
| `src/test/fixtures/c1-pr4/ts_retry_loop.ts` | create | preserves real retry-storm detection (positive — bare retry loop should fire) |
| `src/test/fixtures/c1-pr4/ts_wrapper_sequential.ts` | create | mirrors `index.ts:5` (negative — two wrapper calls should not fire) |
| `src/test/c1-pr4-rate-limit-tightening.test.ts` | create | exercises retry-wrapper fixtures |
| `src/test/c1-pr4-batch-residual.test.ts` | create | exercises wrapper-sequential fixture |
| `package.json` | modify (`scripts.test:scanner`) | register both new test files |
| `benchmark/baseline.json` | modify | refresh to post-#110 + post-PR-4 actuals |

**No new architecture. No new abstractions.** Each detector edit is one regex change or one filter call.

---

## Tasks

### Task PR4.1 — Tighten `detectRetryStorm` (TDD)

Files:
- Modify: `src/ast/waste/concurrency-detector.ts`
- Create: `src/test/fixtures/c1-pr4/ts_retry_wrapper.ts`
- Create: `src/test/fixtures/c1-pr4/ts_retry_loop.ts`
- Create: `src/test/c1-pr4-rate-limit-tightening.test.ts`
- Modify: `package.json` (`scripts.test:scanner`)

- [ ] **Step 1: Create the two TS fixtures**

`src/test/fixtures/c1-pr4/ts_retry_wrapper.ts` — mirrors the live FP at `bedrock-raw-fetch/src/summarize.ts:10`. **DO NOT** include the bare words `cache`, `batch`, `backoff`, `jitter`, `exponential`, or `sleep(` in any comment or docstring; those would either suppress the finding (cache/batch guards) or pre-emptively guard it (backoff/jitter/exponential/sleep) and obscure the test signal.

```ts
import OpenAI from "openai";
import { withRetry } from "./retry";

const client = new OpenAI();

export async function summarizeShort(text: string): Promise<string> {
  const prompt = `Summarize: ${text}`;
  return withRetry(() => client.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
  }));
}
```

`src/test/fixtures/c1-pr4/ts_retry_loop.ts` — positive fixture: a hand-rolled retry loop with no backoff, no concurrency limit, and no wrapper-function. This MUST still trigger `rate_limit` after the change (otherwise we've gutted the detector). Same word-avoidance rule.

```ts
import OpenAI from "openai";

const client = new OpenAI();

export async function flakyCompletion(text: string): Promise<string> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const r = await client.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: text }],
      });
      return r.choices[0]?.message?.content ?? "";
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}
```

This fixture intentionally omits any pacing — `RETRY_PATTERN` matches (`attempt`, `retry`-via-loop), `BACKOFF_GUARD` doesn't, `CONCURRENCY_GUARD` doesn't. After the fix, this fixture must still produce a `rate_limit` finding.

- [ ] **Step 2: Write the failing tests**

Create `src/test/c1-pr4-rate-limit-tightening.test.ts`. Mirror the established pattern from `src/test/c1-pr3-batch-tightening.test.ts` (same imports, same `buildFixtureAccess`, same `run` harness):

```ts
import assert from "node:assert/strict";
import * as path from "node:path";
import * as fs from "node:fs";
import { setWasmDir } from "../ast/parser-loader";
import { detectLocalWastePatternsInFiles, type ScanFileAccess, type ScanInputFile } from "../scanner/core-scanner";

const WASM_DIR = path.join(__dirname, "..", "..", "assets", "parsers");
setWasmDir(WASM_DIR);

async function run(name: string, fn: () => void | Promise<void>): Promise<void> {
  try { await fn(); console.log(`PASS ${name}`); }
  catch (err) { console.error(`FAIL ${name}`); throw err; }
}

function buildFixtureAccess(fixtureDir: string, fileNames: string[]): ScanFileAccess {
  const files: ScanInputFile[] = fileNames.map((name) => ({
    absolutePath: path.join(fixtureDir, name),
    relativePath: name,
  }));
  return {
    files,
    readFile: async (absolutePath: string) => fs.readFileSync(absolutePath, "utf-8"),
  };
}

(async () => {
  const projectRoot = path.resolve(__dirname, "..", "..");
  const fixtureDir = path.resolve(projectRoot, "src", "test", "fixtures", "c1-pr4");

  await run("TS withRetry() wrapper does NOT trigger rate_limit finding", async () => {
    const access = buildFixtureAccess(fixtureDir, ["ts_retry_wrapper.ts"]);
    const findings = await detectLocalWastePatternsInFiles(access);
    const rateLimitFindings = findings.filter((f) => f.type === "rate_limit");
    assert.equal(
      rateLimitFindings.length, 0,
      `expected 0 rate_limit findings around withRetry() wrapper, got ${rateLimitFindings.length}: ${JSON.stringify(rateLimitFindings.map((f) => ({ file: f.affectedFile, line: f.line, ev: f.evidence })))}`
    );
  });

  await run("TS bare retry loop without backoff STILL triggers rate_limit finding", async () => {
    const access = buildFixtureAccess(fixtureDir, ["ts_retry_loop.ts"]);
    const findings = await detectLocalWastePatternsInFiles(access);
    const rateLimitFindings = findings.filter((f) => f.type === "rate_limit");
    assert.ok(
      rateLimitFindings.length >= 1,
      `expected at least 1 rate_limit finding on bare retry loop, got ${rateLimitFindings.length}: full findings = ${JSON.stringify(findings.map((f) => ({ type: f.type, file: f.affectedFile, line: f.line })))}`
    );
  });
})().catch((err) => { console.error(err); process.exit(1); });
```

Append to `package.json` `scripts.test:scanner`, just before the trailing `pre-a-scanfiles-resolution` entry:

```
 && node dist-test/test/c1-pr4-rate-limit-tightening.test.js
```

- [ ] **Step 3: Confirm both tests fail in the expected way**

Run:

```bash
npm test
```

Expected output for the new file:
- `FAIL TS withRetry() wrapper does NOT trigger rate_limit finding` — current detector fires here (RETRY_PATTERN matches "./retry", BACKOFF_GUARD doesn't match).
- `PASS TS bare retry loop without backoff STILL triggers rate_limit finding` — existing detector already fires; the test just locks in the behavior we want to preserve.

If the bare-retry-loop test FAILS too, stop and re-examine — the fixture must trip the unmodified detector. Compile errors are the most common cause; check `dist-test/test/` for the JS output.

- [ ] **Step 4: Apply the fix**

Open `src/ast/waste/concurrency-detector.ts`. Replace lines 26-28 verbatim:

```ts
/** Exponential backoff / retry pacing signals. */
const BACKOFF_GUARD =
  /\b(?:backoff|jitter|retryAfter|exponential|retryDelay|retryAfterMs)\b|\b(?:sleep|delay|withRetry|with_retry|pRetry|asyncRetry|retryAsync|withBackoff|with_backoff)\s*\(/i;
```

Two alternation halves:
- Bare-word backoff terms with both-sided word boundaries (`backoff`, `jitter`, `retryAfter`, `exponential`, `retryDelay`, `retryAfterMs`).
- Function-call patterns (`sleep(`, `delay(`, and the six wrapper-helper names) anchored with a leading `\b` and a trailing literal `\(` — no trailing `\b` (parentheses are non-word chars and the original ad-hoc `\b` after `\(` never anchored meaningfully).

This change has two intended effects:
- `withRetry(() => ...)` in the window now matches → `BACKOFF_GUARD.test(win)` is true → `detectRetryStorm` returns null at the suppression check (file `concurrency-detector.ts:200`).
- The semantics of `sleep(` and `delay(` are unchanged (still match the same call shape).

- [ ] **Step 5: Confirm the new tests pass and `npm test` is fully green**

Run:

```bash
npm test
```

Expected: both new tests `PASS`, and the existing suite remains green (current main is 357/357). If any pre-existing test fails, the regex split mishandled one of the originals — re-check `sleep` / `delay` semantics by inspecting the file in question.

- [ ] **Step 6: Confirm benchmark shows rate_limit row collapsed**

Run:

```bash
npm run benchmark
```

In the `Per finding type:` section, `rate_limit` should now show `TP 0  FP 0  FN 0` — or disappear entirely (when a row collapses to all-zero, `findingMetricsByType` typically drops it; either outcome satisfies the goal). `bedrock-raw-fetch` per-fixture line should show one fewer FP: `find P/R` rises and the FP endpoint count drops from `2/6/2` toward `2/5/2`. The benchmark process will still exit non-zero if `detection precision` slipped (stale baseline), so a fail-exit here is expected — proceed.

- [ ] **Step 7: Commit**

```bash
git add src/ast/waste/concurrency-detector.ts src/test/fixtures/c1-pr4/ts_retry_wrapper.ts src/test/fixtures/c1-pr4/ts_retry_loop.ts src/test/c1-pr4-rate-limit-tightening.test.ts package.json
git commit -m "$(cat <<'EOF'
fix(c1/rate_limit): treat withRetry/pRetry wrappers as backoff guards

detectRetryStorm fires whenever RETRY_PATTERN matches in the ±8-line
window and BACKOFF_GUARD doesn't — but conventional retry helpers
(withRetry, pRetry, asyncRetry, withBackoff and snake_case variants)
encapsulate backoff inside the wrapper. The current regex only
recognizes the raw pacing primitives (sleep/delay/jitter/exponential),
so any call routed through `withRetry(() => sdk.call(...))` got flagged
as a rate-limit risk even though the wrapper is the textbook
mitigation.

Extends BACKOFF_GUARD with the six wrapper-function names anchored as
call sites (`name\s*\(`), so the suppression check at
concurrency-detector.ts:200 catches them. The bare-retry-loop case
(no wrapper, no pacing) continues to fire — covered by the new
positive fixture.

Drops the rate_limit row from findingMetricsByType (was TP 0 / FP 1 /
FN 0; now zero emissions).
EOF
)"
```

---

### Task PR4.2 — Skip cross-file matches in `detectSequential` (TDD)

Files:
- Modify: `src/ast/waste/batch-detector.ts`
- Create: `src/test/fixtures/c1-pr4/ts_wrapper_sequential.ts`
- Create: `src/test/c1-pr4-batch-residual.test.ts`
- Modify: `package.json` (`scripts.test:scanner`)

- [ ] **Step 1: Create the TS fixture**

`src/test/fixtures/c1-pr4/ts_wrapper_sequential.ts` — mirrors the live FP at `bedrock-raw-fetch/src/index.ts:5`. The fixture needs a project-local wrapper that cross-file resolution will tag with a provider; the simplest shape is a thin re-export from a sibling file. Avoid the bare words `cache`, `batch`, `backoff`, `jitter`, `exponential`, and `sleep(` in any source position.

```ts
// helper file used by the fixture below — declare via a side file to force cross-file resolution
import OpenAI from "openai";
const client = new OpenAI();
export async function handleApi(arg: { path: string; body: unknown }): Promise<string> {
  const r = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: JSON.stringify(arg) }],
  });
  return r.choices[0]?.message?.content ?? "";
}

export async function main(): Promise<void> {
  const summary = await handleApi({
    path: "/summarize",
    body: { text: "first request" },
  });
  console.log(summary);

  const answer = await handleApi({
    path: "/answer",
    body: { text: "second request" },
  });
  console.log(answer);
}
```

Both `await handleApi(...)` calls live in `main()`, share the resolved provider `openai`, and the resolver flags them with `crossFile: true` (mirroring the live bedrock case). The cross-file plumbing landed pre-A3/A5, so this fixture exercises the same code path on every commit since `39ee4d0`.

NOTE: keep the helper and the consumer in the **same file**. The scanner's cross-file resolver is invoked when matches are propagated across files, but propagation within a single file also flags `crossFile: true` when a call expression's resolved methodChain originates from a function body defined elsewhere in the file. If the scanner's resolver requires multiple files to set `crossFile: true`, split the fixture into two files (`ts_wrapper_sequential_main.ts` + `ts_wrapper_sequential_helper.ts`) and pass both in the test's `buildFixtureAccess([...])`. Verify by running Step 3 first; if the test passes on unmodified code, the FP isn't reproducing — switch to the two-file layout and re-run.

- [ ] **Step 2: Write the failing test**

Create `src/test/c1-pr4-batch-residual.test.ts`:

```ts
import assert from "node:assert/strict";
import * as path from "node:path";
import * as fs from "node:fs";
import { setWasmDir } from "../ast/parser-loader";
import { detectLocalWastePatternsInFiles, type ScanFileAccess, type ScanInputFile } from "../scanner/core-scanner";

const WASM_DIR = path.join(__dirname, "..", "..", "assets", "parsers");
setWasmDir(WASM_DIR);

async function run(name: string, fn: () => void | Promise<void>): Promise<void> {
  try { await fn(); console.log(`PASS ${name}`); }
  catch (err) { console.error(`FAIL ${name}`); throw err; }
}

function buildFixtureAccess(fixtureDir: string, fileNames: string[]): ScanFileAccess {
  const files: ScanInputFile[] = fileNames.map((name) => ({
    absolutePath: path.join(fixtureDir, name),
    relativePath: name,
  }));
  return {
    files,
    readFile: async (absolutePath: string) => fs.readFileSync(absolutePath, "utf-8"),
  };
}

(async () => {
  const projectRoot = path.resolve(__dirname, "..", "..");
  const fixtureDir = path.resolve(projectRoot, "src", "test", "fixtures", "c1-pr4");

  await run("TS two cross-file wrapper calls in same function do NOT trigger batch finding", async () => {
    const access = buildFixtureAccess(fixtureDir, ["ts_wrapper_sequential.ts"]);
    const findings = await detectLocalWastePatternsInFiles(access);
    const batchFindings = findings.filter((f) => f.type === "batch");
    assert.equal(
      batchFindings.length, 0,
      `expected 0 batch findings on cross-file wrapper sequence, got ${batchFindings.length}: ${JSON.stringify(batchFindings.map((f) => ({ file: f.affectedFile, line: f.line, ev: f.evidence })))}`
    );
  });
})().catch((err) => { console.error(err); process.exit(1); });
```

Append to `package.json` `scripts.test:scanner`, right after the PR4.1 line:

```
 && node dist-test/test/c1-pr4-batch-residual.test.js
```

- [ ] **Step 3: Confirm the new test fails**

Run:

```bash
npm test
```

Expected: `FAIL TS two cross-file wrapper calls in same function do NOT trigger batch finding`. Current `detectSequential` clusters the two cross-file matches in `main()` and emits.

If it PASSES, the fixture is not reproducing the FP — either the resolver isn't setting `crossFile: true` on this shape, or the call isn't reaching `detectSequential` because `frequency !== "single"`. Diagnose by adding a temporary `console.log(matches.map(m => ({line:m.line, provider:m.provider, crossFile:m.crossFile, frequency:m.frequency})))` inside `detectSequential` and re-running. If `crossFile` is unset, split the fixture into two files as noted in Task PR4.2 Step 1 and re-test. Revert the console.log before continuing.

- [ ] **Step 4: Apply the fix**

Open `src/ast/waste/batch-detector.ts`. Locate `detectSequential` (line 201) and change the bucketing pre-filter on line 207:

Before:
```ts
const providerMatches = matches.filter(isRealProviderMatch);
```

After:
```ts
// Skip resolver-echoed matches: when cross-file resolution propagates a
// provider attribution onto a project-local wrapper call (e.g.
// `handleApi({path:"/x"})`), two such calls in the same function look like
// duplicate work but are semantically distinct operations dispatched
// through one wrapper. Direct SDK calls (`crossFile` falsy) keep firing.
const providerMatches = matches
  .filter(isRealProviderMatch)
  .filter((m) => !m.crossFile);
```

Place the comment block immediately above the `providerMatches` declaration so the rationale travels with the filter.

No other lines in `detectSequential` change.

- [ ] **Step 5: Confirm tests pass and no PR-3 regression**

Run:

```bash
npm test
```

Expected:
- New test from Step 2 now `PASS`.
- All four PR-3 tests in `c1-pr3-batch-tightening.test.js` still `PASS` (the `ts_same_function.ts` and `py_same_function.py` regression fixtures use direct SDK matches with `crossFile` unset).
- All other tests green.

Total expected count rises from 357 to 360 (357 main + 2 from PR4.1 + 1 from PR4.2).

- [ ] **Step 6: Confirm benchmark shows batch row collapsed**

Run:

```bash
npm run benchmark
```

Expected per-type:
```
batch                  TP 0  FP 0  FN 1   precision   N/A   recall   0.0%
rate_limit             (row absent or all-zero)
n_plus_one             TP 1  FP 0  FN 0   precision 100.0%  recall 100.0%
unbatched_parallel     TP 0  FP 0  FN 1   precision 100.0%  recall   0.0%
```

Global metrics expected: `findingPrecision` rises from 33.33% to 50.00% (1 TP / 2 emissions = `n_plus_one` TP + `flask-mixed-providers` n_plus_one TP = same 1 TP; emissions drop from 3 to 1 or 2). Per-fixture `bedrock-raw-fetch` line should improve to roughly `find P/R 100/N/A` (no finding emitted from this fixture at all).

If `findingPrecision` does NOT rise to ≥50%, an emission is still leaking. Re-run with `--report /tmp/pr4.json` and inspect.

- [ ] **Step 7: Commit**

```bash
git add src/ast/waste/batch-detector.ts src/test/fixtures/c1-pr4/ts_wrapper_sequential.ts src/test/c1-pr4-batch-residual.test.ts package.json
git commit -m "$(cat <<'EOF'
fix(c1/batch): skip cross-file matches in detectSequential

PR-3's (provider, enclosingFunction) bucketing reduced the batch FP
cluster from 9 to 1. The residual emission — two `await handleApi(...)`
calls in `main()` in bedrock-raw-fetch/src/index.ts — comes from
cross-file resolution echoing the same provider onto both wrapper
calls. The user wrote two distinct semantic operations (different URL
paths); Promise.all'ing them isn't the right suggestion.

The resolver flags these matches with `crossFile: true`. Direct SDK
calls (e.g. `client.chat.completions.create(...)` recognized at the
call site) have `crossFile` falsy and continue to cluster. Adds a
filter to detectSequential's input so resolver-echoed matches don't
participate in sequential-batching detection.

PR-3 regression fixtures (`ts_same_function.ts`, `py_same_function.py`)
still emit — they use direct SDK matches.

Drops the batch row to zero emissions (was TP 0 / FP 1 / FN 1; now
TP 0 / FP 0 / FN 1). The remaining FN at
flask-mixed-providers/src/providers/anthropic_helper.py:11 is out of
scope; tracked for PR-5.
EOF
)"
```

---

### Task PR4.3 — Refresh `benchmark/baseline.json`

Files:
- Modify: `benchmark/baseline.json`

- [ ] **Step 1: Run the benchmark in update mode**

```bash
npm run benchmark -- --update-baseline
```

This invokes `node dist-test/benchmark/runner.js --update-baseline`, which overwrites `benchmark/baseline.json` with the current per-metric and per-finding-type numbers and prints the updated report.

- [ ] **Step 2: Verify the baseline diff matches expectations**

```bash
git diff benchmark/baseline.json
```

Expected diff (numeric values are approximate — confirm sign and magnitude, not exact decimals):

```diff
-  "detectionPrecision": 0.3626...
+  "detectionPrecision": 0.3535...     # PR #110 net effect, was already current

-  "detectionRecall": 0.4853...
+  "detectionRecall": 0.5147...        # PR #110 recall gain

-  "providerAttributionAccuracy": 0.8214...
+  "providerAttributionAccuracy": 0.8276... # PR #110 attribution gain

-  "findingPrecision": 0.3333...
+  "findingPrecision": 0.5             # PR-4 effect: 1 TP / 2 emissions

   "findingMetricsByType": {
     "n_plus_one": { "truePositives": 1, "falsePositives": 0, "falseNegatives": 0, "precision": 1, "recall": 1 },
-    "batch":      { "truePositives": 0, "falsePositives": 1, "falseNegatives": 1, ... },
-    "rate_limit": { "truePositives": 0, "falsePositives": 1, "falseNegatives": 0, ... },
+    "batch":      { "truePositives": 0, "falsePositives": 0, "falseNegatives": 1, "precision": 0, "recall": 0 },
     "unbatched_parallel": { "truePositives": 0, "falsePositives": 0, "falseNegatives": 1, ... }
   }
```

`rate_limit` may either disappear from the map (zero emissions, zero expectations) or remain with all-zero fields. Either is acceptable.

If the diff shows ANY metric dropping below the post-PR-4 actuals (e.g. recall regressing), STOP — don't commit the baseline. Re-run Task PR4.1 / Task PR4.2 verification steps to find what regressed.

- [ ] **Step 3: Confirm the next benchmark run is green**

```bash
npm run benchmark
```

Expected exit code: 0. The report should show every `Δ` at `+0.00pp` (we just refreshed the baseline).

- [ ] **Step 4: Commit**

```bash
git add benchmark/baseline.json
git commit -m "$(cat <<'EOF'
chore(benchmark): refresh baseline to post-#110 + post-PR-4 actuals

baseline.json had drifted since PR #110 (A3/A5 resolver-recall)
landed without a refresh — every PR opened against main has been
seeing a stale −0.91pp detection-precision delta on first run.
PR-4's detector fixes also collapse the rate_limit and batch rows
in findingMetricsByType.

Snapshot:
  Detection precision   36.26% → 35.35% (Δ −0.91pp from #110)
  Detection recall      48.53% → 51.47% (Δ +2.94pp from #110)
  Provider attribution  82.14% → 82.76% (Δ +0.62pp from #110)
  Finding precision     33.33% → 50.00% (Δ +16.67pp from PR-4)
  Finding recall        33.33% → 33.33% (unchanged)

Per-type:
  rate_limit  TP 0 / FP 1 → row removed (zero emissions)
  batch       TP 0 / FP 1 / FN 1 → TP 0 / FP 0 / FN 1
  n_plus_one  unchanged (TP 1 / FP 0 / FN 0)
  unbatched_parallel  unchanged by design (TP 0 / FP 0 / FN 1)

`unbatched_parallel` stays at 0% recall because the one expected
TP — Promise.all over Array.from({length: this.n}) in
langchain-openai/src/libs/langchain-openai/src/tools/dalle.ts — is
currently suppressed by the BOUNDED_REPLICATION guard that PR #110
introduced for the OpenAI images.generate semantic-batchCapable
case. Recovering it without re-introducing the FP that motivated
the guard is C2/C3 work, not C1.
EOF
)"
```

---

## Self-review

**1. Spec coverage** — every #83 acceptance criterion in the table above maps to a task. Two FPs → Tasks PR4.1, PR4.2. Baseline refresh → Task PR4.3. No new doc churn needed; PR-2 already wrote the C1 calibration narrative.

**2. Placeholder scan** — every code step has the actual code. Every commit message is verbatim. Every regex change is fully written out. No TBDs, no "similar to" cross-references.

**3. Type consistency** — `LocalWasteFinding`, `AstCallMatch`, `ScanFileAccess`, `ScanInputFile`, `detectLocalWastePatternsInFiles` are the same identifiers used in PR-2 and PR-3 test files (verified by reading `src/test/c1-pr3-batch-tightening.test.ts`). `BACKOFF_GUARD` and `detectSequential` names match the source files at HEAD. The new regex matches the case-insensitive `i` flag the original carried.

**4. Risk hotspot review:**
- `n_plus_one` (100/100): untouched. PR-4.1 edits `concurrency-detector.ts` (rate_limit/concurrency paths), PR-4.2 edits `batch-detector.ts` (`detectSequential` only — `detectNPlusOne` is a separate function). No regression vector.
- `unbatched_parallel` (recall 0%, P 100%): untouched. `detectUnboundedConcurrency` is the emitter; PR-4 doesn't modify it.
- `cache` (zero emissions): untouched. `detectCacheFinding` lives in `local-waste-detector.ts`; PR-4 doesn't touch that file.

**5. Test-file granularity:** two new test files mirror PR-3's split (one per detector). Both register in `package.json` `scripts.test:scanner`. Per-task TDD (red → fix → green) matches PR-2 and PR-3 layout.

**6. Commit count:** 3 commits — one per task. Maps cleanly to a small-PR review.

---

## Execution handoff

Plan saved to `docs/superpowers/plans/2026-05-15-c1-pr4-rate-limit-batch-tightening.md` (uncommitted; the executing session commits it during Phase 3).

Worktree: `/home/andresl/Projects/recost/extension-c1-pr4`, branch `claude/c1-pr4-rate-limit-batch`, off `origin/main` at `75ea6b4`.
