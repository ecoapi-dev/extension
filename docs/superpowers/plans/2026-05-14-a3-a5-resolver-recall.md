# A3 + A5 — Resolver recall: barrel re-exports and factory/DI/aliased clients

> **For agentic workers:** REQUIRED SUB-SKILLS:
> - `superpowers:subagent-driven-development` — one implementer subagent per task, spec + quality reviewers between tasks.
> - `superpowers:dispatching-parallel-agents` — phases marked **PARALLEL** dispatch multiple Agent calls in a single message; phases marked **SEQUENTIAL** dispatch one at a time because the agents touch shared files and would conflict.
>
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lift static-analysis recall by handling two adjacent classes of "client lookup" patterns the resolver currently misses: (A3) all barrel re-export shapes including aliased / wildcard / default / nested barrels, and (A5) `.bind()`-aliased method refs, factory-returned clients, and DI constructor parameters.

**Architecture:** Two prerequisite scanner-pipeline fixes (Phase 0) that the original A3/A5 designs implicitly assumed but that don't exist on main today. Then A3 (small, mechanical) and A5 (bigger, more design choices). Each substantive phase splits into a **parallel audit** (one agent per pattern; report what already works vs. what's broken) and a **sequential fix** pass (only the broken patterns; one agent at a time because all fixes touch the same one or two source files).

**Tech Stack:** TypeScript, web-tree-sitter (existing AST infra). No new deps.

**Closes:** issue #75 (A3), issue #77 (A5).

---

## Why Phase 0 exists

The first dispatch of an earlier draft of this plan revealed two foundational bugs that block A3 and A5 outright:

1. **`scanFiles()` does not run cross-file resolution.** `runCrossFileResolution()` is invoked only inside `detectLocalWastePatternsInFiles()` (`src/scanner/core-scanner.ts:375`), not inside `scanFiles()` (line 160). So even if A1's resolver perfectly resolves a barrel-re-exported call, every consumer of `scanFiles()` (CLI, workspace-scanner, intelligence) gets the unresolved per-file matches. The waste detectors are the only consumer that benefits today. Phase 0 task **Pre-A** plumbs the resolver into `scanFiles()` so the entire scan surface reflects cross-file attribution.

2. **`export const x = new Sdk()` is not tracked by the AST scanner.** Verified empirically in the dispatch:
   - `const apiClient = new OpenAI(); apiClient.chat.completions.create(...)` → 1 AST match (works)
   - `export const apiClient = new OpenAI(); apiClient.chat.completions.create(...)` → **0 AST matches**
   - `export async function ask() { apiClient.chat.completions.create(...) }` (with non-exported const) → 1 AST match (works)

   The scanner's variable-tracking pass walks `lexical_declaration` nodes but doesn't recurse into the `export_statement` that wraps them. Phase 0 task **Pre-B** fixes this. Without it, every A3 fixture's `api.ts` (which exports its SDK client per common real-world idiom) produces no scanner matches at all and the resolver has nothing to propagate.

Both prereqs are independent (different files, different concerns). They go in parallel.

---

## Spec coverage

| Issue | Sub-criterion | Plan task |
|---|---|---|
| (Pre-req) | `scanFiles()` returns cross-file-resolved provider attribution | **Pre-A** |
| (Pre-req) | `export const x = new Sdk()` tracked in scanner varMap | **Pre-B** |
| #75 A3 | `export { x }` resolves | A3.0 baseline (re-verified after Pre-A/B) |
| #75 A3 | `export { x as y }` resolves | A3.audit (audit) → A3.fix (fix if RED) |
| #75 A3 | `export *` resolves | A3.audit (audit) → A3.fix (fix if RED) |
| #75 A3 | `export { default }` resolves | A3.audit (audit) → A3.fix or defer |
| #75 A3 | Nested barrels (2+ levels) | A3.audit (audit) → A3.fix (fix if RED) |
| #75 A3 | Imports of non-existent symbols fail gracefully | A3.audit (audit) → A3.fix (fix if RED) |
| #75 A3 | Scan time on a 1000-file repo not impacted measurably | A3.perf |
| #77 A5 | `const fn = client.method.bind(client); fn(...)` | A5.audit → A5.fix |
| #77 A5 | `const c = makeClient()` factory return | A5.audit → A5.fix |
| #77 A5 | `class S { constructor(private c: OpenAI) {} } this.c.method(...)` | A5.audit → A5.fix |
| #77 A5 | No regression on simple `const c = new OpenAI()` | covered by Pre-B's tests + audit negative-control fixtures |

---

## Execution model

**Subagent-driven development** — for every substantive task (Pre-A, Pre-B, each A3/A5 fix, FINAL), the controller:

1. Dispatches a single **implementer** with the full task text from this plan inlined into the prompt (do not make the implementer read the plan).
2. Awaits the implementer's status (DONE / BLOCKED / NEEDS_CONTEXT).
3. Dispatches a **spec compliance reviewer** subagent to verify the implementation matches the task spec.
4. If spec OK, dispatches a **code quality reviewer** subagent.
5. Loops on review fixes if either reviewer flags issues.
6. Marks task complete in TaskList and moves on.

Skip reviewer rounds only on:
- Trivial scaffolding tasks (creating fixtures alone)
- Audit tasks (the audit IS the review of current behavior)

**Parallel dispatch — when multiple Agent calls go in ONE assistant message:**
- Phase 0 (Pre-A and Pre-B): **2 parallel implementer dispatches**
- Phase 1A audit (A3.audit): **5 parallel audit dispatches** (one per re-export shape)
- Phase 2A audit (A5.audit): **3 parallel audit dispatches** (one per pattern)

**Sequential dispatch — one Agent call at a time:**
- Phase 1B (A3.fix): each fix touches `src/ast/import-resolver.ts` and/or `src/ast/cross-file-resolver.ts`; conflicts otherwise.
- Phase 2B (A5.fix): each fix touches `src/ast/ast-scanner.ts` and/or shared resolver files.

**Inter-phase gates:** the controller MUST verify Phase 0 is green (both Pre-A and Pre-B implementers report DONE + reviews pass) before dispatching Phase 1A audit. Same gate between Phase 1 and Phase 2.

---

## File structure

**Files modified by Phase 0:**
- `src/scanner/core-scanner.ts` — `scanFiles()` (Pre-A)
- `src/ast/ast-scanner.ts` — variable-tracking pass that walks `lexical_declaration` (Pre-B)

**Files modified by A3 fixes:**
- `src/ast/import-resolver.ts` — `collectExports()`, `resolveBarrelImport()`, `ExportEntry` type
- `src/ast/cross-file-resolver.ts` — `extractReExports()`, `resolveExportedMatches()`

**Files modified by A5 fixes:**
- `src/ast/ast-scanner.ts` — variable-tracking pass + call-visitor (for .bind override)
- `src/ast/import-resolver.ts` — `processFunctionParams` (constructor params), new factoryReturnMap
- `src/ast/cross-file-resolver.ts` — new post-fixpoint pass propagating factoryReturnMap

**Files created:**
- `src/test/fixtures/a3-a5/<pattern>/...` — fixture trees (one subdirectory per pattern)
- `src/test/a3-barrel-reexports.test.ts` — A3 test suite
- `src/test/a5-factory-di-aliased.test.ts` — A5 test suite

**Test wiring:** `package.json` `test:scanner` chain gets two appended entries (one per test file) at the end of each phase.

---

# Phase 0 — Prerequisites (PARALLEL)

> **Dispatch model:** TWO Agent calls in one assistant message. Pre-A and Pre-B touch different files (`core-scanner.ts` vs `ast-scanner.ts`) and are conceptually independent. Both must finish before A3.0.

## Task Pre-A — Wire `runCrossFileResolution()` into `scanFiles()`

**Files:**
- Modify: `src/scanner/core-scanner.ts` — `scanFiles()` (line 160-335)
- Test: a new behavioral test `src/test/pre-a-scanfiles-resolution.test.ts`

**Goal:** After this task, `scanFiles()` returns `ApiCallInput[]` whose `provider`, `library`, and `methodSignature` fields reflect cross-file resolution. Previously the resolver was applied only inside `detectLocalWastePatternsInFiles()`. Move the resolver into `scanFiles()` (or factor a shared helper that both call). Either approach is acceptable; pick the one with smaller diff.

- [ ] **Step 1: Read the existing pipeline.**

Read `src/scanner/core-scanner.ts` lines 160-412 in full. Note that `detectLocalWastePatternsInFiles()` (line 337) builds `perFileResults` and then calls `runCrossFileResolution(perFileResults)` (line 374) to produce an augmented match map. Note that `scanFiles()` produces `ApiCallInput[]` (a simpler shape). Decide whether to (a) refactor so both share a common resolver step, or (b) inline the resolver into `scanFiles()` and have `detectLocalWastePatternsInFiles()` call `scanFiles()` first.

Recommendation: option (a) — extract a private helper `gatherResolvedAstMatches(access)` that both functions call. Then `scanFiles()` maps the resolved matches to `ApiCallInput[]` (existing `astMatchToApiCallInput` logic), and `detectLocalWastePatternsInFiles()` keeps its detector dispatch. Smaller diff than (b) and avoids risk of changing waste-detector behavior.

- [ ] **Step 2: Write a failing test (RED).**

Create `src/test/pre-a-scanfiles-resolution.test.ts`:

```ts
import assert from "node:assert/strict";
import * as path from "node:path";
import * as fs from "node:fs";
import { setWasmDir } from "../ast/parser-loader";
import { scanFiles, type ScanFileAccess, type ScanInputFile } from "../scanner/core-scanner";

const WASM_DIR = path.join(__dirname, "..", "..", "assets", "parsers");
setWasmDir(WASM_DIR);

async function run(name: string, fn: () => void | Promise<void>): Promise<void> {
  try { await fn(); console.log(`PASS ${name}`); }
  catch (err) { console.error(`FAIL ${name}`); throw err; }
}

function buildFixtureAccess(fixtureDir: string): ScanFileAccess {
  const entries = fs.readdirSync(fixtureDir, { recursive: true }) as string[];
  const files: ScanInputFile[] = entries
    .filter((entry) => typeof entry === "string" && (entry.endsWith(".ts") || entry.endsWith(".js")))
    .map((relName) => ({
      absolutePath: path.join(fixtureDir, relName),
      relativePath: relName.replace(/\\/g, "/"),
    }));
  return {
    files,
    readFile: async (absolutePath: string) => fs.readFileSync(absolutePath, "utf-8"),
  };
}

(async () => {
  const projectRoot = path.resolve(__dirname, "..", "..");
  // Reuse the existing wrappers fixture from A1 — known to exercise the resolver.
  const fixtureDir = path.resolve(projectRoot, "src", "test", "fixtures", "wrappers");
  const calls = await scanFiles(buildFixtureAccess(fixtureDir));

  await run("Pre-A: scanFiles() output reflects cross-file resolution (callers of wrapper functions get openai provider)", () => {
    // The level1Entry.ts file calls into a 3-hop wrapper chain that bottoms out
    // at client.chat.completions.create(). After cross-file resolution, the
    // call site in level1Entry.ts should be attributed to openai.
    const level1Calls = calls.filter((c) => c.file.endsWith("level1Entry.ts"));
    const openaiCalls = level1Calls.filter((c) => c.provider === "openai");
    assert.ok(
      openaiCalls.length >= 1,
      `expected ≥1 openai call attributed to level1Entry.ts via wrapper resolution, got ${openaiCalls.length}: ${JSON.stringify(level1Calls.map((c) => ({ line: c.line, provider: c.provider, methodSig: c.methodSignature })))}`
    );
  });
})().catch((err) => { console.error(err); process.exit(1); });
```

Wire into `package.json` `test:scanner`:

```
 && node dist-test/test/pre-a-scanfiles-resolution.test.js
```

Compile + run. The test should FAIL pre-fix (matches in level1Entry.ts have no provider because scanFiles doesn't apply the resolver).

- [ ] **Step 3: Apply the fix.**

Extract a shared helper:

```ts
// In src/scanner/core-scanner.ts, near the top of the module (after imports):

interface ResolvedFileResult {
  filePath: string;
  relativePath: string;
  source: string;
  matches: AstCallMatch[];  // augmented with cross-file resolution
}

async function gatherResolvedAstMatches(
  access: ScanFileAccess,
  onProgress?: (progress: ScanProgress) => void
): Promise<ResolvedFileResult[]> {
  const files = [...access.files].sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  const perFileResults: PerFileResult[] = [];

  for (let i = 0; i < files.length; i++) {
    const entry = files[i];
    try {
      const text = await access.readFile(entry.absolutePath);
      const ext = path.extname(entry.relativePath);
      if (getLanguageForExtension(ext)) {
        try {
          const result = await scanFileWithAst(entry.absolutePath, async (fp: string) => {
            try { return await access.readFile(fp); } catch { return null; }
          });
          perFileResults.push({
            filePath: entry.absolutePath,
            relativePath: entry.relativePath,
            source: text,
            result,
          });
        } catch { /* fall through; non-ast file */ }
      }
    } catch { /* skip unreadable */ }
    onProgress?.({ file: entry.relativePath, fileIndex: i + 1, fileTotal: files.length });
  }

  let augmented: Map<string, AstCallMatch[]>;
  try {
    augmented = runCrossFileResolution(perFileResults);
  } catch {
    augmented = new Map(perFileResults.map((pf) => [pf.relativePath, pf.result.matches]));
  }

  return perFileResults.map((pf) => ({
    filePath: pf.filePath,
    relativePath: pf.relativePath,
    source: pf.source,
    matches: augmented.get(pf.relativePath) ?? pf.result.matches,
  }));
}
```

Then refactor `scanFiles()` to use it. Specifically, replace the per-file AST scan loop (lines ~177-209) with a single up-front call to `gatherResolvedAstMatches()`. The regex passes (lines 211+) stay where they are — they consume the per-file `text` and `lines` and don't depend on cross-file resolution.

The new `scanFiles()` shape:

```ts
export async function scanFiles(
  access: ScanFileAccess,
  onProgress?: (progress: ScanProgress) => void
): Promise<ApiCallInput[]> {
  const resolvedFiles = await gatherResolvedAstMatches(access, onProgress);
  const allCalls: ApiCallInput[] = [];
  const dedupe = new Set<string>();

  for (const rf of resolvedFiles) {
    const lines = rf.source.split("\n");
    const astCoveredLines = new Set<number>();

    for (const match of rf.matches) {
      // Same Phase 1/2 gates as today (lines 187-197 in current code):
      if (match.packageName && STDLIB_DENYLIST.has(match.packageName)) continue;
      const fp = (match.provider && match.methodChain)
        ? lookupMethod(match.provider, match.methodChain) : null;
      const knownSdkProvider = match.provider ? isRegisteredProvider(match.provider) : false;
      const knownHttpHost = match.kind === "http" && !!match.provider;
      if (!fp && !knownSdkProvider && !knownHttpHost) continue;

      const apiCall = astMatchToApiCallInput(match, rf.relativePath);
      const key = `${rf.relativePath}:${match.line}:${apiCall.method}:${apiCall.url}`;
      if (dedupe.has(key)) continue;
      dedupe.add(key);
      astCoveredLines.add(match.line);
      allCalls.push(apiCall);
    }

    // Existing regex passes — copy the inner body (lines ~211-322) verbatim.
    // (regex passes were not touched; just relocated to operate on rf.source/lines)
    // ...
  }

  return allCalls;
}
```

Refactor `detectLocalWastePatternsInFiles()` (line 337) similarly to use `gatherResolvedAstMatches()` instead of duplicating the per-file scan + cross-file-resolution boilerplate. After the refactor, `runCrossFileResolution()` is called from exactly one place.

- [ ] **Step 4: Verify.**

```bash
cd /home/andresl/Projects/recost/extension-a3-a5
npm test 2>&1 | tail -20
```

`Pre-A` test must PASS. Existing tests must STILL pass. In particular, `ast-cross-file-resolver.test.ts`, `a1-multi-hop-wrappers.test.ts`, and the C1/A2/A6/A7 test suites must remain green — those depend on exact resolver behavior.

If `npm run benchmark` shows ANY metric drop (gate threshold 1pp), STOP and investigate before committing. Resolver-into-scanFiles is a behavioral change; even though it should only ADD provider attributions (never remove), an unexpected interaction is possible.

- [ ] **Step 5: Commit.**

```bash
git add src/scanner/core-scanner.ts src/test/pre-a-scanfiles-resolution.test.ts package.json
git commit -m "fix(scanner): wire cross-file resolution into scanFiles() so all consumers see resolved provider attribution (prereq for #75/#77)"
```

---

## Task Pre-B — Track `export const x = new Sdk()` in scanner varMap

**Files:**
- Modify: `src/ast/ast-scanner.ts` — variable-tracking pass (search for the section that walks `lexical_declaration` and populates `varMap`)
- Test: a new behavioral test `src/test/pre-b-export-const-tracking.test.ts`

**Goal:** After this task, the AST scanner's variable-tracking pass walks `lexical_declaration` whether it's wrapped in an `export_statement` or not. Currently:
- `const x = new OpenAI(); x.chat.completions.create(...)` → 1 match ✓
- `export const x = new OpenAI(); x.chat.completions.create(...)` → 0 matches ✗

This is a recall regression on a very common real-world pattern (modules export their configured client).

- [ ] **Step 1: Read the variable-tracking pass.**

In `src/ast/ast-scanner.ts`, find the function that builds `varMap` from top-level `lexical_declaration` nodes. It's likely near `processVariableAssignment` or similar — search for `varMap.set` and trace back to the loop that produces those calls. The current logic almost certainly checks `node.type === "lexical_declaration"` directly and skips `export_statement` wrappers.

- [ ] **Step 2: Write a failing test.**

Create `src/test/pre-b-export-const-tracking.test.ts`:

```ts
import assert from "node:assert/strict";
import * as path from "node:path";
import * as fs from "node:fs";
import { setWasmDir } from "../ast/parser-loader";
import { scanFileWithAst } from "../ast/ast-scanner";

const WASM_DIR = path.join(__dirname, "..", "..", "assets", "parsers");
setWasmDir(WASM_DIR);

async function run(name: string, fn: () => void | Promise<void>): Promise<void> {
  try { await fn(); console.log(`PASS ${name}`); }
  catch (err) { console.error(`FAIL ${name}`); throw err; }
}

(async () => {
  const projectRoot = path.resolve(__dirname, "..", "..");
  const fixtureDir = path.resolve(projectRoot, "src", "test", "fixtures", "pre-b");
  fs.mkdirSync(fixtureDir, { recursive: true });

  const fp = path.join(fixtureDir, "exported-client.ts");
  fs.writeFileSync(fp, `
import OpenAI from "openai";

export const apiClient = new OpenAI();

export async function ask(prompt: string): Promise<string> {
  const r = await apiClient.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
  });
  return r.choices[0].message.content ?? "";
}
`.trimStart());

  await run("Pre-B: AST scanner tracks `export const x = new OpenAI()` and resolves x.method() to openai", async () => {
    const result = await scanFileWithAst(fp, async (p) => fs.readFileSync(p, "utf-8"));
    const openaiMatches = result.matches.filter((m) => m.provider === "openai");
    assert.ok(
      openaiMatches.length >= 1,
      `expected ≥1 openai match in exported-client.ts, got ${openaiMatches.length}: ${JSON.stringify(result.matches.map((m) => ({ line: m.line, provider: m.provider, methodChain: m.methodChain })))}`
    );
  });
})().catch((err) => { console.error(err); process.exit(1); });
```

Wire into `package.json`:
```
 && node dist-test/test/pre-b-export-const-tracking.test.js
```

Run, expect FAIL.

- [ ] **Step 3: Apply the fix.**

In `src/ast/ast-scanner.ts`, find the loop that iterates top-level statements (likely `for (let i = 0; i < tree.rootNode.childCount; i++)` or similar). Where the body checks `stmt.type === "lexical_declaration"`, also unwrap `export_statement`:

```ts
function unwrapExport(stmt: SyntaxNode): SyntaxNode {
  if (stmt.type === "export_statement") {
    // export_statement wraps either a declaration or an export-clause.
    // For `export const x = ...`, it wraps a lexical_declaration.
    for (let i = 0; i < stmt.namedChildCount; i++) {
      const child = stmt.namedChild(i);
      if (child && (
        child.type === "lexical_declaration" ||
        child.type === "function_declaration" ||
        child.type === "class_declaration" ||
        child.type === "variable_declaration"  // tree-sitter sometimes uses this for `var`
      )) {
        return child;
      }
    }
  }
  return stmt;
}
```

Then in the variable-tracking loop:
```ts
for (let i = 0; i < tree.rootNode.childCount; i++) {
  const rawStmt = tree.rootNode.child(i);
  if (!rawStmt) continue;
  const stmt = unwrapExport(rawStmt);   // ← unwrap before type-checking
  if (stmt.type === "lexical_declaration") {
    // existing variable-tracking logic
  }
  // similar for function_declaration / class_declaration if those passes also exist
}
```

Apply the same unwrap to any other top-level passes in `ast-scanner.ts` that match on `function_declaration`, `class_declaration`, etc. — they're all subject to the same `export ` wrapping issue.

If the file's variable-tracking is in a separate module (`call-visitor.ts` or a helper), apply the unwrap there.

- [ ] **Step 4: Verify.**

```bash
npm test 2>&1 | tail -20
```

Pre-B test must PASS. Pre-A test (just landed) must STILL pass. All existing tests still PASS — especially `ast-call-visitor.test.ts`, `ast-scanner.test.ts`, and the cross-file tests. Run `npm run benchmark` to confirm no regression.

- [ ] **Step 5: Commit.**

```bash
git add src/ast/ast-scanner.ts src/test/pre-b-export-const-tracking.test.ts src/test/fixtures/pre-b/ package.json
git commit -m "fix(ast): track \`export const x = new Sdk()\` by unwrapping export_statement before variable-tracking (prereq for #75/#77)"
```

---

# Phase 1A — A3 audit (PARALLEL — 5 agents)

> **Dispatch model:** Five Agent calls in ONE assistant message. Each agent owns one re-export shape. Each writes its own fixture under `src/test/fixtures/a3-a5/<shape>/`, appends its own test case to `src/test/a3-barrel-reexports.test.ts`, runs the test, and reports PASS or FAIL with the exact failure message. NO source changes — just empirical audit.
>
> **Inter-agent conflict guard:** the test file `src/test/a3-barrel-reexports.test.ts` is the only shared file. Each agent gets its own `await run("...", ...)` block to append. To avoid race conditions on file edits, the controller (not the agent) is responsible for **creating the test file** with the Phase 0 baseline test BEFORE dispatching the parallel audit. Each agent then APPENDs a single new run-block; the controller merges any conflicts at the end of the phase by reading the file and reconciling if two agents stepped on each other.
>
> Better still: have the controller pre-allocate insertion-points by writing the file with five empty `// AGENT-A3.X-INSERT-HERE` comments before dispatching. Each audit agent replaces its own marker comment with their `await run(...)` block. Single-agent edits, no merge conflicts.

## Task A3.0 — Controller bootstrap: create the A3 test file with five marker comments

**Run by controller** (not subagent — too small for dispatch overhead).

- [ ] Create `src/test/fixtures/a3-a5/barrel-direct/api.ts`, `index.ts`, `consumer.ts` (the already-working baseline; see Phase 0 detail above).

- [ ] Create `src/test/a3-barrel-reexports.test.ts` with the bootstrap baseline test PLUS five marker comments:

```ts
import assert from "node:assert/strict";
import * as path from "node:path";
import * as fs from "node:fs";
import { setWasmDir } from "../ast/parser-loader";
import { scanFiles, type ScanFileAccess, type ScanInputFile } from "../scanner/core-scanner";

const WASM_DIR = path.join(__dirname, "..", "..", "assets", "parsers");
setWasmDir(WASM_DIR);

async function run(name: string, fn: () => void | Promise<void>): Promise<void> {
  try { await fn(); console.log(`PASS ${name}`); }
  catch (err) { console.error(`FAIL ${name}`); throw err; }
}

function buildFixtureAccess(fixtureDir: string): ScanFileAccess {
  const entries = fs.readdirSync(fixtureDir, { recursive: true }) as string[];
  const files: ScanInputFile[] = entries
    .filter((entry) => typeof entry === "string" && (entry.endsWith(".ts") || entry.endsWith(".js")))
    .map((relName) => ({
      absolutePath: path.join(fixtureDir, relName),
      relativePath: relName.replace(/\\/g, "/"),
    }));
  return {
    files,
    readFile: async (absolutePath: string) => fs.readFileSync(absolutePath, "utf-8"),
  };
}

(async () => {
  const projectRoot = path.resolve(__dirname, "..", "..");
  const root = path.resolve(projectRoot, "src", "test", "fixtures", "a3-a5");

  await run("A3.0 baseline: direct re-export `export { x } from './foo'` resolves to openai", async () => {
    const calls = await scanFiles(buildFixtureAccess(path.join(root, "barrel-direct")));
    const consumerCalls = calls.filter((c) => c.file.endsWith("consumer.ts"));
    const openaiCalls = consumerCalls.filter((c) => c.provider === "openai");
    assert.ok(openaiCalls.length >= 1, `baseline failed: ${openaiCalls.length} calls`);
  });

  // AGENT-A3.audit.aliased-INSERT-HERE
  // AGENT-A3.audit.wildcard-INSERT-HERE
  // AGENT-A3.audit.nested-INSERT-HERE
  // AGENT-A3.audit.default-INSERT-HERE
  // AGENT-A3.audit.missing-INSERT-HERE
})().catch((err) => { console.error(err); process.exit(1); });
```

Wire into `package.json` `test:scanner`:
```
 && node dist-test/test/a3-barrel-reexports.test.js
```

Compile + run baseline. Must PASS now (Pre-A and Pre-B together make it work). If FAIL, STOP and debug Phase 0 before continuing.

## Audit task template — five parallel dispatches

Each of the five audit agents gets a prompt of this shape (substitute the per-agent SHAPE, FIXTURE_FILES, TEST_CODE, MARKER):

```
You are an AUDIT subagent. Work in /home/andresl/Projects/recost/extension-a3-a5.
Your task is to AUDIT whether the existing resolver handles a specific re-export shape, NOT to fix it.

## Shape: <SHAPE_NAME, e.g. "aliased re-export `export { x as y }`">

## Step 1 — Create the fixture

<FIXTURE_FILES — full file paths and contents, see per-task sections below>

## Step 2 — Insert your test case

In `src/test/a3-barrel-reexports.test.ts`, REPLACE the marker comment `<MARKER>` with this run-block:

<TEST_CODE>

DO NOT touch any other test case or fixture file. DO NOT modify import-resolver.ts, cross-file-resolver.ts, or any other source file.

## Step 3 — Run + report

Run:
  cd /home/andresl/Projects/recost/extension-a3-a5
  npm run build:ext && npx tsc -p tsconfig.scanner-tests.json && node dist-test/test/a3-barrel-reexports.test.js

Report back:
- DONE / BLOCKED
- PASS or FAIL (with the failure message if FAIL)
- Files created/modified
- Any concerns about whether the fixture truly tests the shape

DO NOT commit. The controller commits the audit phase as one atomic block after all 5 agents return.
```

The five sub-tasks below give the SHAPE/FIXTURE_FILES/TEST_CODE/MARKER for each agent.

### A3.audit.aliased — `export { x as y }`

- **MARKER:** `// AGENT-A3.audit.aliased-INSERT-HERE`
- **FIXTURE_FILES:**
  - `src/test/fixtures/a3-a5/barrel-aliased/api.ts`:
    ```ts
    import OpenAI from "openai";
    const client = new OpenAI();
    export async function _internalAsk(prompt: string): Promise<string> {
      const r = await client.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: prompt }],
      });
      return r.choices[0].message.content ?? "";
    }
    ```
  - `src/test/fixtures/a3-a5/barrel-aliased/index.ts`:
    ```ts
    export { _internalAsk as ask } from "./api";
    ```
  - `src/test/fixtures/a3-a5/barrel-aliased/consumer.ts`:
    ```ts
    import { ask } from "./index";
    export async function handle(q: string): Promise<string> { return ask(q); }
    ```
- **TEST_CODE:**
  ```ts
  await run("A3.audit.aliased: `export { x as y }` re-export resolves consumer call to openai", async () => {
    const calls = await scanFiles(buildFixtureAccess(path.join(root, "barrel-aliased")));
    const consumerCalls = calls.filter((c) => c.file.endsWith("consumer.ts"));
    const openaiCalls = consumerCalls.filter((c) => c.provider === "openai");
    assert.ok(openaiCalls.length >= 1, `aliased re-export failed: got ${openaiCalls.length} calls: ${JSON.stringify(consumerCalls.map((c) => ({ line: c.line, provider: c.provider })))}`);
  });
  ```

### A3.audit.wildcard — `export *`

- **MARKER:** `// AGENT-A3.audit.wildcard-INSERT-HERE`
- **FIXTURE_FILES:**
  - `src/test/fixtures/a3-a5/barrel-wildcard/api.ts` — copy of `barrel-direct/api.ts` (exports `ask` directly)
  - `src/test/fixtures/a3-a5/barrel-wildcard/index.ts`:
    ```ts
    export * from "./api";
    ```
  - `src/test/fixtures/a3-a5/barrel-wildcard/consumer.ts` — copy of `barrel-direct/consumer.ts`
- **TEST_CODE:**
  ```ts
  await run("A3.audit.wildcard: `export *` re-export resolves consumer call to openai", async () => {
    const calls = await scanFiles(buildFixtureAccess(path.join(root, "barrel-wildcard")));
    const consumerCalls = calls.filter((c) => c.file.endsWith("consumer.ts"));
    const openaiCalls = consumerCalls.filter((c) => c.provider === "openai");
    assert.ok(openaiCalls.length >= 1, `wildcard re-export failed: got ${openaiCalls.length} calls`);
  });
  ```

### A3.audit.nested — nested barrels (2+ levels)

- **MARKER:** `// AGENT-A3.audit.nested-INSERT-HERE`
- **FIXTURE_FILES:**
  - `src/test/fixtures/a3-a5/barrel-nested/providers/openai.ts` — copy of `barrel-direct/api.ts`
  - `src/test/fixtures/a3-a5/barrel-nested/providers/index.ts`:
    ```ts
    export { ask } from "./openai";
    ```
  - `src/test/fixtures/a3-a5/barrel-nested/index.ts`:
    ```ts
    export { ask } from "./providers";
    ```
  - `src/test/fixtures/a3-a5/barrel-nested/consumer.ts`:
    ```ts
    import { ask } from "./index";
    export async function handle(q: string): Promise<string> { return ask(q); }
    ```
- **TEST_CODE:**
  ```ts
  await run("A3.audit.nested: 2-level nested barrels (`index → providers → openai`) resolve consumer call", async () => {
    const calls = await scanFiles(buildFixtureAccess(path.join(root, "barrel-nested")));
    const consumerCalls = calls.filter((c) => c.file.endsWith("consumer.ts"));
    const openaiCalls = consumerCalls.filter((c) => c.provider === "openai");
    assert.ok(openaiCalls.length >= 1, `nested barrel failed: got ${openaiCalls.length} calls`);
  });
  ```

### A3.audit.default — `export { default } from`

- **MARKER:** `// AGENT-A3.audit.default-INSERT-HERE`
- **FIXTURE_FILES:**
  - `src/test/fixtures/a3-a5/barrel-default/api.ts`:
    ```ts
    import OpenAI from "openai";
    const client = new OpenAI();
    export default async function ask(prompt: string): Promise<string> {
      const r = await client.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: prompt }],
      });
      return r.choices[0].message.content ?? "";
    }
    ```
  - `src/test/fixtures/a3-a5/barrel-default/index.ts`:
    ```ts
    export { default } from "./api";
    ```
  - `src/test/fixtures/a3-a5/barrel-default/consumer.ts`:
    ```ts
    import ask from "./index";
    export async function handle(q: string): Promise<string> { return ask(q); }
    ```
- **TEST_CODE:**
  ```ts
  await run("A3.audit.default: `export { default } from` resolves consumer's default import to openai", async () => {
    const calls = await scanFiles(buildFixtureAccess(path.join(root, "barrel-default")));
    const consumerCalls = calls.filter((c) => c.file.endsWith("consumer.ts"));
    const openaiCalls = consumerCalls.filter((c) => c.provider === "openai");
    assert.ok(openaiCalls.length >= 1, `default re-export failed: got ${openaiCalls.length} calls`);
  });
  ```

### A3.audit.missing — non-existent symbol in barrel (graceful failure)

- **MARKER:** `// AGENT-A3.audit.missing-INSERT-HERE`
- **FIXTURE_FILES:**
  - `src/test/fixtures/a3-a5/barrel-missing/api.ts` — exports `ask` only (no `summarize`)
  - `src/test/fixtures/a3-a5/barrel-missing/index.ts`:
    ```ts
    export { ask, summarize } from "./api";
    ```
  - `src/test/fixtures/a3-a5/barrel-missing/consumer.ts`:
    ```ts
    import { summarize } from "./index";
    export async function handle(q: string): Promise<string> { return summarize(q); }
    ```
- **TEST_CODE:**
  ```ts
  await run("A3.audit.missing: barrel re-exports a non-existent symbol; scan completes without throwing", async () => {
    const calls = await scanFiles(buildFixtureAccess(path.join(root, "barrel-missing")));
    assert.ok(Array.isArray(calls), "scanFiles must return an array even with broken barrels");
  });
  ```

## Audit phase wrap-up

After all 5 agents return, the controller:

- [ ] Runs the full test file once: `node dist-test/test/a3-barrel-reexports.test.js`
- [ ] Records which audit tests PASSED and which FAILED. PASSED = no fix needed in Phase 1B. FAILED = needs a fix dispatch.
- [ ] Commits the audit-phase artifacts as ONE atomic commit:
  ```bash
  git add src/test/fixtures/a3-a5/ src/test/a3-barrel-reexports.test.ts
  git commit -m "test(a3): empirical audit of 5 re-export shapes (passing: <list>, failing: <list>)"
  ```

---

# Phase 1B — A3 fixes (SEQUENTIAL)

> **Dispatch model:** ONE Agent call at a time. Each fix touches `src/ast/import-resolver.ts` and/or `src/ast/cross-file-resolver.ts`; concurrent dispatches would conflict.
>
> Only dispatch fix tasks for shapes that FAILED in Phase 1A. If a shape unexpectedly passes (e.g. it was already handled by Pre-A's resolver plumbing), record it in the FINAL commit message but skip the fix.

## Task A3.fix.aliased — capture export aliases

**ONLY dispatch if A3.audit.aliased FAILED.**

**Files:**
- Modify: `src/ast/import-resolver.ts` — `collectExports()` (line ~285), `ExportEntry` type (line ~278), `resolveBarrelImport()` (line ~319)
- Modify: `src/ast/cross-file-resolver.ts` — `extractReExports()` (line ~220)

- [ ] **Step 1: Read** the current `collectExports()` and `ExportEntry`. Note that line 302-303 captures `spec.child(0).text` — the original name, not the alias. The exported name (what consumers import) IS the alias when present.

- [ ] **Step 2: Extend `ExportEntry`** to carry both names:
  ```ts
  interface ExportEntry {
    /** Name consumers import (alias if present, else original) */
    exportedName: string | null;
    /** Name as defined in the source file (used to resolve the actual import) */
    originalName?: string;
    sourcePath: string;
  }
  ```

- [ ] **Step 3: Update `collectExports()`** to capture the alias via field name lookup:
  ```ts
  if (exportClause) {
    for (let j = 0; j < exportClause.childCount; j++) {
      const spec = exportClause.child(j);
      if (!spec || spec.type !== "export_specifier") continue;
      const aliasNode = spec.childForFieldName("alias");
      const nameNode = spec.childForFieldName("name") ?? spec.child(0);
      const exportedName = (aliasNode ?? nameNode)?.text;
      const originalName = nameNode?.text;
      if (exportedName) entries.push({ exportedName, sourcePath, originalName });
    }
  } else {
    entries.push({ exportedName: null, sourcePath });
  }
  ```

- [ ] **Step 4: Update `resolveBarrelImport()`** at the source-file lookup (around line 374):
  ```ts
  const lookupName = entry.originalName ?? name;
  const pkg = fileImports.get(lookupName);
  ```

- [ ] **Step 5: Mirror in `cross-file-resolver.ts` `extractReExports()`.** Read the current implementation; if it's a regex like `/export\s*\{\s*([^}]+)\}\s*from\s*["']([^"']+)["']/g`, split each name on `\bas\b` and use the right-hand side as `exportedName`, the left-hand side as `originalName`. Preserve the rest of the function's behavior.

- [ ] **Step 6: Verify.** A3.audit.aliased turns from FAIL to PASS. All other tests still PASS. Benchmark gate exit 0.

- [ ] **Step 7: Commit.**
  ```bash
  git add src/ast/import-resolver.ts src/ast/cross-file-resolver.ts
  git commit -m "fix(a3): capture export aliases (\`export { x as y }\`) in barrel resolution"
  ```

## Task A3.fix.wildcard — `export *` regex / handler

**ONLY dispatch if A3.audit.wildcard FAILED.**

Likely fix is in `extractReExports()` in `cross-file-resolver.ts` — add a separate regex `/export\s*\*\s*from\s*["']([^"']+)["']/g` and emit `ExportEntry { exportedName: null, sourcePath: <captured path> }`. The wildcard sentinel was already handled in `resolveExportedMatches()` / `resolveBarrelImport()` (`entry.exportedName === null` branch); the gap is just detection.

Same TDD shape: read, fix, verify, commit. Commit message: `fix(a3): detect \`export *\` wildcard re-exports in cross-file resolver`

## Task A3.fix.nested — recurse barrel resolution

**ONLY dispatch if A3.audit.nested FAILED.**

Add a depth parameter (cap at 4) to `resolveBarrelImport()` and recurse when the source file is itself a barrel re-exporting `lookupName`:

```ts
async function resolveBarrelImport(
  importedNames: string[],
  sourceRelPath: string,
  currentFilePath: string,
  readFile: FileReader,
  parseTreeFn: (src: string) => Promise<Tree | null>,
  depth: number = 0
): Promise<Map<string, string>> {
  if (depth > 4) return new Map();
  // ... existing barrel-content load ...
  for (const name of importedNames) {
    for (const entry of barrelExports) {
      if (entry.exportedName === name || entry.exportedName === null) {
        if (!entry.sourcePath.startsWith(".")) {
          result.set(name, entry.sourcePath);
        } else {
          // ... existing source-file lookup ...
          const nested = await resolveBarrelImport(
            [lookupName], entry.sourcePath, candidate,
            readFile, parseTreeFn, depth + 1
          );
          const nestedPkg = nested.get(lookupName);
          if (nestedPkg) { result.set(name, nestedPkg); break; }
        }
      }
    }
  }
  return result;
}
```

Also bump `resolveExportedMatches()` re-export depth cap from 2 to 4 in `cross-file-resolver.ts` for symmetry.

Commit: `fix(a3): recurse barrel resolution through nested barrels (depth-cap 4)`

## Task A3.fix.default — `export { default } from`

**ONLY dispatch if A3.audit.default FAILED.**

If the implementer reports the fix is non-trivial (touches every consumer that imports defaults, special-case `default` token in `collectExports`), DEFER:

- [ ] File a follow-up issue: `A3 default re-exports support — deferred from PR XXX`
- [ ] Commit the FAILING fixture + test as a `// SKIP:` block:
  ```ts
  // SKIP A3.audit.default — deferred to follow-up issue (link)
  // await run("A3.audit.default: ...", ...);
  ```
- [ ] Skip to A3.fix.missing.

If the fix IS small (e.g. just adding a `"default"` literal handling in `collectExports`), apply it. Use judgment.

## Task A3.fix.missing — graceful failure

**ONLY dispatch if A3.audit.missing FAILED.**

If `scanFiles()` throws on a missing-symbol re-export, wrap the resolution path that throws (likely deep inside `resolveExportedMatches()` or a sibling) in try/catch returning null. The audit test only requires "no throw" — a clean null return is sufficient.

---

## Task A3.perf — performance check

- [ ] Programmatically generate 1000 trivial barrel files to a tmp dir (NOT under `src/test/fixtures/`):
  ```bash
  TMP=$(mktemp -d)
  for i in $(seq 1 1000); do
    next=$((i + 1))
    echo "export { x } from './f${next}';" > "$TMP/f${i}.ts"
  done
  echo "export const x = 42;" > "$TMP/f1001.ts"
  time node dist/cli/scan.js "$TMP" --format json > /dev/null
  rm -rf "$TMP"
  ```

- [ ] Acceptable: under 30s on a typical laptop. If 60s+, add a `Map<string, Map<string, string>>` cache to `resolveBarrelImport()` keyed by `(filePath, name)` for the duration of one resolution pass.

- [ ] Append a one-line note to `docs/accuracy/detection.md` under A3:
  > Tested 2026-05-14 against synthetic 1000-file barrel chain: scan completed in Xs.

- [ ] Commit:
  ```bash
  git add docs/accuracy/detection.md
  git commit -m "docs(a3): record perf measurement on 1000-file barrel chain"
  ```

## Task A3.gate — A3 measurement gate

- [ ] `npm test 2>&1 | tail -10` — total PASS count = 353 baseline + 2 (Pre-A, Pre-B) + 1 (A3 baseline) + N (A3.audit successes) ≈ 360
- [ ] `npm run benchmark 2>&1 | tail -15` — exit 0, no metric regressions
- [ ] If anything regressed, STOP and dispatch a debugging implementer before Phase 2

---

# Phase 2A — A5 audit (PARALLEL — 3 agents)

> **Dispatch model:** Three Agent calls in ONE assistant message. Same controller-bootstrap pattern as Phase 1A.

## Task A5.0 — Controller bootstrap: create the A5 test file with three marker comments

Create `src/test/a5-factory-di-aliased.test.ts` with the same scaffolding shape as the A3 test file, then three marker comments:

```ts
// (imports + helpers same as A3 test file)

(async () => {
  const projectRoot = path.resolve(__dirname, "..", "..");
  const root = path.resolve(projectRoot, "src", "test", "fixtures", "a5");

  // AGENT-A5.audit.bind-INSERT-HERE
  // AGENT-A5.audit.factory-INSERT-HERE
  // AGENT-A5.audit.di-INSERT-HERE
})().catch((err) => { console.error(err); process.exit(1); });
```

Wire into `package.json`:
```
 && node dist-test/test/a5-factory-di-aliased.test.js
```

Compile + run (no tests yet — IIFE just runs and exits 0).

### A5.audit.bind — `.bind()` aliasing

- **MARKER:** `// AGENT-A5.audit.bind-INSERT-HERE`
- **FIXTURE_FILES:**
  - `src/test/fixtures/a5/bind-aliased/consumer.ts`:
    ```ts
    import OpenAI from "openai";
    const client = new OpenAI();
    const askFn = client.chat.completions.create.bind(client.chat.completions);
    export async function ask(prompt: string): Promise<string> {
      const r = await askFn({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: prompt }],
      });
      return r.choices[0].message.content ?? "";
    }
    ```
- **TEST_CODE:**
  ```ts
  await run("A5.audit.bind: `.bind()`-aliased method ref resolves to openai", async () => {
    const calls = await scanFiles(buildFixtureAccess(path.join(root, "bind-aliased")));
    const consumerCalls = calls.filter((c) => c.file.endsWith("consumer.ts"));
    const openaiCalls = consumerCalls.filter((c) => c.provider === "openai");
    assert.ok(openaiCalls.length >= 1, `bind alias failed: got ${openaiCalls.length} calls`);
  });
  ```

### A5.audit.factory — factory return inference

- **MARKER:** `// AGENT-A5.audit.factory-INSERT-HERE`
- **FIXTURE_FILES:**
  - `src/test/fixtures/a5/factory-direct/client-factory.ts`:
    ```ts
    import OpenAI from "openai";
    export function makeClient(): OpenAI { return new OpenAI(); }
    ```
  - `src/test/fixtures/a5/factory-direct/consumer.ts`:
    ```ts
    import { makeClient } from "./client-factory";
    const client = makeClient();
    export async function ask(prompt: string): Promise<string> {
      const r = await client.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: prompt }],
      });
      return r.choices[0].message.content ?? "";
    }
    ```
- **TEST_CODE:**
  ```ts
  await run("A5.audit.factory: cross-file factory `makeClient()` return resolves to openai", async () => {
    const calls = await scanFiles(buildFixtureAccess(path.join(root, "factory-direct")));
    const consumerCalls = calls.filter((c) => c.file.endsWith("consumer.ts"));
    const openaiCalls = consumerCalls.filter((c) => c.provider === "openai");
    assert.ok(openaiCalls.length >= 1, `factory return failed: got ${openaiCalls.length} calls`);
  });
  ```

### A5.audit.di — DI typed constructor params

- **MARKER:** `// AGENT-A5.audit.di-INSERT-HERE`
- **FIXTURE_FILES:**
  - `src/test/fixtures/a5/di-constructor/consumer.ts`:
    ```ts
    import OpenAI from "openai";
    export class SummaryService {
      constructor(private readonly ai: OpenAI) {}
      async summarize(text: string): Promise<string> {
        const r = await this.ai.chat.completions.create({
          model: "gpt-4o-mini",
          messages: [{ role: "user", content: `Summarize: ${text}` }],
        });
        return r.choices[0].message.content ?? "";
      }
    }
    ```
- **TEST_CODE:**
  ```ts
  await run("A5.audit.di: typed constructor param `private ai: OpenAI` resolves `this.ai.method()` to openai", async () => {
    const calls = await scanFiles(buildFixtureAccess(path.join(root, "di-constructor")));
    const consumerCalls = calls.filter((c) => c.file.endsWith("consumer.ts"));
    const openaiCalls = consumerCalls.filter((c) => c.provider === "openai");
    assert.ok(openaiCalls.length >= 1, `DI constructor failed: got ${openaiCalls.length} calls`);
  });
  ```

After all 3 agents return, controller commits the audit phase as one atomic block.

---

# Phase 2B — A5 fixes (SEQUENTIAL)

## Task A5.fix.bind — `.bind()` aliasing

**ONLY dispatch if A5.audit.bind FAILED.**

Add a `.bind()` case to the scanner's variable-tracking pass. When a `lexical_declaration` initializer is `<member-expr>.bind(<args>)` AND the leftmost identifier of `<member-expr>` is in `varMap`, propagate the package to the new binding AND store the original method-chain in a sibling `methodChainAliasMap`.

In the call-visitor, when emitting an `AstCallMatch` for a call whose root identifier is in `methodChainAliasMap`, override `methodChain` with the original chain. Don't change `endpoint`.

Test thoroughly with the existing `ast-call-visitor.test.ts` suite.

Commit: `fix(a5): track .bind() method-ref aliasing in scanner varMap`

## Task A5.fix.factory — factory return inference

**ONLY dispatch if A5.audit.factory FAILED.**

Two-step:

1. **In-file factory tracking** — extend the import-resolver / scanner to detect top-level `function_declaration` whose body is a single `return` statement returning `new X()` (or `X(...)` where X is in CLASS_TO_PACKAGE). Store in a `factoryReturnMap`. When the scanner sees `const c = makeClient()` and `makeClient` is in `factoryReturnMap`, populate `varMap["c"]` with the factory's return package.

2. **Cross-file factory propagation** — extend the cross-file resolver: after the existing wrapper-fixpoint loop, build a global `(filePath, exportedFnName) → package` registry from each per-file `factoryReturnMap`. For each caller importing one of those functions, augment the caller's `varMap` (via a re-scan or post-hoc fixup pass) so subsequent `c.method()` calls in the caller get the right provider.

Choose the implementation cut that minimizes risk. If cross-file proves too invasive, ship in-file only and file a follow-up.

Commit: `fix(a5): factory return inference for single-statement \`return new X()\` functions`

## Task A5.fix.di — DI constructor params

**ONLY dispatch if A5.audit.di FAILED.**

Extend `processFunctionParams` to walk `class_declaration → class_body → method_definition(name=constructor)` and treat the constructor's typed params the same way it treats regular function params. Key the result by `<className>.constructor` and add a `thisFieldMap[className][fieldName] = package`.

Update the call-visitor: when resolving `this.<field>.<chain>`, look up `thisFieldMap[currentClassName][field]` to get the package.

Commit: `fix(a5): track typed constructor params for \`this.<field>\` access in classes`

---

## Task A5.regress — regression test for simple `new X()`

Add to `src/test/a5-factory-di-aliased.test.ts`:

```ts
await run("A5.regress: simple `const c = new OpenAI(); c.method()` still resolves (no regression from A5 changes)", async () => {
  const tmpDir = path.join(root, "_simple-regression");
  fs.mkdirSync(tmpDir, { recursive: true });
  fs.writeFileSync(path.join(tmpDir, "consumer.ts"), `
import OpenAI from "openai";
const client = new OpenAI();
export async function ask(p: string): Promise<string> {
  const r = await client.chat.completions.create({ model: "gpt-4o-mini", messages: [{ role: "user", content: p }] });
  return r.choices[0].message.content ?? "";
}
`.trimStart());
  try {
    const calls = await scanFiles(buildFixtureAccess(tmpDir));
    const consumerCalls = calls.filter((c) => c.file.endsWith("consumer.ts"));
    assert.ok(consumerCalls.some((c) => c.provider === "openai"), "simple new OpenAI() must still resolve");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
```

Run, expect PASS. Commit: `test(a5): regression check for simple new X() pattern`

## Task A5.gate — A5 measurement gate

Same shape as A3.gate. Run full test suite + benchmark. No regression allowed.

---

# Phase 3 — FINAL: docs, commit plan, push, open PR

- [ ] **Refresh docs/accuracy/detection.md** A3 (#75) and A5 (#77) sections with the actual landed scope (which patterns are supported, which were deferred).

- [ ] **Run final verification:**
  ```bash
  cd /home/andresl/Projects/recost/extension-a3-a5
  npm test 2>&1 | grep -c "^PASS "
  npm run benchmark 2>&1 | tail -10
  ```

- [ ] **Stage everything:**
  ```bash
  git status
  git add -A   # use -A here only because the controller is at the end and has manually verified what's staged
  # Or stage explicitly file by file if you prefer
  ```

- [ ] **Commit the plan + final docs:**
  ```bash
  git add docs/superpowers/plans/2026-05-14-a3-a5-resolver-recall.md docs/accuracy/detection.md
  git commit -m "..."
  ```

- [ ] **Push and open PR:**
  ```bash
  git push -u origin claude/a3-a5-resolver-recall
  gh pr create --title "fix(detection): A3 + A5 — barrel re-exports + factory/DI/aliased clients (closes #75, #77)" --body "..."
  ```

PR body should include:
- Phase 0 explanation (the two prereqs that unblocked the rest)
- Per-pattern audit results table (what was already PASS vs. what got fixed)
- Out-of-scope notes (default re-exports if deferred, cross-file factory if deferred)
- Forward-looking note: corpus-expansion follow-up issue to make these gains measurable at the D1 gate

---

## Self-review (controller)

**Spec coverage:** Top table maps every #75 and #77 sub-criterion to a task. Default re-exports (A3.audit.default → A3.fix.default) is the only stretch item that may defer.

**Risk hotspots:**
1. **Pre-A's plumbing change** is the most invasive piece — every consumer of `scanFiles()` (CLI, workspace-scanner, intelligence pipeline) starts seeing cross-file-resolved attribution. Theoretically additive only (we never REMOVE attribution), but resolver bugs could surface at the gate. The benchmark step at the end of Pre-A is the safety net.

2. **Pre-B's `export const` unwrap** could miss other top-level forms wrapped in `export_statement`. The fix should unwrap for `lexical_declaration`, `function_declaration`, `class_declaration` at minimum. Audit other passes in `ast-scanner.ts` that might be affected; the implementer should grep for `stmt.type === "lexical_declaration"` and similar to find every site.

3. **A5.fix.factory's cross-file propagation** is the largest A5 piece. The plan keeps it as a separate post-fixpoint pass to minimize blast radius. If implementation runs into the fixpoint, fall back to in-file-only and file a follow-up.

4. **No corpus measurement.** A3 and A5 will improve real-world recall but won't move the D1 baseline (corpus has no barrel chains or factory patterns today). In-repo fixtures provide regression coverage. A separate PR to `recost-dev/extension-benchmark` should add fixtures so the next baseline refresh shows the recall gain.

**Out of scope (file as follow-ups if landed):**
- A3 default re-exports if RED at A3.audit.default and the fix is non-trivial
- A5 multi-statement factory bodies (`if (...) return new X(); else return new Y()`)
- A5 factory chains (`make().withRetry().withLogger()`)
- Corpus expansion in `extension-benchmark` (separate PR there)
- Python equivalents — `import_module()`, dependency-injected fastapi services. Defer until corpus exercises it.

**Sequencing rules (controller MUST follow):**
- Phase 0 → Phase 1A: gate on both Pre-A and Pre-B passing.
- Phase 1A → Phase 1B: gate on the audit phase completing (collect PASS/FAIL list before dispatching fixes).
- Phase 1B → Phase 2A: gate on A3.gate measurement (no regression).
- Phase 2A → Phase 2B: gate on the A5 audit phase completing.
- Phase 2B → Phase 3: gate on A5.gate measurement.

---

## Execution handoff

Plan saved to `docs/superpowers/plans/2026-05-14-a3-a5-resolver-recall.md`. Worktree: `/home/andresl/Projects/recost/extension-a3-a5` on branch `claude/a3-a5-resolver-recall` (branched from `origin/main` post-#109 merged). `npm ci` complete; `npm run build:ext` clean.

**Subagent dispatch summary:**
- Phase 0 (Pre-A + Pre-B): 2 implementers in PARALLEL, 2 spec reviewers, 2 quality reviewers (sequential after impl).
- Phase 1A (A3 audit): 5 audit agents in PARALLEL (no separate review — audit IS the review of current behavior).
- Phase 1B (A3 fixes): N implementers SEQUENTIALLY (where N = number of FAILED audits), each with spec + quality reviewers.
- Phase 1C (A3.perf, A3.gate): controller runs directly (no subagent dispatch — measurement and shell commands).
- Phase 2A (A5 audit): 3 audit agents in PARALLEL.
- Phase 2B (A5 fixes): N implementers SEQUENTIALLY.
- Phase 2C (A5.regress, A5.gate): controller runs directly.
- Phase 3 (FINAL): controller runs directly.

Total dispatches: 2 + 5 + N(A3≤5) + 3 + N(A5≤3) + reviewer rounds. Worst case ~30 subagent calls; realistic case ~15-20 (fewer fixes if some patterns already work post-Phase 0).
