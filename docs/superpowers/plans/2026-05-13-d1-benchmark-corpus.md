# D1 — Benchmark Corpus + CI Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Phase 2 tasks run **in parallel** across two repos — see "Parallel dispatch" section.

**Goal:** Stand up a labeled-corpus CI accuracy gate for the scanner. Real OSS subsets live in `recost-dev/extension_benchmark`; the runner, metrics, baseline, and gate workflow live in `extension`. PRs that drop precision or recall by > 1pp fail CI.

**Architecture:** Two-repo split. `extension` clones `extension_benchmark` at a pinned SHA in CI, then spawns `node dist/cli/scan.js <fixture>/src --format json` per fixture, compares output to hand-annotated `expected.json`, computes aggregate metrics, gates against `benchmark/baseline.json`.

**Tech Stack:** TypeScript, Node 20, vanilla `node:assert/strict` tests, GitHub Actions, web-tree-sitter (existing).

**Spec reference:** `docs/superpowers/specs/2026-05-13-d1-benchmark-corpus-design.md`. Read it before starting any task. Anything ambiguous in this plan defers to the spec.

---

## Repo locations

- `extension` repo: `/home/andresl/Projects/recost/extension` — most tasks land here.
- `extension_benchmark` repo: `/home/andresl/Projects/recost/extension_benchmark` — empty, freshly cloned. Phase 2B tasks land here. Remote: `https://github.com/recost-dev/extension_benchmark.git`.

## Branch strategy

- All `extension` work happens on a feature branch: `claude/d1-benchmark-gate`.
- Each `extension_benchmark` fixture is its own branch off `main`: `fixture/langchain-openai`, `fixture/openai-cookbook`, etc., merged via separate PRs to `extension_benchmark` `main`.
- Final integration (Phase 3) re-bases the `extension` branch on latest `main` and opens the gating PR.

## Parallel dispatch (Phase 2)

Phase 2A (runner in `extension`) and Phase 2B (5 fixture agents in `extension_benchmark`) are **fully independent** — different repos, different files. Dispatch **6 implementer agents in parallel** in a single tool-call block:

- 1 agent for Phase 2A in `extension` worktree, working on the `claude/d1-benchmark-gate` branch.
- 5 agents for Phase 2B-1 through 2B-5, each in a separate `extension_benchmark` worktree on its own `fixture/<slug>` branch.

This is safe because:
- The two repos cannot conflict with each other.
- The 5 fixture agents in `extension_benchmark` each create files only inside their own `<slug>/` directory. No shared files except optionally a top-level `README.md` (owned by Phase 1 and never edited in Phase 2B).

The subagent-driven-development pattern (implementer → spec reviewer → quality reviewer per task) applies **within** each parallel stream, not across them.

---

## Phase 1 — Schema-first (extension repo, sequential, must finish before Phase 2)

### Task 1.1: Create `benchmark/schema.ts` with `ExpectedJson` types and validator

**Files:**
- Create: `benchmark/schema.ts`
- Create: `src/test/benchmark-schema.test.ts`
- Modify: `tsconfig.scanner-tests.json` — add `"benchmark/**/*"` to `include`
- Modify: `package.json` test script — append the new test

**Context:** This is the contract that fixture-annotation agents (Phase 2B) and the runner (Phase 2A) both depend on. Lock it in first so the downstream streams have a stable target.

- [ ] **Step 1: Create the schema file**

Create `benchmark/schema.ts`:

```ts
import * as fs from "node:fs";

export interface ExpectedEndpoint {
  /** Path relative to the fixture root (e.g. "src/openai-helper.ts"). NOT the repo root. */
  file: string;
  /** Optional — enclosing function name. Not consumed by metrics; for human readability. */
  function?: string;
  /** 1-based line number where the call appears. */
  line: number;
  /** Canonical provider id, matching src/intelligence/provider-normalization.ts. */
  provider: string;
  /** SDK method signature OR URL-path key. */
  method: string;
  /** Always true. Present so the JSON file is self-documenting and to allow future "may_detect" loosening. */
  must_detect: true;
  notes?: string;
}

export interface ExpectedFinding {
  file: string;
  function?: string;
  line: number;
  /** Finding type — e.g. "n_plus_one", "unbounded_loop", "missing_cache_guard", "polling_no_backoff". */
  type: string;
  is_true_positive: true;
  notes?: string;
}

export interface ExpectedJson {
  schemaVersion: 1;
  fixtureSlug: string;
  endpoints: ExpectedEndpoint[];
  findings: ExpectedFinding[];
}

export class ExpectedJsonValidationError extends Error {
  constructor(public readonly fixturePath: string, message: string) {
    super(`${fixturePath}: ${message}`);
    this.name = "ExpectedJsonValidationError";
  }
}

/**
 * Load and validate an expected.json file. Throws ExpectedJsonValidationError on any schema issue.
 */
export function loadExpectedJson(absolutePath: string): ExpectedJson {
  const raw = fs.readFileSync(absolutePath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ExpectedJsonValidationError(absolutePath, `invalid JSON: ${(err as Error).message}`);
  }
  return validateExpectedJson(parsed, absolutePath);
}

export function validateExpectedJson(value: unknown, fixturePath: string): ExpectedJson {
  if (!value || typeof value !== "object") {
    throw new ExpectedJsonValidationError(fixturePath, "expected JSON object at top level");
  }
  const obj = value as Record<string, unknown>;
  if (obj.schemaVersion !== 1) {
    throw new ExpectedJsonValidationError(fixturePath, `schemaVersion must be 1, got ${JSON.stringify(obj.schemaVersion)}`);
  }
  if (typeof obj.fixtureSlug !== "string" || obj.fixtureSlug.length === 0) {
    throw new ExpectedJsonValidationError(fixturePath, "fixtureSlug must be a non-empty string");
  }
  if (!Array.isArray(obj.endpoints)) {
    throw new ExpectedJsonValidationError(fixturePath, "endpoints must be an array");
  }
  if (!Array.isArray(obj.findings)) {
    throw new ExpectedJsonValidationError(fixturePath, "findings must be an array");
  }
  const endpoints = obj.endpoints.map((e, i) => validateEndpoint(e, fixturePath, i));
  const findings = obj.findings.map((f, i) => validateFinding(f, fixturePath, i));
  return { schemaVersion: 1, fixtureSlug: obj.fixtureSlug, endpoints, findings };
}

function validateEndpoint(value: unknown, fixturePath: string, index: number): ExpectedEndpoint {
  if (!value || typeof value !== "object") {
    throw new ExpectedJsonValidationError(fixturePath, `endpoints[${index}] must be an object`);
  }
  const e = value as Record<string, unknown>;
  if (typeof e.file !== "string") throw new ExpectedJsonValidationError(fixturePath, `endpoints[${index}].file must be a string`);
  if (typeof e.line !== "number" || !Number.isInteger(e.line) || e.line < 1) {
    throw new ExpectedJsonValidationError(fixturePath, `endpoints[${index}].line must be a 1-based integer`);
  }
  if (typeof e.provider !== "string") throw new ExpectedJsonValidationError(fixturePath, `endpoints[${index}].provider must be a string`);
  if (typeof e.method !== "string") throw new ExpectedJsonValidationError(fixturePath, `endpoints[${index}].method must be a string`);
  if (e.must_detect !== true) throw new ExpectedJsonValidationError(fixturePath, `endpoints[${index}].must_detect must be true`);
  return {
    file: e.file,
    line: e.line,
    provider: e.provider,
    method: e.method,
    must_detect: true,
    function: typeof e.function === "string" ? e.function : undefined,
    notes: typeof e.notes === "string" ? e.notes : undefined,
  };
}

function validateFinding(value: unknown, fixturePath: string, index: number): ExpectedFinding {
  if (!value || typeof value !== "object") {
    throw new ExpectedJsonValidationError(fixturePath, `findings[${index}] must be an object`);
  }
  const f = value as Record<string, unknown>;
  if (typeof f.file !== "string") throw new ExpectedJsonValidationError(fixturePath, `findings[${index}].file must be a string`);
  if (typeof f.line !== "number" || !Number.isInteger(f.line) || f.line < 1) {
    throw new ExpectedJsonValidationError(fixturePath, `findings[${index}].line must be a 1-based integer`);
  }
  if (typeof f.type !== "string") throw new ExpectedJsonValidationError(fixturePath, `findings[${index}].type must be a string`);
  if (f.is_true_positive !== true) throw new ExpectedJsonValidationError(fixturePath, `findings[${index}].is_true_positive must be true`);
  return {
    file: f.file,
    line: f.line,
    type: f.type,
    is_true_positive: true,
    function: typeof f.function === "string" ? f.function : undefined,
    notes: typeof f.notes === "string" ? f.notes : undefined,
  };
}
```

- [ ] **Step 2: Add the validator test**

Create `src/test/benchmark-schema.test.ts`:

```ts
import assert from "node:assert/strict";
import { validateExpectedJson, ExpectedJsonValidationError } from "../../benchmark/schema";

async function run(name: string, fn: () => void | Promise<void>): Promise<void> {
  try { await fn(); console.log(`PASS ${name}`); }
  catch (err) { console.error(`FAIL ${name}`); throw err; }
}

(async () => {
  await run("accepts a minimal valid expected.json", () => {
    const value = {
      schemaVersion: 1,
      fixtureSlug: "x",
      endpoints: [
        { file: "a.ts", line: 5, provider: "openai", method: "chat.completions.create", must_detect: true },
      ],
      findings: [],
    };
    const parsed = validateExpectedJson(value, "x");
    assert.equal(parsed.endpoints.length, 1);
    assert.equal(parsed.endpoints[0].provider, "openai");
  });

  await run("rejects wrong schemaVersion", () => {
    assert.throws(
      () => validateExpectedJson({ schemaVersion: 2, fixtureSlug: "x", endpoints: [], findings: [] }, "x"),
      ExpectedJsonValidationError
    );
  });

  await run("rejects non-integer line numbers", () => {
    assert.throws(
      () => validateExpectedJson({
        schemaVersion: 1,
        fixtureSlug: "x",
        endpoints: [{ file: "a.ts", line: 5.5, provider: "openai", method: "m", must_detect: true }],
        findings: [],
      }, "x"),
      ExpectedJsonValidationError
    );
  });

  await run("rejects must_detect not equal to true", () => {
    assert.throws(
      () => validateExpectedJson({
        schemaVersion: 1,
        fixtureSlug: "x",
        endpoints: [{ file: "a.ts", line: 1, provider: "openai", method: "m", must_detect: false }],
        findings: [],
      }, "x"),
      ExpectedJsonValidationError
    );
  });

  await run("preserves optional fields", () => {
    const parsed = validateExpectedJson({
      schemaVersion: 1,
      fixtureSlug: "x",
      endpoints: [{ file: "a.ts", function: "f", line: 1, provider: "openai", method: "m", must_detect: true, notes: "n" }],
      findings: [],
    }, "x");
    assert.equal(parsed.endpoints[0].function, "f");
    assert.equal(parsed.endpoints[0].notes, "n");
  });

  await run("rejects missing fields", () => {
    assert.throws(
      () => validateExpectedJson({ schemaVersion: 1, fixtureSlug: "x", endpoints: [{}], findings: [] }, "x"),
      ExpectedJsonValidationError
    );
  });
})().catch((err) => { console.error(err); process.exit(1); });
```

- [ ] **Step 3: Update `tsconfig.scanner-tests.json` to include `benchmark/`**

Modify `tsconfig.scanner-tests.json`:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "rootDir": ".",
    "outDir": "dist-test"
  },
  "include": ["src/scanner/**/*", "src/ast/**/*", "src/intelligence/**/*", "src/test/**/*", "src/workspace-file-access.ts", "benchmark/**/*"],
  "exclude": ["node_modules", "dist", "webview", "dashboard", "dashboard-dist", "src/test/fixtures", "benchmark/_smoke", "benchmark-fixtures"]
}
```

Note: `rootDir` changes from `"src"` to `"."` because `benchmark/` is at repo root. Output paths shift — verify after compile.

- [ ] **Step 4: Add the test to `package.json`**

Modify `package.json` `test:scanner`: append at the end of the chain (before the final closing `"`):

```
&& node dist-test/test/benchmark-schema.test.js
```

But note: with rootDir `.`, the compiled path becomes `dist-test/src/test/benchmark-schema.test.js`. **Verify after running tsc once where the file lands and update the path.** This is mechanical — read the dist-test layout and update accordingly across the entire test script.

- [ ] **Step 5: Run the test to verify it passes**

```bash
npm test 2>&1 | tail -20
```

Expected: All existing tests pass + `PASS accepts a minimal valid expected.json` + 5 more PASS lines.

- [ ] **Step 6: Commit**

```bash
git checkout -b claude/d1-benchmark-gate
git add benchmark/schema.ts src/test/benchmark-schema.test.ts tsconfig.scanner-tests.json package.json
git commit -m "feat(benchmark): add expected.json schema and validator"
```

### Task 1.2: Create the smoke fixture

**Files:**
- Create: `benchmark/_smoke/src/openai-helper.ts`
- Create: `benchmark/_smoke/expected.json`
- Create: `benchmark/_smoke/FIXTURE.md`

**Context:** A tiny in-repo fixture that the runner can iterate against without cloning anything. 2 endpoints, 1 finding. Hand-crafted to produce stable, predictable scanner output.

- [ ] **Step 1: Write the source file**

Create `benchmark/_smoke/src/openai-helper.ts`:

```ts
import OpenAI from "openai";

const client = new OpenAI();

export async function complete(prompt: string): Promise<string> {
  const result = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
  });
  return result.choices[0]?.message.content ?? "";
}

export async function embedBatch(items: string[]): Promise<number[][]> {
  const out: number[][] = [];
  for (const item of items) {
    const res = await client.embeddings.create({ model: "text-embedding-3-small", input: item });
    out.push(res.data[0]?.embedding ?? []);
  }
  return out;
}
```

Two API calls: a `chat.completions.create` on line 6 and an `embeddings.create` on line 16. The `for` loop around the embedding call should trip the `n_plus_one` waste detector.

- [ ] **Step 2: Write the expected.json**

Create `benchmark/_smoke/expected.json`:

```json
{
  "schemaVersion": 1,
  "fixtureSlug": "_smoke",
  "endpoints": [
    {
      "file": "src/openai-helper.ts",
      "function": "complete",
      "line": 6,
      "provider": "openai",
      "method": "chat.completions.create",
      "must_detect": true
    },
    {
      "file": "src/openai-helper.ts",
      "function": "embedBatch",
      "line": 16,
      "provider": "openai",
      "method": "embeddings.create",
      "must_detect": true
    }
  ],
  "findings": [
    {
      "file": "src/openai-helper.ts",
      "function": "embedBatch",
      "line": 16,
      "type": "n_plus_one",
      "is_true_positive": true,
      "notes": "Embedding call inside a for loop over items — should be batched."
    }
  ]
}
```

- [ ] **Step 3: Write FIXTURE.md**

Create `benchmark/_smoke/FIXTURE.md`:

```markdown
# _smoke fixture

Hand-crafted minimal fixture for runner unit tests. Not vendored from any upstream.

**Scope:** 2 OpenAI calls (chat completion + embeddings in a loop) + 1 expected N+1 finding.

**Why this fixture exists:** The benchmark runner needs something to iterate against during development without cloning `extension_benchmark`. This fixture is deliberately small and stable.
```

- [ ] **Step 4: Verify by running the live scanner manually**

```bash
npm run build:ext
node dist/cli/scan.js benchmark/_smoke/src --format json | head -80
```

Expected: JSON output with at least 2 endpoints, both `provider: "openai"`, methods including `chat.completions.create` and `embeddings.create`. Output is informational — do not gate on it yet (runner does that in Task 2A).

- [ ] **Step 5: Commit**

```bash
git add benchmark/_smoke/
git commit -m "feat(benchmark): add _smoke fixture for runner development"
```

---

## Phase 2 — Parallel work (dispatch 6 agents simultaneously)

**Controller note:** After Phase 1 completes and is pushed, dispatch the following 6 implementation agents in **one parallel tool-call block**. Each agent uses subagent-driven-development internally (implementer → spec review → quality review) within its own scope. Agents do NOT see each other; the controller integrates.

Each agent gets:
1. A copy of the design spec (`docs/superpowers/specs/2026-05-13-d1-benchmark-corpus-design.md`)
2. The exact task text from this plan (Task 2A.* OR one of Task 2B.1–5)
3. Worktree isolation (`isolation: "worktree"`)
4. The repo path (`extension` or `extension_benchmark`)
5. The branch name to create

### Task 2A — Runner, metrics, report (in `extension`)

**Repo:** `extension`. Branch: continues `claude/d1-benchmark-gate` from Phase 1.

**Files:**
- Create: `benchmark/metrics.ts`
- Create: `benchmark/runner.ts`
- Create: `benchmark/report.ts`
- Create: `benchmark/README.md`
- Create: `src/test/benchmark-metrics.test.ts`
- Modify: `package.json` — add `benchmark` and `benchmark:smoke` scripts
- Modify: `tsconfig.scanner-tests.json` (already done in Phase 1, verify)
- Modify: test script in `package.json` to include the new metrics test

#### Task 2A.1: Write `metrics.ts` (pure precision/recall math)

- [ ] **Step 1: Write the failing test first**

Create `src/test/benchmark-metrics.test.ts`:

```ts
import assert from "node:assert/strict";
import { computeMetrics, type DetectedEndpoint, type DetectedFinding } from "../../benchmark/metrics";
import type { ExpectedJson } from "../../benchmark/schema";

async function run(name: string, fn: () => void | Promise<void>): Promise<void> {
  try { await fn(); console.log(`PASS ${name}`); }
  catch (err) { console.error(`FAIL ${name}`); throw err; }
}

function expectedFixture(endpoints: ExpectedJson["endpoints"], findings: ExpectedJson["findings"] = []): ExpectedJson {
  return { schemaVersion: 1, fixtureSlug: "test", endpoints, findings };
}

(async () => {
  await run("exact endpoint match gives 100% precision and recall", () => {
    const expected = expectedFixture([
      { file: "a.ts", line: 5, provider: "openai", method: "chat.completions.create", must_detect: true },
    ]);
    const detected: DetectedEndpoint[] = [
      { file: "a.ts", line: 5, provider: "openai", method: "chat.completions.create" },
    ];
    const m = computeMetrics(expected, detected, []);
    assert.equal(m.detectionPrecision, 1);
    assert.equal(m.detectionRecall, 1);
    assert.equal(m.providerAttributionAccuracy, 1);
  });

  await run("line tolerance ±2 still matches", () => {
    const expected = expectedFixture([
      { file: "a.ts", line: 10, provider: "openai", method: "chat.completions.create", must_detect: true },
    ]);
    const detected: DetectedEndpoint[] = [
      { file: "a.ts", line: 12, provider: "openai", method: "chat.completions.create" },
    ];
    const m = computeMetrics(expected, detected, []);
    assert.equal(m.detectionRecall, 1);
  });

  await run("line tolerance >2 does NOT match", () => {
    const expected = expectedFixture([
      { file: "a.ts", line: 10, provider: "openai", method: "chat.completions.create", must_detect: true },
    ]);
    const detected: DetectedEndpoint[] = [
      { file: "a.ts", line: 13, provider: "openai", method: "chat.completions.create" },
    ];
    const m = computeMetrics(expected, detected, []);
    assert.equal(m.detectionRecall, 0);
  });

  await run("false positive lowers precision", () => {
    const expected = expectedFixture([
      { file: "a.ts", line: 5, provider: "openai", method: "chat.completions.create", must_detect: true },
    ]);
    const detected: DetectedEndpoint[] = [
      { file: "a.ts", line: 5, provider: "openai", method: "chat.completions.create" },
      { file: "b.ts", line: 99, provider: "stripe", method: "charges.create" }, // not expected
    ];
    const m = computeMetrics(expected, detected, []);
    assert.equal(m.detectionPrecision, 0.5);
    assert.equal(m.detectionRecall, 1);
  });

  await run("missed expected lowers recall", () => {
    const expected = expectedFixture([
      { file: "a.ts", line: 5, provider: "openai", method: "chat.completions.create", must_detect: true },
      { file: "b.ts", line: 6, provider: "stripe", method: "charges.create", must_detect: true },
    ]);
    const detected: DetectedEndpoint[] = [
      { file: "a.ts", line: 5, provider: "openai", method: "chat.completions.create" },
    ];
    const m = computeMetrics(expected, detected, []);
    assert.equal(m.detectionRecall, 0.5);
    assert.equal(m.detectionPrecision, 1);
  });

  await run("provider mismatch counts against attribution but file+line still recall-credits", () => {
    const expected = expectedFixture([
      { file: "a.ts", line: 5, provider: "openai", method: "chat.completions.create", must_detect: true },
    ]);
    const detected: DetectedEndpoint[] = [
      { file: "a.ts", line: 5, provider: "unknown", method: "chat.completions.create" },
    ];
    const m = computeMetrics(expected, detected, []);
    // The detected entry attributed to wrong provider isn't a true match for endpoint precision/recall,
    // but it IS a precision miss (we predicted "unknown" when ground truth is "openai").
    assert.equal(m.detectionRecall, 0); // expected is missed because providers don't agree
    assert.equal(m.detectionPrecision, 0); // detected is wrong because no expected matches
  });

  await run("finding precision and recall computed correctly", () => {
    const expected = expectedFixture(
      [],
      [{ file: "a.ts", line: 10, type: "n_plus_one", is_true_positive: true }]
    );
    const detected: DetectedEndpoint[] = [];
    const detectedFindings: DetectedFinding[] = [
      { file: "a.ts", line: 10, type: "n_plus_one" },
      { file: "b.ts", line: 5, type: "unbounded_loop" }, // false positive
    ];
    const m = computeMetrics(expected, detected, detectedFindings);
    assert.equal(m.findingPrecision, 0.5);
    assert.equal(m.findingRecall, 1);
  });

  await run("empty inputs return NaN-free metrics", () => {
    const m = computeMetrics(expectedFixture([], []), [], []);
    assert.equal(m.detectionPrecision, 1); // by convention: nothing detected, nothing expected → perfect
    assert.equal(m.detectionRecall, 1);
    assert.equal(m.findingPrecision, 1);
    assert.equal(m.findingRecall, 1);
  });
})().catch((err) => { console.error(err); process.exit(1); });
```

- [ ] **Step 2: Run the test, verify it fails (metrics.ts doesn't exist)**

```bash
tsc -p tsconfig.scanner-tests.json
```

Expected: TS compile error — `Cannot find module '../../benchmark/metrics'`.

- [ ] **Step 3: Implement `benchmark/metrics.ts`**

Create `benchmark/metrics.ts`:

```ts
import type { ExpectedJson, ExpectedEndpoint, ExpectedFinding } from "./schema";

const LINE_TOLERANCE = 2;

export interface DetectedEndpoint {
  file: string;
  line: number;
  provider: string;
  method: string;
}

export interface DetectedFinding {
  file: string;
  line: number;
  type: string;
}

export interface MetricsReport {
  detectionPrecision: number;
  detectionRecall: number;
  providerAttributionAccuracy: number;
  findingPrecision: number;
  findingRecall: number;
  /** Per-fixture breakdown, useful for diagnosing where a regression landed. */
  perFixture: PerFixtureMetrics[];
}

export interface PerFixtureMetrics {
  fixtureSlug: string;
  detectionPrecision: number;
  detectionRecall: number;
  providerAttributionAccuracy: number;
  findingPrecision: number;
  findingRecall: number;
  truePositiveEndpoints: number;
  falsePositiveEndpoints: number;
  falseNegativeEndpoints: number;
  truePositiveFindings: number;
  falsePositiveFindings: number;
  falseNegativeFindings: number;
}

/**
 * Compute metrics for a single fixture against its expected.json + scanner output.
 * Pure function — no I/O.
 *
 * Matching rules:
 *  - An expected endpoint matches a detected endpoint when file matches AND provider matches AND
 *    (method OR methodSignature equivalent) matches AND |detected.line - expected.line| <= 2.
 *  - When file+line match but provider differs, the detection is BOTH a false positive (wrong provider)
 *    AND a false negative (missed the expected entry).
 *  - Provider attribution accuracy: of the detected endpoints with provider !== "unknown" that matched
 *    something on file+line, what fraction got the provider right?
 *  - Findings: file + type + |line| <= 2 are matched. Same FP/FN logic.
 */
export function computeMetrics(
  expected: ExpectedJson,
  detected: DetectedEndpoint[],
  detectedFindings: DetectedFinding[]
): PerFixtureMetrics {
  const endpointMatch = matchPairs(
    expected.endpoints,
    detected,
    (e, d) => e.file === d.file && e.provider === d.provider && methodsEquivalent(e.method, d.method) && Math.abs(e.line - d.line) <= LINE_TOLERANCE,
  );

  // Provider attribution: any detected entry on the right file+line, regardless of provider, counts toward the denominator.
  let attributionCorrect = 0;
  let attributionTotal = 0;
  for (const e of expected.endpoints) {
    const sameFileLine = detected.find(d => d.file === e.file && Math.abs(d.line - e.line) <= LINE_TOLERANCE);
    if (sameFileLine && sameFileLine.provider !== "unknown") {
      attributionTotal += 1;
      if (sameFileLine.provider === e.provider) attributionCorrect += 1;
    }
  }

  const findingMatch = matchPairs(
    expected.findings,
    detectedFindings,
    (e, d) => e.file === d.file && e.type === d.type && Math.abs(e.line - d.line) <= LINE_TOLERANCE,
  );

  return {
    fixtureSlug: expected.fixtureSlug,
    detectionPrecision: safeRatio(endpointMatch.truePositives, endpointMatch.truePositives + endpointMatch.falsePositives),
    detectionRecall: safeRatio(endpointMatch.truePositives, endpointMatch.truePositives + endpointMatch.falseNegatives),
    providerAttributionAccuracy: attributionTotal === 0 ? 1 : attributionCorrect / attributionTotal,
    findingPrecision: safeRatio(findingMatch.truePositives, findingMatch.truePositives + findingMatch.falsePositives),
    findingRecall: safeRatio(findingMatch.truePositives, findingMatch.truePositives + findingMatch.falseNegatives),
    truePositiveEndpoints: endpointMatch.truePositives,
    falsePositiveEndpoints: endpointMatch.falsePositives,
    falseNegativeEndpoints: endpointMatch.falseNegatives,
    truePositiveFindings: findingMatch.truePositives,
    falsePositiveFindings: findingMatch.falsePositives,
    falseNegativeFindings: findingMatch.falseNegatives,
  };
}

/** Aggregate per-fixture metrics into a global report. */
export function aggregate(perFixture: PerFixtureMetrics[]): MetricsReport {
  const sum = perFixture.reduce(
    (acc, m) => ({
      tpE: acc.tpE + m.truePositiveEndpoints,
      fpE: acc.fpE + m.falsePositiveEndpoints,
      fnE: acc.fnE + m.falseNegativeEndpoints,
      tpF: acc.tpF + m.truePositiveFindings,
      fpF: acc.fpF + m.falsePositiveFindings,
      fnF: acc.fnF + m.falseNegativeFindings,
      attCorrect: acc.attCorrect + Math.round(m.providerAttributionAccuracy * (m.truePositiveEndpoints + m.falseNegativeEndpoints)),
      attTotal: acc.attTotal + (m.truePositiveEndpoints + m.falseNegativeEndpoints),
    }),
    { tpE: 0, fpE: 0, fnE: 0, tpF: 0, fpF: 0, fnF: 0, attCorrect: 0, attTotal: 0 },
  );

  return {
    detectionPrecision: safeRatio(sum.tpE, sum.tpE + sum.fpE),
    detectionRecall: safeRatio(sum.tpE, sum.tpE + sum.fnE),
    providerAttributionAccuracy: sum.attTotal === 0 ? 1 : sum.attCorrect / sum.attTotal,
    findingPrecision: safeRatio(sum.tpF, sum.tpF + sum.fpF),
    findingRecall: safeRatio(sum.tpF, sum.tpF + sum.fnF),
    perFixture,
  };
}

interface MatchResult { truePositives: number; falsePositives: number; falseNegatives: number; }

function matchPairs<E, D>(expected: E[], detected: D[], match: (e: E, d: D) => boolean): MatchResult {
  const expectedMatched = new Array<boolean>(expected.length).fill(false);
  const detectedMatched = new Array<boolean>(detected.length).fill(false);

  for (let ei = 0; ei < expected.length; ei++) {
    for (let di = 0; di < detected.length; di++) {
      if (detectedMatched[di]) continue;
      if (match(expected[ei], detected[di])) {
        expectedMatched[ei] = true;
        detectedMatched[di] = true;
        break;
      }
    }
  }

  const truePositives = expectedMatched.filter(Boolean).length;
  const falsePositives = detectedMatched.filter(m => !m).length;
  const falseNegatives = expectedMatched.filter(m => !m).length;
  return { truePositives, falsePositives, falseNegatives };
}

function safeRatio(numerator: number, denominator: number): number {
  if (denominator === 0) return 1;
  return numerator / denominator;
}

/**
 * Methods are considered equivalent if either:
 *  - exact string match
 *  - both refer to the same SDK chain regardless of separator (defensive — fixture authors might use "." or " ")
 */
function methodsEquivalent(a: string, b: string): boolean {
  if (a === b) return true;
  return normalize(a) === normalize(b);
}

function normalize(s: string): string {
  return s.replace(/\s+/g, "").toLowerCase();
}
```

- [ ] **Step 4: Wire test into `package.json`**

Modify `package.json` `test:scanner` — append:

```
&& node dist-test/src/test/benchmark-metrics.test.js
```

(Path depends on where `tsc --rootDir .` puts it. Verify by running tsc and checking `ls dist-test/`. Update other test paths in the same script accordingly if `rootDir` change moved them.)

- [ ] **Step 5: Run and verify all 8 tests pass**

```bash
npm test 2>&1 | grep -E "(PASS|FAIL)" | tail -20
```

Expected: 8 new PASS lines from the metrics test + all existing PASSes.

- [ ] **Step 6: Commit**

```bash
git add benchmark/metrics.ts src/test/benchmark-metrics.test.ts package.json
git commit -m "feat(benchmark): add pure precision/recall metrics with ±2 line tolerance"
```

#### Task 2A.2: Write `runner.ts` (spawns CLI, parses output, applies metrics)

**Context:** The runner is the orchestrator. It enumerates fixture dirs, spawns the live CLI on each, parses the JSON output into `DetectedEndpoint`/`DetectedFinding`, calls `computeMetrics`, calls `aggregate`, then writes the report and gates against baseline.

- [ ] **Step 1: Write the runner**

Create `benchmark/runner.ts`:

```ts
import * as fs from "node:fs";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loadExpectedJson } from "./schema";
import { computeMetrics, aggregate, type DetectedEndpoint, type DetectedFinding, type MetricsReport } from "./metrics";
import { formatMarkdownReport, formatConsoleReport } from "./report";

const execFileAsync = promisify(execFile);

const REPO_ROOT = path.resolve(__dirname, "..");
const DEFAULT_FIXTURES = path.resolve(REPO_ROOT, "..", "extension_benchmark");
const DEFAULT_BASELINE = path.resolve(REPO_ROOT, "benchmark", "baseline.json");
const SMOKE_DIR = path.resolve(REPO_ROOT, "benchmark", "_smoke");
const CLI_PATH = path.resolve(REPO_ROOT, "dist", "cli", "scan.js");
const DEFAULT_THRESHOLD_PP = 1.0;

interface CliArgs {
  fixturesDir: string;
  baselinePath: string;
  thresholdPp: number;
  updateBaseline: boolean;
  smokeOnly: boolean;
  reportPath: string | null;
}

interface ScanResult {
  endpoints: Array<{
    provider: string;
    method?: string;
    methodSignature?: string;
    files: string[];
    callSites: Array<{ file: string; line: number }>;
  }>;
  suggestions: Array<{
    type: string;
    affectedFiles: string[];
    targetLine?: number;
  }>;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    fixturesDir: DEFAULT_FIXTURES,
    baselinePath: DEFAULT_BASELINE,
    thresholdPp: DEFAULT_THRESHOLD_PP,
    updateBaseline: false,
    smokeOnly: false,
    reportPath: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--fixtures") args.fixturesDir = path.resolve(argv[++i]);
    else if (a === "--baseline") args.baselinePath = path.resolve(argv[++i]);
    else if (a === "--threshold") args.thresholdPp = Number(argv[++i]);
    else if (a === "--update-baseline") args.updateBaseline = true;
    else if (a === "--smoke") args.smokeOnly = true;
    else if (a === "--report") args.reportPath = path.resolve(argv[++i]);
    else if (a === "--help" || a === "-h") { printHelp(); process.exit(0); }
    else { console.error(`Unknown arg: ${a}`); process.exit(2); }
  }
  return args;
}

function printHelp(): void {
  console.log([
    "Usage: node dist/benchmark/runner.js [options]",
    "",
    "Options:",
    "  --fixtures <dir>     Path to fixtures root (default: ../extension_benchmark)",
    "  --baseline <path>    Path to baseline.json (default: benchmark/baseline.json)",
    "  --threshold <pp>     Allowed drop in percentage points (default: 1.0)",
    "  --update-baseline    Overwrite baseline.json with current metrics; do not gate",
    "  --smoke              Use only benchmark/_smoke; ignore --fixtures",
    "  --report <path>      Write JSON report to file",
    "",
  ].join("\n"));
}

async function findFixtures(root: string, smokeOnly: boolean): Promise<string[]> {
  if (smokeOnly) return [SMOKE_DIR];
  if (!fs.existsSync(root)) {
    console.error([
      `Fixtures directory not found: ${root}`,
      "",
      "To get the v1 corpus:",
      `  git clone https://github.com/recost-dev/extension_benchmark.git ${root}`,
      "",
      "Or run smoke-only: npm run benchmark:smoke",
    ].join("\n"));
    process.exit(2);
  }
  const entries = fs.readdirSync(root, { withFileTypes: true });
  return entries
    .filter(e => e.isDirectory() && !e.name.startsWith(".") && !e.name.startsWith("_"))
    .map(e => path.join(root, e.name))
    .filter(p => fs.existsSync(path.join(p, "expected.json")));
}

async function scanFixture(fixtureDir: string): Promise<ScanResult> {
  const srcDir = path.join(fixtureDir, "src");
  const targetDir = fs.existsSync(srcDir) ? srcDir : fixtureDir;
  try {
    const { stdout } = await execFileAsync("node", [CLI_PATH, targetDir, "--format", "json"], {
      maxBuffer: 50 * 1024 * 1024,
      timeout: 300_000,
    });
    return JSON.parse(stdout) as ScanResult;
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message: string };
    throw new Error(`Scanner failed for ${fixtureDir}: ${e.message}\nSTDERR: ${e.stderr ?? ""}`);
  }
}

function detectedFromScan(result: ScanResult, fixtureDir: string): { endpoints: DetectedEndpoint[]; findings: DetectedFinding[] } {
  const fixtureRoot = fs.existsSync(path.join(fixtureDir, "src")) ? path.join(fixtureDir, "src") : fixtureDir;
  const endpoints: DetectedEndpoint[] = [];
  for (const e of result.endpoints) {
    for (const cs of e.callSites) {
      endpoints.push({
        file: path.relative(fixtureDir, path.resolve(cs.file)).replace(/\\/g, "/"),
        line: cs.line,
        provider: e.provider ?? "unknown",
        method: e.methodSignature ?? e.method ?? "",
      });
    }
  }
  const findings: DetectedFinding[] = [];
  for (const s of result.suggestions) {
    if (typeof s.targetLine !== "number") continue;
    const file = s.affectedFiles[0];
    if (!file) continue;
    findings.push({
      file: path.relative(fixtureDir, path.resolve(file)).replace(/\\/g, "/"),
      line: s.targetLine,
      type: s.type,
    });
  }
  // Suppress unused warning — kept intentionally for future use.
  void fixtureRoot;
  return { endpoints, findings };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const fixtureDirs = await findFixtures(args.fixturesDir, args.smokeOnly);
  if (fixtureDirs.length === 0) {
    console.error(`No fixtures found in ${args.fixturesDir}`);
    process.exit(2);
  }
  console.log(`Running ${fixtureDirs.length} fixture(s)...`);

  const perFixture = [];
  for (const dir of fixtureDirs) {
    const slug = path.basename(dir);
    console.log(`  ${slug}...`);
    const expected = loadExpectedJson(path.join(dir, "expected.json"));
    const scan = await scanFixture(dir);
    const { endpoints, findings } = detectedFromScan(scan, dir);
    perFixture.push(computeMetrics(expected, endpoints, findings));
  }
  const report = aggregate(perFixture);

  if (args.updateBaseline) {
    fs.writeFileSync(args.baselinePath, JSON.stringify({
      detectionPrecision: report.detectionPrecision,
      detectionRecall: report.detectionRecall,
      providerAttributionAccuracy: report.providerAttributionAccuracy,
      findingPrecision: report.findingPrecision,
      findingRecall: report.findingRecall,
    }, null, 2) + "\n");
    console.log(formatConsoleReport(report, null));
    console.log(`\nBaseline updated: ${args.baselinePath}`);
    return;
  }

  let baseline: MetricsReport | null = null;
  if (fs.existsSync(args.baselinePath)) {
    const raw = JSON.parse(fs.readFileSync(args.baselinePath, "utf8"));
    baseline = { ...raw, perFixture: [] };
  }
  console.log(formatConsoleReport(report, baseline));

  if (args.reportPath) {
    fs.writeFileSync(args.reportPath, JSON.stringify(report, null, 2) + "\n");
  }

  const stepSummary = process.env.GITHUB_STEP_SUMMARY;
  if (stepSummary) {
    fs.appendFileSync(stepSummary, formatMarkdownReport(report, baseline) + "\n");
  }

  if (baseline) {
    const drops = computeDrops(report, baseline, args.thresholdPp);
    if (drops.length > 0) {
      console.error(`\nFAIL: ${drops.length} metric(s) dropped > ${args.thresholdPp}pp:`);
      for (const d of drops) console.error(`  - ${d.metric}: ${(d.baseline * 100).toFixed(1)}% → ${(d.current * 100).toFixed(1)}% (Δ ${(d.deltaPp).toFixed(2)}pp)`);
      process.exit(1);
    }
  }
}

function computeDrops(current: MetricsReport, baseline: MetricsReport, thresholdPp: number): Array<{ metric: string; current: number; baseline: number; deltaPp: number }> {
  const metrics: Array<keyof Pick<MetricsReport, "detectionPrecision" | "detectionRecall" | "providerAttributionAccuracy" | "findingPrecision" | "findingRecall">> = [
    "detectionPrecision",
    "detectionRecall",
    "providerAttributionAccuracy",
    "findingPrecision",
    "findingRecall",
  ];
  const drops = [];
  for (const m of metrics) {
    const deltaPp = (current[m] - baseline[m]) * 100;
    if (deltaPp < -thresholdPp) drops.push({ metric: m, current: current[m], baseline: baseline[m], deltaPp });
  }
  return drops;
}

main().catch(err => { console.error(err); process.exit(1); });
```

- [ ] **Step 2: Create `benchmark/report.ts`**

Create `benchmark/report.ts`:

```ts
import type { MetricsReport } from "./metrics";

const METRIC_LABELS: Record<string, string> = {
  detectionPrecision: "Detection precision",
  detectionRecall: "Detection recall",
  providerAttributionAccuracy: "Provider attribution",
  findingPrecision: "Finding precision",
  findingRecall: "Finding recall",
};

const METRIC_KEYS = [
  "detectionPrecision",
  "detectionRecall",
  "providerAttributionAccuracy",
  "findingPrecision",
  "findingRecall",
] as const;

export function formatConsoleReport(current: MetricsReport, baseline: MetricsReport | null): string {
  const lines = ["", "=== Benchmark Report ==="];
  for (const k of METRIC_KEYS) {
    const cur = (current[k] * 100).toFixed(2);
    if (baseline) {
      const base = (baseline[k] * 100).toFixed(2);
      const deltaPp = ((current[k] - baseline[k]) * 100).toFixed(2);
      const sign = current[k] >= baseline[k] ? "+" : "";
      lines.push(`  ${METRIC_LABELS[k].padEnd(24)} ${cur}%  (baseline ${base}%, Δ ${sign}${deltaPp}pp)`);
    } else {
      lines.push(`  ${METRIC_LABELS[k].padEnd(24)} ${cur}%`);
    }
  }
  if (current.perFixture.length > 0) {
    lines.push("\nPer fixture:");
    for (const f of current.perFixture) {
      lines.push(`  [${f.fixtureSlug}] det P/R ${(f.detectionPrecision * 100).toFixed(1)}/${(f.detectionRecall * 100).toFixed(1)} | find P/R ${(f.findingPrecision * 100).toFixed(1)}/${(f.findingRecall * 100).toFixed(1)} | TP/FP/FN endpoints ${f.truePositiveEndpoints}/${f.falsePositiveEndpoints}/${f.falseNegativeEndpoints}`);
    }
  }
  return lines.join("\n");
}

export function formatMarkdownReport(current: MetricsReport, baseline: MetricsReport | null): string {
  const lines = ["## Benchmark Report", ""];
  lines.push("| Metric | Current | Baseline | Δ (pp) |");
  lines.push("|---|---|---|---|");
  for (const k of METRIC_KEYS) {
    const cur = (current[k] * 100).toFixed(2) + "%";
    if (baseline) {
      const base = (baseline[k] * 100).toFixed(2) + "%";
      const delta = ((current[k] - baseline[k]) * 100).toFixed(2);
      const sign = current[k] >= baseline[k] ? "+" : "";
      lines.push(`| ${METRIC_LABELS[k]} | ${cur} | ${base} | ${sign}${delta} |`);
    } else {
      lines.push(`| ${METRIC_LABELS[k]} | ${cur} | — | — |`);
    }
  }
  if (current.perFixture.length > 0) {
    lines.push("", "### Per fixture", "", "| Fixture | Det P | Det R | Find P | Find R | TP/FP/FN endpoints |", "|---|---|---|---|---|---|");
    for (const f of current.perFixture) {
      const pct = (n: number) => (n * 100).toFixed(1) + "%";
      lines.push(`| ${f.fixtureSlug} | ${pct(f.detectionPrecision)} | ${pct(f.detectionRecall)} | ${pct(f.findingPrecision)} | ${pct(f.findingRecall)} | ${f.truePositiveEndpoints}/${f.falsePositiveEndpoints}/${f.falseNegativeEndpoints} |`);
    }
  }
  return lines.join("\n");
}
```

- [ ] **Step 3: Add npm scripts**

Modify `package.json` scripts:

```json
"benchmark": "npm run build:ext && tsc -p tsconfig.scanner-tests.json && node dist-test/benchmark/runner.js",
"benchmark:smoke": "npm run build:ext && tsc -p tsconfig.scanner-tests.json && node dist-test/benchmark/runner.js --smoke",
```

(Verify the compiled runner path matches what tsc produces with `rootDir: "."`. Adjust as needed.)

- [ ] **Step 4: Smoke run end-to-end**

```bash
npm run benchmark:smoke
```

Expected: scanner runs against `benchmark/_smoke/`, prints a console report. No baseline → no gate failure. Detection precision/recall should be > 0.

- [ ] **Step 5: Commit**

```bash
git add benchmark/runner.ts benchmark/report.ts package.json
git commit -m "feat(benchmark): add runner and report; npm run benchmark / :smoke scripts"
```

#### Task 2A.3: Write `benchmark/README.md`

- [ ] **Step 1: Create the README**

Create `benchmark/README.md`:

```markdown
# Benchmark

Hand-labeled accuracy gate for the scanner. Fails CI when precision or recall drops > 1pp.

## Quick start

```bash
# Smoke (no clone, fast):
npm run benchmark:smoke

# Full (requires extension_benchmark cloned as sibling dir):
git clone https://github.com/recost-dev/extension_benchmark.git ../extension_benchmark
npm run benchmark
```

## Layout

- `runner.ts` — orchestrates per-fixture scan + metric computation. Reads `--fixtures <dir>` (default `../extension_benchmark`).
- `metrics.ts` — pure precision/recall math.
- `schema.ts` — `expected.json` types + validator.
- `report.ts` — console + markdown report formatting.
- `baseline.json` — committed metric baseline. Gate compares current run vs this.
- `_smoke/` — tiny in-repo fixture for runner development.

## CI

`.github/workflows/benchmark.yml` runs on every PR. It reads `.benchmark-fixtures-sha` (repo root), clones `extension_benchmark` at that SHA, then runs `npm run benchmark`.

## Adding a fixture

Fixtures live in `extension_benchmark`, not here. To add one:

1. Open a PR in `recost-dev/extension_benchmark` with a new `<slug>/src/...`, `<slug>/expected.json`, `<slug>/FIXTURE.md`.
2. Once merged, bump `.benchmark-fixtures-sha` in `extension`.
3. Run `npm run benchmark -- --update-baseline` locally and commit `baseline.json` if the new fixture changed it.

## Updating the baseline

When a PR legitimately improves accuracy:

```bash
npm run benchmark -- --update-baseline
git add benchmark/baseline.json
```

Commit the new baseline in the same PR as the code change. Explain why in the PR description.
```

- [ ] **Step 2: Commit**

```bash
git add benchmark/README.md
git commit -m "docs(benchmark): add README for the benchmark gate"
```

---

### Task 2B — Fixtures (5 parallel agents in `extension_benchmark`)

**Repo:** `extension_benchmark`. Each agent works on its own branch off `main`.

**Common context for every Phase 2B agent:**
- Read `docs/superpowers/specs/2026-05-13-d1-benchmark-corpus-design.md` in the `extension` repo for the full design (especially the **Annotation schema** and **Fixture strategy** sections).
- Read `benchmark/schema.ts` in `extension` for the contract `expected.json` must satisfy.
- Read `benchmark/_smoke/` in `extension` for a worked example.
- Use only permissive licenses (MIT / Apache-2.0 / BSD). Reject GPL or unclear. Preserve license notices.
- Each fixture target: 10–50 files. Trim unrelated tests, docs, build configs unless they're load-bearing for the scan.
- Branch name: `fixture/<slug>`.
- All paths in `expected.json` are relative to the **fixture root** (e.g. `src/openai-helper.ts`), not the repo root.

#### Task 2B.1: `langchain-openai` fixture

**Slug:** `langchain-openai`
**Surface tested:** Wrapper-heavy OpenAI SDK + multi-hop helpers (pairs with A1, A5)
**Source:** `langchain-ai/langchain` (Python or JS — pick whichever has denser, more straightforward OpenAI usage with helper-function layering)

- [ ] **Step 1: Pick the upstream commit and license-check**

```bash
cd /home/andresl/Projects/recost/extension_benchmark
git checkout -b fixture/langchain-openai
```

Browse `https://github.com/langchain-ai/langchain` and pick a recent commit. Confirm license is MIT (LangChain has been MIT historically). Note the SHA and licence URL.

- [ ] **Step 2: Vendor 10-50 files**

Manually copy or git-checkout-as-detach the relevant files into `langchain-openai/src/<paths>`. Aim for files containing the OpenAI client + 1-2 layers of helpers + the entry points that call those helpers. Keep file paths intuitive (mirror upstream structure when reasonable).

- [ ] **Step 3: Write `langchain-openai/FIXTURE.md`**

```markdown
# langchain-openai fixture

**Source:** https://github.com/langchain-ai/langchain @ <commit-sha>
**License:** MIT (preserved upstream notices in vendored files)
**Scope:** Wrapper-heavy OpenAI SDK usage. Tests the scanner's ability to trace multi-hop helper chains back to the underlying `chat.completions.create` / `embeddings.create` calls.

Files chosen:
- <relative paths and one-line purpose for each>

Why this fixture: <2-3 sentences>
```

- [ ] **Step 4: Hand-annotate `langchain-openai/expected.json`**

Read every vendored file. For each API call site, add an entry. Use:
- `file` relative to fixture root (NOT repo root). So `src/<path>` not `langchain-openai/src/<path>`.
- `line` = the 1-based line where the call expression starts.
- `provider` = canonical id from `src/intelligence/provider-normalization.ts` in `extension` (e.g. `"openai"`).
- `method` = the SDK chain (e.g. `"chat.completions.create"`).

For findings: read for N+1 (loop containing an API call), unbounded-loop, missing-cache-guard, polling-without-backoff patterns. Annotate only confident true positives.

Example structure:

```json
{
  "schemaVersion": 1,
  "fixtureSlug": "langchain-openai",
  "endpoints": [
    { "file": "src/agents/openai_helpers.py", "function": "complete", "line": 42, "provider": "openai", "method": "chat.completions.create", "must_detect": true },
    ...
  ],
  "findings": [
    { "file": "src/agents/batch.py", "function": "process_all", "line": 17, "type": "n_plus_one", "is_true_positive": true, "notes": "Loop over inputs calling openai.embeddings.create per item." }
  ]
}
```

- [ ] **Step 5: Sanity-check by running the live scanner**

From the `extension` directory:

```bash
cd /home/andresl/Projects/recost/extension
npm run build:ext
node dist/cli/scan.js /home/andresl/Projects/recost/extension_benchmark/langchain-openai/src --format json | head -50
```

Confirm the scanner finds *roughly* the endpoints you annotated. If the scanner finds 0 and you annotated 20, something is wrong with the paths. (Do NOT tune `expected.json` to match scanner output — that defeats the purpose.)

- [ ] **Step 6: Commit and push**

```bash
cd /home/andresl/Projects/recost/extension_benchmark
git add langchain-openai/
git commit -m "feat: add langchain-openai fixture (~N files, ~M endpoints)"
git push -u origin fixture/langchain-openai
```

- [ ] **Step 7: Open PR to `extension_benchmark` main**

```bash
gh pr create --repo recost-dev/extension_benchmark --title "Add langchain-openai fixture" --body "First fixture in the v1 corpus. ~N files vendored from langchain-ai/langchain @ <sha>. ~M expected endpoints, ~K expected findings. See FIXTURE.md for scope."
```

#### Task 2B.2: `openai-cookbook` fixture

**Slug:** `openai-cookbook`
**Surface tested:** Canonical OpenAI SDK chains, baseline detection (pairs with A6)
**Source:** `openai/openai-cookbook` (MIT-licensed)

Same step structure as Task 2B.1, swapping in the relevant upstream repo and files. Pick 5–8 cookbook examples that exercise canonical SDK usage (chat completions, embeddings, image generation, function calling). Each cookbook file is usually self-contained — easy to vendor.

- [ ] **Step 1:** `git checkout -b fixture/openai-cookbook` in `extension_benchmark`.
- [ ] **Step 2:** Vendor 5–8 .py or .ts files.
- [ ] **Step 3:** Write `openai-cookbook/FIXTURE.md`.
- [ ] **Step 4:** Write `openai-cookbook/expected.json`.
- [ ] **Step 5:** Sanity-check with live scanner.
- [ ] **Step 6:** Commit and push branch.
- [ ] **Step 7:** Open PR.

#### Task 2B.3: `stripe-sample` fixture

**Slug:** `stripe-sample`
**Surface tested:** Stripe SDK + object-literal handling (pairs with A6)
**Source:** Pick one repo from `stripe-samples/*` (most are MIT). `checkout-one-time-payments-server-node` is a reasonable target.

Same step structure as 2B.1.

- [ ] **Step 1:** `git checkout -b fixture/stripe-sample` in `extension_benchmark`.
- [ ] **Step 2:** Vendor 5–15 .ts/.js files containing Stripe SDK calls. Include a config file with object literals containing method-chain-like strings to test A6.
- [ ] **Step 3:** Write `stripe-sample/FIXTURE.md`.
- [ ] **Step 4:** Write `stripe-sample/expected.json`. Use provider `"stripe"`, methods like `"charges.create"`, `"checkout.sessions.create"`.
- [ ] **Step 5:** Sanity-check with live scanner.
- [ ] **Step 6:** Commit and push branch.
- [ ] **Step 7:** Open PR.

#### Task 2B.4: `bedrock-raw-fetch` fixture

**Slug:** `bedrock-raw-fetch`
**Surface tested:** AWS Bedrock SDK + raw `fetch` to known host (pairs with A2, A7)
**Source:** A minimal Bedrock demo from `aws-samples/*` OR a hand-vendored mini-app. Confirm Apache-2.0 license.

- [ ] **Step 1:** `git checkout -b fixture/bedrock-raw-fetch` in `extension_benchmark`.
- [ ] **Step 2:** Vendor or hand-write a small Bedrock demo: SDK-style invocation + a raw `fetch` to `https://bedrock-runtime.<region>.amazonaws.com/...`. 10-20 files.
- [ ] **Step 3:** Write `bedrock-raw-fetch/FIXTURE.md`.
- [ ] **Step 4:** Write `bedrock-raw-fetch/expected.json`. Provider `"aws-bedrock"` (verify canonical id in `provider-normalization.ts`).
- [ ] **Step 5:** Sanity-check with live scanner.
- [ ] **Step 6:** Commit and push branch.
- [ ] **Step 7:** Open PR.

#### Task 2B.5: `flask-mixed-providers` fixture

**Slug:** `flask-mixed-providers`
**Surface tested:** Python coverage, mixed SDK + raw HTTP (pairs with Python detector, A2)
**Source:** A small Flask app calling 2-3 providers (LangChain demo, Replicate demo, or hand-curated). Confirm MIT/Apache-2.0.

- [ ] **Step 1:** `git checkout -b fixture/flask-mixed-providers` in `extension_benchmark`.
- [ ] **Step 2:** Vendor 10-20 .py files: Flask routes, 2-3 provider helpers (OpenAI + at least one other like Anthropic or Replicate), at least one raw `requests.post(...)` call.
- [ ] **Step 3:** Write `flask-mixed-providers/FIXTURE.md`.
- [ ] **Step 4:** Write `flask-mixed-providers/expected.json` covering each call.
- [ ] **Step 5:** Sanity-check with live scanner.
- [ ] **Step 6:** Commit and push branch.
- [ ] **Step 7:** Open PR.

---

## Phase 3 — Integration (sequential, in `extension`, after all 6 Phase 2 streams merge)

Prerequisites: Phase 2A merged to `claude/d1-benchmark-gate` branch in `extension`. All 5 Phase 2B PRs merged into `extension_benchmark` `main`.

### Task 3.1: Pin the fixtures SHA

**Files:**
- Create: `.benchmark-fixtures-sha`

- [ ] **Step 1: Get the current `extension_benchmark` main SHA**

```bash
cd /home/andresl/Projects/recost/extension_benchmark
git checkout main && git pull
git rev-parse HEAD
```

Save the output as `<SHA>`.

- [ ] **Step 2: Write the SHA file in extension**

```bash
cd /home/andresl/Projects/recost/extension
echo "<SHA>" > .benchmark-fixtures-sha
```

- [ ] **Step 3: Commit**

```bash
git add .benchmark-fixtures-sha
git commit -m "feat(benchmark): pin extension_benchmark to <SHA-first-7>"
```

### Task 3.2: Generate initial baseline and update measurement.md

**Files:**
- Create: `benchmark/baseline.json`
- Modify: `docs/accuracy/measurement.md` — replace "TBD" values in the Initial baseline table

- [ ] **Step 1: Run benchmark with `--update-baseline`**

```bash
npm run benchmark -- --update-baseline
```

Expected: console report with five real metric values; `benchmark/baseline.json` is written with those values.

- [ ] **Step 2: Read the metrics from the report**

Inspect the printed report. Note the 5 percentages.

- [ ] **Step 3: Update `docs/accuracy/measurement.md`**

Replace the table:

```markdown
### Initial baseline (to be measured)
| Metric | Value |
|---|---|
| Detection precision | TBD |
...
```

with:

```markdown
### Initial baseline (measured 2026-05-13)
| Metric | Value |
|---|---|
| Detection precision | XX.XX% |
| Detection recall | XX.XX% |
| Provider attribution accuracy | XX.XX% |
| Finding precision | XX.XX% |
| Finding recall | XX.XX% |

Baseline committed in `benchmark/baseline.json`. PRs that drop any metric by > 1pp fail CI.
```

(Replace XX.XX% with the actual numbers.)

- [ ] **Step 4: Commit**

```bash
git add benchmark/baseline.json docs/accuracy/measurement.md
git commit -m "feat(benchmark): commit initial baseline"
```

### Task 3.3: Add the CI workflow

**Files:**
- Create: `.github/workflows/benchmark.yml`

- [ ] **Step 1: Write the workflow**

Create `.github/workflows/benchmark.yml`:

```yaml
name: benchmark

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

concurrency:
  group: benchmark-${{ github.workflow }}-${{ github.head_ref || github.ref }}
  cancel-in-progress: true

jobs:
  benchmark:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - name: Checkout extension
        uses: actions/checkout@v4

      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: "20"
          cache: "npm"

      - name: Install deps
        run: npm ci

      - name: Build extension
        run: npm run build:ext

      - name: Read fixtures SHA
        id: sha
        run: echo "value=$(cat .benchmark-fixtures-sha)" >> "$GITHUB_OUTPUT"

      - name: Clone fixtures repo at pinned SHA
        run: |
          git clone --depth 1 https://github.com/recost-dev/extension_benchmark.git benchmark-fixtures
          cd benchmark-fixtures
          git fetch --depth 1 origin ${{ steps.sha.outputs.value }}
          git checkout ${{ steps.sha.outputs.value }}

      - name: Run benchmark
        run: npm run benchmark -- --fixtures ./benchmark-fixtures --report benchmark/report.json

      - name: Upload report artifact
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: benchmark-report
          path: benchmark/report.json
          if-no-files-found: ignore
```

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/benchmark.yml
git commit -m "feat(ci): add benchmark gate workflow"
```

### Task 3.4: Verify the gate fails on regression

- [ ] **Step 1: Create a branch that deliberately regresses the scanner**

```bash
git checkout -b verify/d1-regression-smoke
```

Edit any easy provider-detection branch in `src/scanner/endpoint-classification.ts` to mis-classify one provider (e.g., temporarily map `api.openai.com` to `"unknown"`). The exact edit doesn't matter as long as it breaks detection precision.

- [ ] **Step 2: Run benchmark locally; confirm gate fires**

```bash
npm run benchmark
```

Expected: exits non-zero, prints "FAIL: N metric(s) dropped > 1pp".

- [ ] **Step 3: Revert the regression and delete the verify branch**

```bash
git checkout -- src/scanner/endpoint-classification.ts
git checkout claude/d1-benchmark-gate
git branch -D verify/d1-regression-smoke
```

- [ ] **Step 4: Push and open the integrating PR**

```bash
git push -u origin claude/d1-benchmark-gate
gh pr create --title "D1: benchmark corpus + CI accuracy gate (closes #86)" --body "$(cat <<'EOF'
## Summary
- Adds \`benchmark/runner.ts\`, \`metrics.ts\`, \`schema.ts\`, \`report.ts\` and a \`_smoke/\` fixture in this repo.
- Pins fixtures via \`.benchmark-fixtures-sha\` pointing at \`recost-dev/extension_benchmark\` HEAD.
- Adds \`.github/workflows/benchmark.yml\` that clones fixtures and runs the gate on every PR.
- Commits initial baseline in \`benchmark/baseline.json\`. Initial baseline table populated in \`docs/accuracy/measurement.md\`.
- Verified locally that a deliberate regression (mis-classifying openai.com) trips the gate.

## Test plan
- [ ] CI \`benchmark\` workflow runs to completion green on this PR
- [ ] Same workflow run on a deliberately-regressed branch fails

Closes #86.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-review notes

This plan covers all spec acceptance criteria:

| Spec requirement | Covered by |
|---|---|
| ≥5 hand-labeled fixtures with expected.json + FIXTURE.md | Tasks 2B.1–2B.5 |
| Runner, metrics, schema, report in extension repo | Tasks 1.1, 2A.1, 2A.2 |
| Smoke fixture in-repo | Task 1.2 |
| .benchmark-fixtures-sha pinned | Task 3.1 |
| npm run benchmark + benchmark:smoke scripts | Task 2A.2 step 3 |
| baseline.json committed | Task 3.2 |
| measurement.md initial baseline updated | Task 3.2 |
| benchmark.yml runs on every PR | Task 3.3 |
| Gate fails when precision/recall drops > 1pp, verified | Task 3.4 |
| metrics.ts unit-tested (exact match, ±2 tolerance, miss, FP, provider mismatch) | Task 2A.1 (8 test cases) |
| benchmark/README.md | Task 2A.3 |

No placeholders. No "TODO". Every code step has complete code.

Two implementation risks to watch:
- The `rootDir: "."` change in `tsconfig.scanner-tests.json` shifts where every compiled test lands. Task 1.1 step 4 calls this out; verify and update all paths in the `test:scanner` script accordingly. If this gets messy, an alternative is keeping `rootDir: "src"` and creating a second `tsconfig.benchmark.json` just for `benchmark/`.
- The `detectedFromScan` flattening from `endpoints[].callSites[]` may double-count when one endpoint has multiple call sites in the same fixture file. Verify against `_smoke` output; if double-counted, dedupe by file+line within the runner before passing to `computeMetrics`.

Both are surfaced for the implementer agent to address inline if they hit them.
