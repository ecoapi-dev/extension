# Wave 4 — Recall Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recover the two C1 false negatives (#117) — the Python cross-function batch FN and the DALL-E inline-parallel FN — without introducing new false positives.

**Architecture:** Two file-disjoint tracks. Track A adds a module-scope `(provider, methodChain)` second pass to the Python sequential-batching detector. Track B lifts the `BOUNDED_REPLICATION` guard from the inline-parallel detector and gives that finding a new dedicated `unbatched_parallel` type, threaded through the `SuggestionType` union and all of its consumers.

**Tech Stack:** TypeScript (strict), Node `node:test` runner, web-tree-sitter AST, the `../extension-benchmark` corpus + `npm run benchmark` gate.

**Spec:** [`docs/superpowers/specs/2026-05-30-wave4-recall-recovery-design.md`](../specs/2026-05-30-wave4-recall-recovery-design.md)

---

## Task 0: Capture the live benchmark baseline (BLOCKING — do first)

**Why:** The issue says the `batch` row is currently `0/0/1`, but the older `docs/accuracy/findings.md` calibration table records a `batch` **FP** at `bedrock-raw-fetch/src/index.ts:5`. They disagree because one is stale. If the bedrock FP still exists, recovering the FN lands the row at TP 1 / FP 1 — failing the "FP 0" bar. That FP is a corpus-labeling question, not something Track A's code fixes. We must know the truth before writing code.

**Files:** none (measurement only)

- [ ] **Step 1: Confirm the corpus is present**

Run: `ls ../extension-benchmark`
Expected: directories including `flask-mixed-providers`, `langchain-openai`, `bedrock-raw-fetch`.
If missing: `git clone https://github.com/recost-dev/extension-benchmark.git ../extension-benchmark`

- [ ] **Step 2: Run the benchmark and record the two rows**

Run: `npm run benchmark`
Capture the `findingMetricsByType` rows for `batch` and `unbatched_parallel` (TP/FP/FN each). Write the actual numbers into the PR description.

- [ ] **Step 3: Decide the bedrock FP disposition**

If the `batch` row shows an FP at `bedrock-raw-fetch/src/index.ts:5`:
- This is OUT OF SCOPE for the code in this plan. STOP and surface it to the human as a blocking decision: either (a) label the bedrock case a true positive in `../extension-benchmark/bedrock-raw-fetch/expected.json`, or (b) accept the row will read FP 1 and relax the acceptance bar.
- Do not silently absorb it.

If the `batch` row is clean (`0/0/1`): proceed to Track A.

---

## Track A — Python cross-function batch FN

**File:** `src/scanner/python-waste-detector.ts`
**Test:** `src/test/python-waste-detector.test.ts`

### Context (existing code you are extending)

`detectSequentialBatching` (currently lines ~228–282) buckets by `(providerKey, enclosingFunction)` and requires ≥3 calls within a 30-line cluster. The fixture `flask-mixed-providers/src/providers/anthropic_helper.py` has `_client.messages.create` once in `summarize` (line 11) and once in `summarize_with_style` (line 20) — two different functions, one call each, so neither bucket fires. You will add a **second pass** at module scope.

Helpers already in the file you will reuse:
- `makeFinding(type, filePath, line, riskScore, confidence, description, evidence[])`
- `NON_LOOP_FREQUENCIES` (the Set used by the primary pass's `continue` guard)
- `ASYNCIO_GATHER` and `CONCURRENCY_GUARD` regexes
- `betweenWindow(lines, firstLine, lastLine, padding)`

Each `ClassifiedMatch` exposes `match.enclosingFunction`, `match.methodChain`, `match.line`, `match.frequency`, and `providerKey`.

### Task A1: Failing test for the cross-function batch FN

- [ ] **Step 1: Write the failing test**

Add to `src/test/python-waste-detector.test.ts` (follow the existing `run(...)`/`assert` style in that file; the snippet below is the assertion logic — adapt the harness call to match how other tests in the file invoke the Python detector):

```ts
run("batch: same method across two module functions → one batch finding at earliest line", () => {
  const source = [
    "import anthropic",
    "",
    "_client = anthropic.Anthropic()",
    "",
    "def summarize(text):",
    "    msg = _client.messages.create(model='claude-3-haiku', messages=[])",
    "    return msg",
    "",
    "def summarize_with_style(text, style):",
    "    msg = _client.messages.create(model='claude-3-haiku', messages=[])",
    "    return msg",
  ].join("\n");

  const findings = runPythonWasteDetector(source, "src/providers/anthropic_helper.py");
  const batch = findings.filter((f) => f.type === "batch");
  assert.equal(batch.length, 1, "expected exactly one batch finding");
  assert.equal(batch[0].line, 6, "finding should anchor at the earliest call line");
});
```

(Use whatever existing helper the file already uses to run the detector; if it is named differently than `runPythonWasteDetector`, match the file. Line 6 here is the first `messages.create` in this synthetic source.)

- [ ] **Step 2: Run the test, verify it fails**

Run: `npx tsc -p tsconfig.scanner-tests.json && node dist-test/test/python-waste-detector.test.js`
Expected: FAIL — `expected exactly one batch finding` (got 0), because the function-scoped pass needs ≥3 calls per function.

### Task A2: Implement the module-scope second pass

- [ ] **Step 3: Add the second bucketing pass**

In `src/scanner/python-waste-detector.ts`, inside `detectSequentialBatching`, after the existing function-scoped loop builds and emits its findings, add a second pass before `return findings;`:

```ts
  // Second pass: cross-function batching. The same (providerKey, methodChain)
  // called in ≥2 distinct functions in one module is batchable even though the
  // calls live in different functions. Keying on methodChain (not just provider)
  // is the FP guard — different SDKs / different methods never merge (PR-3 trap).
  const byMethod = new Map<string, { providerKey: string; methodChain: string; matches: ClassifiedMatch[] }>();
  for (const classified of matches) {
    if (!NON_LOOP_FREQUENCIES.has(classified.match.frequency)) continue;
    const methodChain = classified.match.methodChain ?? "";
    if (!methodChain) continue;
    const key = `${classified.providerKey}::${methodChain}`;
    const bucket = byMethod.get(key) ?? { providerKey: classified.providerKey, methodChain, matches: [] };
    bucket.matches.push(classified);
    byMethod.set(key, bucket);
  }

  for (const { providerKey, methodChain, matches: group } of byMethod.values()) {
    const fns = new Set(group.map((c) => c.match.enclosingFunction ?? "<module>"));
    if (fns.size < 2) continue; // needs ≥2 distinct functions
    const sorted = [...group].sort((a, b) => a.match.line - b.match.line);
    const firstLine = sorted[0].match.line;
    const lastLine = sorted[sorted.length - 1].match.line;
    const window = betweenWindow(lines, firstLine, lastLine, 5);
    if (ASYNCIO_GATHER.test(window) || CONCURRENCY_GUARD.test(window)) continue;

    // Dedupe: skip if the function-scoped pass already emitted a batch finding at this line.
    if (findings.some((f) => f.type === "batch" && f.line === firstLine)) continue;

    findings.push(
      makeFinding(
        "batch",
        filePath,
        firstLine,
        4,
        0.7,
        `${group.length} calls to "${methodChain}" across multiple functions in this module — consolidate into a single batched call.`,
        [
          `"${methodChain}" (${providerKey}) is called in ${fns.size} functions: lines ${sorted.map((c) => c.match.line).join(", ")}.`,
          "Calls share a provider and method, so they can be batched into one request.",
        ]
      )
    );
  }
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `npx tsc -p tsconfig.scanner-tests.json && node dist-test/test/python-waste-detector.test.js`
Expected: PASS.

### Task A3: FP-guard negative test

- [ ] **Step 5: Write the negative test**

Add to `src/test/python-waste-detector.test.ts`:

```ts
run("batch: different methods across functions → NO cross-function batch finding", () => {
  const source = [
    "import anthropic",
    "_client = anthropic.Anthropic()",
    "",
    "def a(text):",
    "    return _client.messages.create(model='m', messages=[])",
    "",
    "def b(text):",
    "    return _client.completions.create(model='m', prompt=text)",
  ].join("\n");

  const findings = runPythonWasteDetector(source, "src/providers/mixed.py");
  const batch = findings.filter((f) => f.type === "batch");
  assert.equal(batch.length, 0, "different methodChains must not merge into a batch finding");
});
```

- [ ] **Step 6: Run it, verify it passes**

Run: `node dist-test/test/python-waste-detector.test.js`
Expected: PASS (the `methodChain` key keeps `messages.create` and `completions.create` in separate buckets, each with 1 function → below the ≥2 bar).

- [ ] **Step 7: Run the full scanner suite**

Run: `npm run test:scanner`
Expected: all green (no regression to existing batch/C1 tests).

- [ ] **Step 8: Commit**

```bash
git add src/scanner/python-waste-detector.ts src/test/python-waste-detector.test.ts
git commit -m "feat(wave4): cross-function batch detection in python waste detector (#117)"
```

---

## Track B — DALL-E inline-parallel FN + new `unbatched_parallel` type

This track has two parts: (1) the detector change in `batch-detector.ts`, (2) registering `unbatched_parallel` across the `SuggestionType` union and every consumer.

### Task B1: Add `unbatched_parallel` to the SuggestionType union

**Files (3 union declarations):**
- `src/analysis/types.ts:79-85`
- `webview/src/types.ts:17`
- `dashboard/src/lib/types.ts:99-105`

- [ ] **Step 1: Extend `src/analysis/types.ts`**

Change:
```ts
export type SuggestionType =
  | "cache"
  | "batch"
  | "redundancy"
  | "n_plus_one"
  | "rate_limit"
  | "concurrency_control";
```
to add the new member:
```ts
export type SuggestionType =
  | "cache"
  | "batch"
  | "redundancy"
  | "n_plus_one"
  | "rate_limit"
  | "concurrency_control"
  | "unbatched_parallel";
```

- [ ] **Step 2: Extend `webview/src/types.ts`**

Change line 17 from:
```ts
export type SuggestionType = "cache" | "batch" | "redundancy" | "n_plus_one" | "rate_limit" | "concurrency_control";
```
to:
```ts
export type SuggestionType = "cache" | "batch" | "redundancy" | "n_plus_one" | "rate_limit" | "concurrency_control" | "unbatched_parallel";
```

- [ ] **Step 3: Extend `dashboard/src/lib/types.ts`**

Add `| "unbatched_parallel"` to the `SuggestionType` union ending at line 105 (after `| "concurrency_control"`, keeping the trailing semicolon on the last line).

- [ ] **Step 4: Verify the build now FAILS with an exhaustiveness error**

Run: `npm run build:ext`
Expected: a TypeScript error in `src/intelligence/compression.ts` at `FINDING_TITLE_BY_TYPE` — it is the one `Record<SuggestionType, string>` (fully exhaustive, non-`Partial`) map, so it must gain the new key. **Important:** the other consumer maps below are either `Record<string, ...>` or `Partial<Record<SuggestionType, ...>>`, so the compiler will NOT flag them. They must be updated by hand — the build passing is not proof they're complete.

### Task B2: Register `unbatched_parallel` in every consumer map

**Files:**
- `src/scan-results.ts:31-37` (`SAVINGS_MULTIPLIERS`)
- `src/intelligence/compression.ts:38-51` (`FINDING_TITLE_BY_TYPE` exhaustive — required; `FINDING_LABEL_BY_TYPE` Partial — optional)
- `webview/src/components/ResultsPage.tsx:19-29` (`typeLabels`, `Record<string,string>` — manual)
- `dashboard/src/pages/Suggestions.tsx:16-32` (`typeIcons` Partial + `typeLabels` `Record<string,string>` — manual)

- [ ] **Step 1: Savings multiplier — `src/scan-results.ts`**

The table currently reads:
```ts
export const SAVINGS_MULTIPLIERS: Partial<Record<Suggestion["type"], number>> = {
  redundancy:          0.40,
  n_plus_one:          0.35,
  cache:               0.30,
  batch:               0.20,
  concurrency_control: 0.22,
};
```
Add an `unbatched_parallel` entry matching `batch` (same cost-savings family):
```ts
  batch:               0.20,
  unbatched_parallel:  0.20,
  concurrency_control: 0.22,
```

- [ ] **Step 2: Intelligence titles — `src/intelligence/compression.ts`** (this is the build-breaking one)

In `FINDING_TITLE_BY_TYPE` (the exhaustive `Record<SuggestionType, string>` that contains `batch: "Batching opportunity"`), add alongside `batch`:
```ts
  batch: "Batching opportunity",
  unbatched_parallel: "Unbatched parallel fan-out",
```
Optionally also add to `FINDING_LABEL_BY_TYPE` (the `Partial` map) for a richer label:
```ts
  unbatched_parallel: "Unbatched parallel fan-out",
```

- [ ] **Step 3: Webview label — `webview/src/components/ResultsPage.tsx`**

`typeLabels` (a `Record<string, string>`) currently:
```ts
const typeLabels: Record<string, string> = {
  n_plus_one: "n+1",
  cache: "cache",
  batch: "batch",
  redundancy: "redundancy",
  rate_limit: "rate-limit",
  concurrency_control: "concurrency",
  retry_storm: "retry storm",
  event_amplification: "event amp",
  sequential: "sequential",
};
```
Add alongside `batch`:
```ts
  batch: "batch",
  unbatched_parallel: "unbatched parallel",
```

- [ ] **Step 4: Dashboard icon + label — `dashboard/src/pages/Suggestions.tsx`**

In `typeIcons` (`Partial<Record<SuggestionType, ElementType>>`, currently maps `batch: Layers`), add `unbatched_parallel:    Layers,`.
In `typeLabels` (`Record<string, string>`, currently maps `batch: 'Batchable'`), add `unbatched_parallel:  'Unbatched Parallel',`.

- [ ] **Step 5: Verify the full build passes**

Run: `npm run build`
Expected: clean (dashboard + webview + extension). The compression exhaustiveness error from B1 Step 4 is resolved; the manual maps (Steps 1, 3, 4) are filled even though the compiler didn't force them.

- [ ] **Step 6: Commit the type plumbing**

```bash
git add src/analysis/types.ts webview/src/types.ts dashboard/src/lib/types.ts src/scan-results.ts src/intelligence/compression.ts webview/src/components/ResultsPage.tsx dashboard/src/pages/Suggestions.tsx
git commit -m "feat(wave4): register unbatched_parallel suggestion type across consumers (#117)"
```

### Task B3: Failing test for the DALL-E inline-parallel FN

**File:** `src/ast/waste/batch-detector.ts`
**Test:** `src/test/ast-batch-detector.test.ts`

Context: `detectInlineParallel` (currently lines ~270–317) emits `type: "batch"` and has this guard at ~line 281:
```ts
  // Array.from({ length: N }) is intentional bounded replication — not naive fan-out.
  if (match.frequency === "parallel" && hasGuardInWindow(source, match.line, BOUNDED_REPLICATION)) return null;
```
The DALL-E fixture matches `BOUNDED_REPLICATION` (`Array.from({ length: this.n })`), so it's suppressed.

- [ ] **Step 1: Write the failing test**

Add to `src/test/ast-batch-detector.test.ts` (match the file's existing `run(...)` harness and how it builds `AstCallMatch` inputs):

```ts
run("inline-parallel: Array.from({length:n}) fan-out on an n-capable endpoint → unbatched_parallel", () => {
  const source = [
    "const results = await Promise.all(",
    "  Array.from({ length: this.n }).map(() =>",
    "    this.client.images.generate(fields)",
    "  )",
    ");",
  ].join("\n");

  const match = makeMatch({
    line: 3,
    frequency: "parallel",
    inlineParallelCapable: true,
    provider: "openai",
    methodSignature: "images.generate",
  });

  const findings = detectBatchWaste([match], source, "src/tools/dalle.ts");
  const inline = findings.filter((f) => f.type === "unbatched_parallel");
  assert.equal(inline.length, 1, "expected one unbatched_parallel finding");
});
```

(Use the file's existing match-builder helper; `makeMatch` is illustrative — match the real helper name and required fields.)

- [ ] **Step 2: Run it, verify it fails**

Run: `npx tsc -p tsconfig.scanner-tests.json && node dist-test/test/ast-batch-detector.test.js`
Expected: FAIL — 0 findings (guard suppresses) AND the type is `"batch"` not `"unbatched_parallel"`.

### Task B4: Lift the guard and emit the new type

- [ ] **Step 3: Remove the BOUNDED_REPLICATION guard from `detectInlineParallel` only**

In `src/ast/waste/batch-detector.ts`, inside `detectInlineParallel`, delete these two lines:
```ts
  // Array.from({ length: N }) is intentional bounded replication — not naive fan-out.
  if (match.frequency === "parallel" && hasGuardInWindow(source, match.line, BOUNDED_REPLICATION)) return null;
```
Leave the identical guard in `detectBatch` untouched. (`BOUNDED_REPLICATION` is still referenced by `detectBatch`, so the const stays.)

- [ ] **Step 4: Change the emitted type**

In the `return` object of `detectInlineParallel`, change:
```ts
    type: "batch" as SuggestionType,
```
to:
```ts
    type: "unbatched_parallel" as SuggestionType,
```
(The `id` field `local-inline_parallel-...` already names it correctly — leave it.)

- [ ] **Step 5: Run the test, verify it passes**

Run: `node dist-test/test/ast-batch-detector.test.js`
Expected: PASS.

### Task B5: Regression test — guard removal didn't widen blast radius

- [ ] **Step 6: Write the regression test**

Add to `src/test/ast-batch-detector.test.ts`:

```ts
run("inline-parallel: Array.from fan-out on a NON-n-capable endpoint → no unbatched_parallel", () => {
  const source = [
    "const results = await Promise.all(",
    "  Array.from({ length: 5 }).map(() => client.chat.completions.create(body))",
    ");",
  ].join("\n");

  const match = makeMatch({
    line: 2,
    frequency: "parallel",
    inlineParallelCapable: false, // endpoint has no n/count parameter
    provider: "openai",
    methodSignature: "chat.completions.create",
  });

  const findings = detectBatchWaste([match], source, "src/x.ts");
  assert.equal(
    findings.filter((f) => f.type === "unbatched_parallel").length,
    0,
    "inlineParallelCapable=false must not produce unbatched_parallel"
  );
});
```

- [ ] **Step 7: Run it, verify it passes**

Run: `node dist-test/test/ast-batch-detector.test.js`
Expected: PASS (the `if (!match.inlineParallelCapable) return null;` gate inside `detectInlineParallel` is the precision control that survives guard removal).

- [ ] **Step 8: Run the full scanner suite**

Run: `npm run test:scanner`
Expected: all green.

- [ ] **Step 9: Commit**

```bash
git add src/ast/waste/batch-detector.ts src/test/ast-batch-detector.test.ts
git commit -m "feat(wave4): recover DALL-E inline-parallel FN as unbatched_parallel (#117)"
```

---

## Task C: Whole-wave verification gate (after both tracks merge)

**Files:** none (verification only)

- [ ] **Step 1: Full build**

Run: `npm run build`
Expected: clean across dashboard + webview + extension.

- [ ] **Step 2: Full scanner suite**

Run: `npm run test:scanner`
Expected: all green, including all 7 pre-existing C1 tests.

- [ ] **Step 3: Benchmark — confirm both rows recovered**

Run: `npm run benchmark`
Expected in `findingMetricsByType`:
- `batch` → TP 1 / FP 0 / FN 0
- `unbatched_parallel` → TP 1 / FP 0 / FN 0
- No per-type precision regression on any other row.

(If `batch` shows FP 1 from the bedrock case flagged in Task 0, that's the corpus-labeling decision — resolve per Task 0 Step 3, not by changing detector code here.)

- [ ] **Step 4: Update the C1 calibration table**

In `docs/accuracy/findings.md`, update the C1 calibration table: `batch` and `unbatched_parallel` rows to their recovered TP/FP/FN, and note "FN recovered in Wave 4 / #117". Mark the #117 items shipped.

- [ ] **Step 5: Commit docs**

```bash
git add docs/accuracy/findings.md
git commit -m "docs(wave4): mark C1 false negatives recovered (#117)"
```

---

## Self-review notes

- **Spec coverage:** Track A ↔ Python batch FN; Track B (B1–B5) ↔ DALL-E FN + `unbatched_parallel` type; Task 0 ↔ baseline/bedrock-FP risk; Task C ↔ whole-wave gates + doc update. All spec sections covered.
- **Type consistency:** new literal is `"unbatched_parallel"` everywhere (union, multiplier, labels, titles, detector emission, tests). `detectBatchWaste` / `detectInlineParallel` / `makeFinding` names match the existing source.
- **Parallelization note for the workflow:** Track A and Track B touch disjoint files. The only ordering constraint *within* Track B is B1 (union) → B2 (consumers) → B3–B5 (detector); B1's deliberately-failing build is the driver for B2. Track A is fully independent of Track B and can run concurrently. Task C is the barrier after both.
