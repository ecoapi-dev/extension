# C1 PR-3 — Tighten the `batch` waste detector

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` to implement this plan. PR-3 of issue #83. Builds on PR-1 (#106 measurement infra) and PR-2 (#108 cache detector).

**Goal:** Drop the `batch` detector's emissions from 9 FPs / 0 TPs / 1 FN to ≤2 FPs without touching the 1 expected positive (which is currently a recall miss anyway). Eliminate the dominant FP class — calls grouped across different enclosing functions — without redesigning the detector.

**Why batch next:** After PR-2 tightened `cache`, `batch` is the only remaining detector with a substantial sample (9 emissions) and 0% precision. The fix shape is mechanical and well-scoped. The per-type gate (live since #106) measures any regression directly.

---

## Investigation (already done)

Ran the live scanner against all 7 corpus fixtures and captured every `batch` finding. **All 9 FPs share a single root cause: the detector groups calls by provider alone, ignoring whether they live in the same function.** Calls in two different functions of the same file can never be batched together — they execute on independent code paths.

### TypeScript AST detector — 7 FPs from `detectSequential()`

| Fixture | File | Line | Cluster | Functions |
|---|---|---|---|---|
| bedrock-raw-fetch | `src/answer.ts` | 9 | lines 9, 13 | `answerQuestion`, `answerViaConverse` (2 different) |
| bedrock-raw-fetch | `src/bedrock-client.ts` | 29 | lines 29, 40 | `invokeClaude`, `converseWithClaude` (2 different) |
| bedrock-raw-fetch | `src/index.ts` | 5 | lines 5, 5, 11, 11 | all in `main()` (cross-file resolver inflates count via wrapper expansion) |
| bedrock-raw-fetch | `src/raw-fetch-client.ts` | 28 | lines 28, 45 | `invokeViaRawFetch`, `converseViaRawFetch` (2 different) |
| bedrock-raw-fetch | `src/routes/api.ts` | 22 | lines 21, 22, 28, 29 | all in `handleApi()` but inside mutually-exclusive `if/else` branches |
| bedrock-raw-fetch | `src/summarize.ts` | 10 | lines 10, 15 | `summarizeShort`, `summarizeLong` (2 different) |
| raw-fetch-elevenlabs | `src/tts-service.ts` | 21 | lines 21, 30 | `transcribe`, `listVoices` (2 different) |

**Root cause** — `src/ast/waste/batch-detector.ts` line 200-207:

```ts
const byProvider = new Map<string, AstCallMatch[]>();
for (const m of providerMatches) {
  if (m.frequency !== "single" || m.loopContext) continue;
  if (!m.provider) continue;
  const group = byProvider.get(m.provider) ?? [];   // ← bucketed by provider only
  group.push(m);
  byProvider.set(m.provider, group);
}
```

### Python detector — 2 FPs from `detectSequentialBatching()`

| Fixture | File | First line | Cluster | Functions |
|---|---|---|---|---|
| flask-mixed-providers | `src/providers/anthropic_helper.py` | 7 | lines 7, 11, 20 | line 7 = module-level `Anthropic()` constructor; lines 11 + 20 in `summarize` and `summarize_with_style` (2 different) |
| openai-cookbook | `src/chat_completions_basic.py` | 19 | lines 19, 34, 46 | `simple_completion`, `pirate_explainer`, `few_shot_translation` (3 different) |

**Root cause** — `src/scanner/python-waste-detector.ts` line 229-236, same pattern:

```ts
const byProvider = new Map<string, ClassifiedMatch[]>();
for (const classified of matches) {
  if (!NON_LOOP_FREQUENCIES.has(classified.match.frequency)) continue;
  const group = byProvider.get(classified.providerKey) ?? [];   // ← bucketed by provider only
  group.push(classified);
  byProvider.set(classified.providerKey, group);
}
```

The Python detector additionally requires `cluster.length >= 3` after a 30-line proximity grouping pass, but the proximity check doesn't compensate for cross-function calls in small files.

### Expected positive (out of scope to fix now)

`flask-mixed-providers/expected.json` lists exactly one `batch` TP at `src/providers/anthropic_helper.py:11`. The detector currently emits at line 7 (module-level constructor caught by the cluster), which is >±2 lines off → counted as both a FP (line 7 emission) and a FN (expected line 11 not matched). After this PR, the line-7 FP disappears, leaving the FN unchanged — that's a finding-precision win and a finding-recall no-op. Recall improvement requires a separate fix to the cluster-line anchor, scoped out of this PR.

---

## Acceptance criteria for PR-3

- [ ] TS `detectSequential()` emits ZERO findings on `answer.ts`, `bedrock-client.ts`, `raw-fetch-client.ts`, `summarize.ts`, `tts-service.ts` (5 files, 7→2 FPs after the same-function fix).
- [ ] Python `detectSequentialBatching()` emits ZERO findings on `anthropic_helper.py` and `chat_completions_basic.py` (2 files, 2→0 FPs).
- [ ] Synthetic positive-test fixtures still produce batch findings (the detector isn't broken outright):
  - TS: 2 same-provider sequential awaits in the SAME function → finding emitted.
  - Python: 3 same-provider calls in the SAME function within ≤30 lines → finding emitted.
- [ ] `npm test` passes (currently 353/353 on main; will be 357/357 with 4 new tests).
- [ ] `npm run benchmark` exits 0; per-type gate doesn't fail. Global `findingPrecision` rises from ~9.09% to ~25% (1 TP / 4 emissions instead of 1/11).
- [ ] `benchmark/baseline.json` updated; `batch` collapses to TP=0/FP=2/FN=1 (or similar) — the 2 remaining FPs (`index.ts` cross-file expansion + `routes/api.ts` mutually-exclusive branches) are accepted, documented, and tracked as PR-4 follow-ups.

The remaining 2 FPs are NOT addressed in this PR because:
- `index.ts` requires de-duping cross-file resolver expansion within the same line (separate concern, touches the resolver pipeline)
- `routes/api.ts` requires mutually-exclusive-branch awareness (no AST signal for control-flow branches today)

Both warrant their own PRs once the corpus has more positive cases to calibrate against.

---

## Tasks

### Task C1-PR3.1 — Fix TS `detectSequential()` (TDD)

**Files:**
- Modify: `src/ast/waste/batch-detector.ts`
- Create: `src/test/fixtures/c1-pr3/ts_diff_functions.ts`
- Create: `src/test/fixtures/c1-pr3/ts_same_function.ts`
- Create: `src/test/c1-pr3-batch-tightening.test.ts`
- Modify: `package.json` `test:scanner` script

- [ ] **Step 1: Create the two TS fixtures**

`src/test/fixtures/c1-pr3/ts_diff_functions.ts` — two openai calls in two different functions, should NOT fire (mirrors answer.ts):

```ts
import OpenAI from "openai";
const client = new OpenAI();

export async function summarize(text: string): Promise<string> {
  const r = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: `Summarize: ${text}` }],
  });
  return r.choices[0].message.content ?? "";
}

export async function translate(text: string, lang: string): Promise<string> {
  const r = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: `Translate to ${lang}: ${text}` }],
  });
  return r.choices[0].message.content ?? "";
}
```

`src/test/fixtures/c1-pr3/ts_same_function.ts` — two openai calls in the SAME function, SHOULD still fire (positive case):

```ts
import OpenAI from "openai";
const client = new OpenAI();

export async function dualPrompts(textA: string, textB: string): Promise<[string, string]> {
  const a = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: textA }],
  });
  const b = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: textB }],
  });
  return [a.choices[0].message.content ?? "", b.choices[0].message.content ?? ""];
}
```

(Avoid the literal word "batch" in either fixture — `BATCH_GUARD` regex matches `\bbatch\b` in surrounding source and would suppress the finding.)

- [ ] **Step 2: Write failing tests**

Create `src/test/c1-pr3-batch-tightening.test.ts`. Use the same `detectLocalWastePatternsInFiles` API + `buildFixtureAccess` pattern as `src/test/c1-pr2-cache-tightening.test.ts`:

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
  const fixtureDir = path.resolve(projectRoot, "src", "test", "fixtures", "c1-pr3");

  await run("TS two openai calls in DIFFERENT functions do NOT trigger batch finding", async () => {
    const access = buildFixtureAccess(fixtureDir, ["ts_diff_functions.ts"]);
    const findings = await detectLocalWastePatternsInFiles(access);
    const batchFindings = findings.filter(f => f.type === "batch");
    assert.equal(
      batchFindings.length, 0,
      `expected 0 batch findings on cross-function calls, got ${batchFindings.length}: ${JSON.stringify(batchFindings.map(f => ({ file: f.affectedFile, line: f.line, ev: f.evidence })))}`
    );
  });

  await run("TS two openai calls in the SAME function STILL trigger batch finding", async () => {
    const access = buildFixtureAccess(fixtureDir, ["ts_same_function.ts"]);
    const findings = await detectLocalWastePatternsInFiles(access);
    const batchFindings = findings.filter(f => f.type === "batch");
    assert.ok(
      batchFindings.length >= 1,
      `expected at least 1 batch finding on same-function calls, got ${batchFindings.length}: full findings = ${JSON.stringify(findings.map(f => ({ type: f.type, file: f.affectedFile, line: f.line })))}`
    );
  });
})().catch((err) => { console.error(err); process.exit(1); });
```

Append to `package.json` `test:scanner`:
```
 && node dist-test/test/c1-pr3-batch-tightening.test.js
```

Compile + run BEFORE the fix to confirm test 1 FAILS (cross-function fires today). Test 2 should PASS today (same-function already produces a finding — that's the recall we're preserving).

- [ ] **Step 3: Apply the fix**

In `src/ast/waste/batch-detector.ts` `detectSequential()` (line 191-241), change the bucketing key from `m.provider` to a composite of `provider + enclosingFunction`. `AstCallMatch.enclosingFunction` is `string | null` (top-level scope = null; calls there shouldn't cluster with calls inside functions either).

```ts
function detectSequential(
  matches: AstCallMatch[],
  source: string,
  filePath: string,
  isTestLike: boolean
): LocalWasteFinding[] {
  const providerMatches = matches.filter(isRealProviderMatch);
  const byBucket = new Map<string, AstCallMatch[]>();
  for (const m of providerMatches) {
    if (m.frequency !== "single" || m.loopContext) continue;
    if (!m.provider) continue;
    // Bucket by (provider, enclosingFunction): calls in different functions
    // can't be batched together — they execute on independent code paths.
    const fnKey = m.enclosingFunction ?? "<module>";
    const key = `${m.provider}::${fnKey}`;
    const group = byBucket.get(key) ?? [];
    group.push(m);
    byBucket.set(key, group);
  }

  const findings: LocalWasteFinding[] = [];

  for (const [key, group] of byBucket) {
    if (group.length < 2) continue;
    // Dedupe by line — cross-file resolver expansion can produce multiple
    // matches at the same call line for one user-written call.
    const uniqueLines = new Set(group.map((m) => m.line));
    if (uniqueLines.size < 2) continue;
    const provider = key.split("::")[0];
    const firstMatch = group[0];
    if (hasGuardInWindow(source, firstMatch.line, CONCURRENCY_GUARD)) continue;
    if (hasGuardInWindow(source, firstMatch.line, BATCH_GUARD)) continue;

    let score = 1 + Math.min(uniqueLines.size - 1, 3);
    if (isTestLike) score -= 1;
    let confidence = 0.45 + Math.min(score, 5) * 0.06;
    if (isTestLike) confidence -= 0.10;
    confidence = clamp(confidence);
    if (confidence < 0.35) continue;

    findings.push({
      id: `local-batch-seq-${filePath}:${firstMatch.line}`,
      type: "batch" as SuggestionType,
      severity: scoreToSeverity(score),
      confidence,
      description: `${uniqueLines.size} sequential ${provider} calls could be fired in parallel with Promise.all to reduce total latency.`,
      affectedFile: filePath,
      line: firstMatch.line,
      evidence: [
        `${uniqueLines.size} independent calls to "${provider}" detected in this file (lines ${[...uniqueLines].sort((a,b)=>a-b).join(", ")}).`,
        "Wrapping independent awaits in Promise.all reduces wall-clock time proportional to the slowest call.",
      ],
    });
  }

  return findings;
}
```

Two changes from the original:
1. **Bucket key includes enclosingFunction** (the main fix).
2. **Dedupe by line** before scoring + emitting — handles cross-file resolver duplicates (the index.ts edge case from the bedrock-raw-fetch fixture). Also deduplicates the line list shown in the evidence string.

Don't touch `detectBatch()` or `detectNPlusOne()` — those gate on `frequency`/`loopContext` and are independent.

- [ ] **Step 4: Verify**

```bash
cd /home/andresl/Projects/recost/extension-c1-pr3
npm test 2>&1 | tail -30
```

Both new tests PASS. Existing `ast-batch-detector.test.ts` still PASSES.

---

### Task C1-PR3.2 — Fix Python `detectSequentialBatching()` (TDD)

**Files:**
- Modify: `src/scanner/python-waste-detector.ts`
- Create: `src/test/fixtures/c1-pr3/py_diff_functions.py`
- Create: `src/test/fixtures/c1-pr3/py_same_function.py`
- Modify: `src/test/c1-pr3-batch-tightening.test.ts` (append)

- [ ] **Step 1: Create the two Python fixtures**

`src/test/fixtures/c1-pr3/py_diff_functions.py` — three anthropic calls in three different functions, should NOT fire:

```python
"""Negative case: three calls in three different functions are not batchable."""
import anthropic

_client = anthropic.Anthropic()

def summarize(text: str) -> str:
    return _client.messages.create(
        model="claude-3-haiku-20240307",
        max_tokens=512,
        messages=[{"role": "user", "content": f"Summarize: {text}"}],
    ).content[0].text

def translate(text: str, lang: str) -> str:
    return _client.messages.create(
        model="claude-3-haiku-20240307",
        max_tokens=512,
        messages=[{"role": "user", "content": f"Translate to {lang}: {text}"}],
    ).content[0].text

def explain(text: str) -> str:
    return _client.messages.create(
        model="claude-3-haiku-20240307",
        max_tokens=512,
        messages=[{"role": "user", "content": f"Explain: {text}"}],
    ).content[0].text
```

`src/test/fixtures/c1-pr3/py_same_function.py` — three anthropic calls in the SAME function, SHOULD fire (positive case):

```python
"""Positive case: three calls in the same function should be batched concurrently."""
import anthropic

_client = anthropic.Anthropic()

def triple_summarize(a: str, b: str, c: str) -> tuple[str, str, str]:
    ra = _client.messages.create(model="claude-3-haiku-20240307", max_tokens=256, messages=[{"role": "user", "content": a}])
    rb = _client.messages.create(model="claude-3-haiku-20240307", max_tokens=256, messages=[{"role": "user", "content": b}])
    rc = _client.messages.create(model="claude-3-haiku-20240307", max_tokens=256, messages=[{"role": "user", "content": c}])
    return ra.content[0].text, rb.content[0].text, rc.content[0].text
```

Avoid literal "batch" in either fixture.

- [ ] **Step 2: Append failing tests**

Add to `src/test/c1-pr3-batch-tightening.test.ts` inside the existing IIFE:

```ts
await run("Python three anthropic calls in DIFFERENT functions do NOT trigger batch finding", async () => {
  const access = buildFixtureAccess(fixtureDir, ["py_diff_functions.py"]);
  const findings = await detectLocalWastePatternsInFiles(access);
  const batchFindings = findings.filter(f => f.type === "batch");
  assert.equal(
    batchFindings.length, 0,
    `expected 0 batch findings on cross-function Python calls, got ${batchFindings.length}: ${JSON.stringify(batchFindings.map(f => ({ file: f.affectedFile, line: f.line, ev: f.evidence })))}`
  );
});

await run("Python three anthropic calls in the SAME function STILL trigger batch finding", async () => {
  const access = buildFixtureAccess(fixtureDir, ["py_same_function.py"]);
  const findings = await detectLocalWastePatternsInFiles(access);
  const batchFindings = findings.filter(f => f.type === "batch");
  assert.ok(
    batchFindings.length >= 1,
    `expected at least 1 batch finding on same-function Python calls, got ${batchFindings.length}: full findings = ${JSON.stringify(findings.map(f => ({ type: f.type, file: f.affectedFile, line: f.line })))}`
  );
});
```

- [ ] **Step 3: Apply the fix**

In `src/scanner/python-waste-detector.ts` `detectSequentialBatching()` (line 227), change the bucket key from `classified.providerKey` to `(providerKey, enclosingFunction)`. Python AST `AstCallMatch` also has `enclosingFunction: string | null`.

```ts
function detectSequentialBatching(matches: ClassifiedMatch[], lines: string[], filePath: string): LocalWasteFinding[] {
  const findings: LocalWasteFinding[] = [];
  const byBucket = new Map<string, ClassifiedMatch[]>();

  for (const classified of matches) {
    if (!NON_LOOP_FREQUENCIES.has(classified.match.frequency)) continue;
    // Bucket by (providerKey, enclosingFunction): calls in different functions
    // can't be batched together — they execute on independent code paths.
    const fnKey = classified.match.enclosingFunction ?? "<module>";
    const key = `${classified.providerKey}::${fnKey}`;
    const group = byBucket.get(key) ?? [];
    group.push(classified);
    byBucket.set(key, group);
  }

  for (const [key, group] of byBucket) {
    const providerKey = key.split("::")[0];
    const sorted = [...group].sort((a, b) => a.match.line - b.match.line);
    let start = 0;

    while (start < sorted.length) {
      let end = start;
      while (end + 1 < sorted.length && sorted[end + 1].match.line - sorted[start].match.line <= 30) {
        end += 1;
      }

      const cluster = sorted.slice(start, end + 1);
      if (cluster.length >= 3) {
        const firstLine = cluster[0].match.line;
        const lastLine = cluster[cluster.length - 1].match.line;
        const window = betweenWindow(lines, firstLine, lastLine, 5);
        if (!ASYNCIO_GATHER.test(window) && !CONCURRENCY_GUARD.test(window)) {
          findings.push(
            makeFinding(
              "batch",
              filePath,
              firstLine,
              4,
              0.73,
              `${cluster.length} sequential ${providerKey} calls appear close together and could likely be batched or awaited concurrently.`,
              [
                `${cluster.length} calls to "${providerKey}" appear within ${lastLine - firstLine} lines (${cluster.map((item) => item.match.line).join(", ")}).`,
                "No nearby asyncio.gather or concurrency limiter was detected for this call cluster.",
              ]
            )
          );
        }
        start = end + 1;
      } else {
        start += 1;
      }
    }
  }

  return findings;
}
```

The Python detector's `cluster.length >= 3` threshold is preserved — it provides a stronger signal than the TS detector's `>= 2` because Python doesn't have explicit async-await sequencing as a clear N+1 indicator.

- [ ] **Step 4: Verify**

```bash
cd /home/andresl/Projects/recost/extension-c1-pr3
npm test 2>&1 | tail -30
```

All 4 c1-pr3 tests PASS. Existing tests still PASS.

---

### Task C1-PR3.3 — Measure on the corpus + update baseline + refresh docs

- [ ] **Step 1: Full benchmark run**

```bash
cd /home/andresl/Projects/recost/extension-c1-pr3
npm run benchmark 2>&1 | tee /tmp/c1-pr3-before-update.log
```

Expected: `batch` row drops from FP=9 to FP≈2 (the 2 remaining are `index.ts` and `routes/api.ts`). Global `findingPrecision` rises from ~9.09% to ~25%.

If batch FP count is anything other than 2, investigate which fixture is still emitting and why before continuing.

- [ ] **Step 2: Update baseline**

```bash
npm run benchmark -- --update-baseline 2>&1 | tail -20
git diff benchmark/baseline.json
```

The diff should show:
- `findingPrecision` rises (~9% → ~25%)
- `findingMetricsByType.batch.falsePositives` drops from 9 to 2 (or whatever the actual count is)
- Other per-type entries unchanged

- [ ] **Step 3: Refresh `docs/accuracy/findings.md`**

Update the per-detector calibration table:
- `batch` row: TP/FP/FN to new numbers, precision %, note that PR-3 added enclosing-function gating + line dedup
- Mention that 2 remaining FPs (`index.ts` cross-file expansion, `routes/api.ts` mutually-exclusive branches) are scoped out for follow-up PRs

---

### Task C1-PR3.4 — Commit, push, open PR

- [ ] Run full `npm test` (357+ PASS) and `npm run benchmark` (exit 0) one final time.
- [ ] Stage:
  - `src/ast/waste/batch-detector.ts`
  - `src/scanner/python-waste-detector.ts`
  - `src/test/c1-pr3-batch-tightening.test.ts`
  - `src/test/fixtures/c1-pr3/*` (4 files: 2 .ts + 2 .py)
  - `package.json`
  - `benchmark/baseline.json`
  - `docs/accuracy/findings.md`
  - `docs/superpowers/plans/2026-05-13-c1-pr3-batch-detector-tightening.md`
- [ ] Commit: `fix(detection): C1 PR-3 — tighten batch detector (closes part 3 of #83)`
- [ ] Push and open PR. Body should mirror PR-2's structure: investigation table, before/after measurement table, per-detector deltas, acceptance-criteria checklist, out-of-scope follow-ups.

---

## Self-review (controller)

**Spec coverage (issue #83):**

| Acceptance criterion | Covered by | Status |
|---|---|---|
| No detector with FPR > 30% | This PR drops `batch` from 100%/9emissions to 100%/2emissions | Partial — FPR is still 100%, but sample size = 2 < gate threshold. Per-type gate skips. |
| Each detector has FPR documented | findings.md refresh in step 3 | ✓ |
| Per-detector regressions fail the build | Per-type gate live since PR-1 | ✓ |
| Documented exceptions for by-design conservative detectors | The 2 remaining FPs are documented as scope-deferred (cross-file resolver expansion + branch awareness) | ✓ |

**Risks:**

1. **Cross-file resolver duplicates index.ts.** The line-dedup mitigation reduces 4 entries → 2 unique lines, which still ≥2 → still fires. Documented as accepted FP.

2. **enclosingFunction reliability.** AST scanner sets enclosingFunction from `enclosingFunctionName(node)` — should be reliable for top-level functions and methods. Module-level calls get `null`, which buckets to "<module>". Two module-level calls to the same provider would still cluster — that's the desired behavior (e.g., a script doing two sequential top-level awaits).

3. **Anthropic_helper.py expected positive recall.** Currently FN=1 because the detector emits at line 7 (constructor) which is >±2 lines from expected line 11. After this PR, the line-7 emission disappears entirely (constructor lives in module scope; calls live in functions; no bucket has ≥3). FN stays at 1. No recall regression.

4. **Two-call same-function pattern still fires (TS) at threshold ≥2.** Intentional — sequential `await client.create()` x2 in one function IS a candidate for `Promise.all`. Some users may consider this aggressive; but the corpus has no positive case to break and the per-type gate measures the ratio.

**Out of scope (next C1 PRs):**
- Cross-file resolver line-dedup at the resolver level (not the detector level) — would also fix the routing pattern in `routes/api.ts` if branches are followed.
- `rate_limit` detector tightening (1 FP, no TPs — defer until corpus has rate-limit positive cases).
- C2 (#84) finding dedupe — depends on B3 stable IDs.
- C3 (#85) confidence + derived severity — depends on C1 fully calibrated.

---

## Execution handoff

Plan saved to `docs/superpowers/plans/2026-05-13-c1-pr3-batch-detector-tightening.md`. Worktree: `/home/andresl/Projects/recost/extension-c1-pr3` on branch `claude/c1-pr3-batch-detector` (branched from `origin/main` post-#108). `npm ci` complete; `npm run build:ext` clean.

Subagent-driven execution: one implementer dispatch per task. Spec-compliance + code-quality reviewers between each. Controller commits + opens the PR at the end.
