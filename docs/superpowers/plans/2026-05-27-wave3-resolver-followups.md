# Wave 3 — Resolver Follow-ups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close #114 (default-vs-named import disambiguation), #115 (factory-with-arguments resolution), and #116 (split `images.generate` off `batchCapable` into a new `inlineParallelCapable` flag) in one bundled PR.

**Architecture:** Two file-disjoint tracks run in parallel, then a sequential integration phase wires the new tests into CI and runs the benchmark gate. Track A (#114, #115) lives entirely in `src/ast/cross-file-resolver.ts`. Track B (#116) touches the fingerprint type defs, the AST scanner, `openai.json`, and the two waste detectors. They share **no** source files — the only shared file is `package.json` (test list), deferred to integration.

**Tech Stack:** TypeScript (strict), web-tree-sitter (WASM, AST scanning), homegrown `run(name, fn)` test harness compiled via `tsconfig.scanner-tests.json` to `dist-test/` and run with `node`.

---

## Parallelization Map

| Track | Tasks | Files (exclusive) | May run concurrently with |
|-------|-------|-------------------|---------------------------|
| **A** | A1 (#114), A2 (#115) | `src/ast/cross-file-resolver.ts` + `src/test/fixtures/a3-followup/**` + `src/test/a3-default-import-threading.test.ts` + factory fixtures/test | Track B |
| **B** | B1, B2 (#116) | `src/scanner/fingerprints/types.ts`, `src/analysis/types.ts`, `src/ast/ast-scanner.ts`, `src/scanner/fingerprints/openai.json`, `src/ast/waste/concurrency-detector.ts`, `src/ast/waste/batch-detector.ts` + `src/test/ast-inline-parallel.test.ts` | Track A |
| **C** | C1–C3 (integration) | `package.json`, runs full suite + benchmark | after A **and** B |

**Within Track A, A1 must precede A2** (same file). **Within Track B, B1 must precede B2.** Tracks A and B are independent.

**Execution note (subagent-driven, parallel):** Dispatch Track A and Track B as two concurrent subagents, each in its own git worktree off `wave3/resolver-followups` (use `superpowers:using-git-worktrees`). Each subagent compiles and runs only its own new test file directly — it does **not** edit `package.json`. After both tracks merge back, run Phase C in the main branch. If running without worktrees, do Track A fully, then Track B, then Phase C.

**Per-task test command (single file):**
```bash
npx tsc -p tsconfig.scanner-tests.json && node dist-test/test/<FILE>.test.js
```
Expected output lines are `PASS <name>` / `FAIL <name>`; a thrown assertion exits non-zero.

---

## File Structure

- `src/ast/cross-file-resolver.ts` — **modify.** `ImportedName` interface gains `isDefault`; `extractRelativeImports` populates it; `resolveExportedMatches` gains an `isDefault` param and a rewritten re-export filter; `extractFactoryCallAssignments` regex widened.
- `src/scanner/fingerprints/types.ts` — **modify.** Add `inlineParallelCapable?: boolean` to `MethodFingerprint`.
- `src/analysis/types.ts` — **modify.** Add `inlineParallelCapable?: boolean` to the two shapes that already carry `batchCapable` (lines 19 and 58).
- `src/ast/ast-scanner.ts` — **modify.** Add `inlineParallelCapable?: boolean` to `AstCallMatch`; propagate from fingerprint at the three sites that copy `batchCapable` (~660, ~802, ~826).
- `src/scanner/fingerprints/openai.json` — **modify.** `images.generate`: drop `batchCapable`, add `inlineParallelCapable`.
- `src/ast/waste/concurrency-detector.ts` — **modify.** Line 152 suppress on either flag.
- `src/ast/waste/batch-detector.ts` — **modify.** `detectNPlusOne` guard; new `detectInlineParallel`; register in `detectBatchWaste`.
- `src/test/fixtures/a3-followup/mixed-barrel/**` — **create.** Heterogeneous barrel fixture (5 files).
- `src/test/a3-default-import-threading.test.ts` — **create.**
- `src/test/fixtures/factory-args/**` — **create.** Factory fixture (consumer + factory module).
- `src/test/factory-with-args.test.ts` — **create.**
- `src/test/ast-inline-parallel.test.ts` — **create.**
- `package.json` — **modify (Phase C only).** Append the three new compiled test files to the `test:scanner` chain.

---

## TRACK A — Resolver (#114, #115)

### Task A1: #114 — default-vs-named disambiguation

**Files:**
- Create: `src/test/fixtures/a3-followup/mixed-barrel/openai-default.ts`
- Create: `src/test/fixtures/a3-followup/mixed-barrel/anthropic-named.ts`
- Create: `src/test/fixtures/a3-followup/mixed-barrel/barrel.ts`
- Create: `src/test/fixtures/a3-followup/mixed-barrel/consumer.ts`
- Create: `src/test/a3-default-import-threading.test.ts`
- Modify: `src/ast/cross-file-resolver.ts` (`ImportedName` ~178, `extractRelativeImports` ~187, `resolveExportedMatches` ~359 + call sites ~561/~608)

- [ ] **Step 1: Create the heterogeneous barrel fixture**

`openai-default.ts` (default export is a wrapper calling OpenAI):
```ts
import OpenAI from "openai";

const openai = new OpenAI();

export default async function gen(prompt: string): Promise<string> {
  const r = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
  });
  return r.choices[0]?.message?.content ?? "";
}
```

`anthropic-named.ts` (named export `ask` is a wrapper calling Anthropic — a DIFFERENT provider):
```ts
import Anthropic from "@anthropic-ai/sdk";

const anthropic = new Anthropic();

export async function ask(prompt: string): Promise<string> {
  const r = await anthropic.messages.create({
    model: "claude-opus-4-5",
    max_tokens: 256,
    messages: [{ role: "user", content: prompt }],
  });
  return r.content[0]?.type === "text" ? r.content[0].text : "";
}
```

`barrel.ts` (default re-export FIRST so the current bug triggers, named re-export second):
```ts
export { default } from "./openai-default";
export { ask } from "./anthropic-named";
```

`consumer.ts` (mixes a default import with a named import from the same barrel):
```ts
import gen, { ask } from "./barrel";

export async function handle(q: string): Promise<string> {
  const a = await gen(q);
  const b = await ask(q);
  return a + b;
}
```

- [ ] **Step 2: Write the failing test**

Create `src/test/a3-default-import-threading.test.ts`:
```ts
import assert from "node:assert/strict";
import * as path from "node:path";
import * as fs from "node:fs";
import { setWasmDir } from "../ast/parser-loader";
import { scanFiles, type ScanFileAccess, type ScanInputFile } from "../scanner/core-scanner";

const WASM_DIR = path.join(__dirname, "..", "..", "assets", "parsers");
setWasmDir(WASM_DIR);

async function run(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (err) {
    console.error(`FAIL ${name}`);
    throw err;
  }
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
  const root = path.resolve(__dirname, "..", "..", "src", "test", "fixtures", "a3-followup");

  await run("A3-followup: named import in a mixed barrel resolves to its OWN provider, not the default re-export's", async () => {
    const calls = await scanFiles(buildFixtureAccess(path.join(root, "mixed-barrel")));
    const consumerCalls = calls.filter((c) => c.file.endsWith("consumer.ts"));
    // `ask` is a named import → must resolve to anthropic (its real provider).
    assert.ok(
      consumerCalls.some((c) => c.provider === "anthropic"),
      `named import leaked to the default's provider: ${JSON.stringify(consumerCalls.map((c) => ({ line: c.line, provider: c.provider })))}`
    );
    // `gen` is a default import → must still resolve to openai.
    assert.ok(
      consumerCalls.some((c) => c.provider === "openai"),
      `default import failed to resolve: ${JSON.stringify(consumerCalls.map((c) => ({ line: c.line, provider: c.provider })))}`
    );
  });
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
npx tsc -p tsconfig.scanner-tests.json && node dist-test/test/a3-default-import-threading.test.js
```
Expected: `FAIL` — `consumerCalls.some(c => c.provider === "anthropic")` is false because the named import `ask` follows the `export { default }` re-export and is misattributed to openai.

- [ ] **Step 4: Add `isDefault` to `ImportedName` and populate it**

In `src/ast/cross-file-resolver.ts`, change the interface (~178):
```ts
interface ImportedName {
  localName: string;
  specifier: string; // import source string
  isDefault: boolean;
}
```
In `extractRelativeImports`, the named-import branch (~206 and ~209) pushes `isDefault: false`:
```ts
        if (asMatch) {
          results.push({ localName: asMatch[2], specifier, isDefault: false });
        } else {
          const name = trimmed.match(/\w+/)?.[0];
          if (name) results.push({ localName: name, specifier, isDefault: false });
        }
```
The default-import branch (~217) pushes `isDefault: true`:
```ts
    if (defaultMatch) {
      results.push({ localName: defaultMatch[1], specifier, isDefault: true });
    }
```

- [ ] **Step 5: Thread `isDefault` into `resolveExportedMatches` and rewrite the filter**

Change the signature (~359), adding `isDefault` before `visited`:
```ts
function resolveExportedMatches(
  name: string,
  fromFile: string,
  registry: ExportRegistry,
  sourceByFile: Map<string, string>,
  knownFiles: Set<string>,
  depth: number,
  isDefault: boolean,
  visited: Set<string> = new Set()
): AstCallMatch[] | null {
```
Replace the re-export loop body (the `for (const re of reExports)` block, ~385–405) with the explicit split:
```ts
  for (const re of reExports) {
    let follow = false;
    let nextName = name;
    let nextIsDefault = false;
    if (isDefault) {
      // A default binding flows ONLY through `export { default } from "./x"`.
      if (re.exportedName === "default") { follow = true; nextName = "default"; nextIsDefault = true; }
    } else {
      // A named binding flows through wildcards and name-matching named
      // re-exports, NEVER through `export { default }`.
      if (re.exportedName === null) { follow = true; nextName = name; }
      else if (re.exportedName === name) { follow = true; nextName = re.originalName ?? name; }
    }
    if (!follow) continue;
    const resolved = resolveImportPath(fromFile, re.specifier, knownFiles);
    if (!resolved) continue;
    const found = resolveExportedMatches(nextName, resolved, registry, sourceByFile, knownFiles, depth + 1, nextIsDefault, visited);
    if (found) return found;
  }
```

- [ ] **Step 6: Pass `isDefault` at both call sites**

Regular import propagation (~540 loop + ~561 call): destructure `isDefault` and pass it:
```ts
      for (const { localName, specifier, isDefault } of imports) {
```
```ts
        const calleeMatches = resolveExportedMatches(
          localName,
          resolvedFile,
          registry,
          sourceByFile,
          normalizedKnown,
          0,
          isDefault
        );
```
Middleware propagation (~608) — middleware refs are always named imports, pass `false`:
```ts
        const calleeMatches = resolveExportedMatches(
          mwName,
          resolvedFile,
          registry,
          sourceByFile,
          normalizedKnown,
          0,
          false
        );
```

- [ ] **Step 7: Run the new test to verify it passes**

```bash
npx tsc -p tsconfig.scanner-tests.json && node dist-test/test/a3-default-import-threading.test.js
```
Expected: `PASS A3-followup: named import in a mixed barrel...`.

- [ ] **Step 8: Run the PR #110 barrel regression to verify no regression**

```bash
node dist-test/test/a3-barrel-reexports.test.js
```
Expected: all 7 `PASS` lines (direct, aliased, wildcard, nested, default, missing, wildcard-then-named). If the `default` shape now fails, the direct-lookup-for-default path needs `name → "default"` mapping when `isDefault` is true — add that in the `fileExports.get` block and re-run.

- [ ] **Step 9: Commit**

```bash
git add src/ast/cross-file-resolver.ts src/test/a3-default-import-threading.test.ts src/test/fixtures/a3-followup/
git commit -m "fix(wave3): disambiguate default vs named imports in resolveExportedMatches (#114)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task A2: #115 — factory-with-arguments

**Files:**
- Create: `src/test/fixtures/factory-args/factory.ts`
- Create: `src/test/fixtures/factory-args/consumer.ts`
- Create: `src/test/factory-with-args.test.ts`
- Modify: `src/ast/cross-file-resolver.ts` (`extractFactoryCallAssignments` ~670)

- [ ] **Step 1: Create the factory fixture**

`factory.ts`:
```ts
import OpenAI from "openai";

export function makeClient(_config?: unknown): OpenAI {
  return new OpenAI();
}
```

`consumer.ts` (zero-arg, single-arg, object-arg, multi-arg, and multi-line variants):
```ts
import { makeClient } from "./factory";

const c0 = makeClient();
const c1 = makeClient(config);
const c2 = makeClient({ apiKey: process.env.KEY });
const c3 = makeClient(env, options);
const c4 = makeClient(
  env,
  options,
);

export async function run() {
  await c0.chat.completions.create({ model: "gpt-4o", messages: [] });
  await c1.chat.completions.create({ model: "gpt-4o", messages: [] });
  await c2.chat.completions.create({ model: "gpt-4o", messages: [] });
  await c3.chat.completions.create({ model: "gpt-4o", messages: [] });
  await c4.chat.completions.create({ model: "gpt-4o", messages: [] });
}
```
> Note: `config`, `env`, `options` are undeclared identifiers — fine, the fixture is scanned as text, never compiled (`src/test/fixtures` is excluded by `tsconfig.scanner-tests.json`).

- [ ] **Step 2: Write the failing test**

Create `src/test/factory-with-args.test.ts` (same harness preamble as Task A1 — `setWasmDir`, `run`, `buildFixtureAccess`):
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
    .filter((e) => typeof e === "string" && (e.endsWith(".ts") || e.endsWith(".js")))
    .map((relName) => ({ absolutePath: path.join(fixtureDir, relName), relativePath: relName.replace(/\\/g, "/") }));
  return { files, readFile: async (p: string) => fs.readFileSync(p, "utf-8") };
}

(async () => {
  const root = path.resolve(__dirname, "..", "..", "src", "test", "fixtures", "factory-args");
  await run("A5-followup: factory calls with arguments resolve the assigned client to openai", async () => {
    const calls = await scanFiles(buildFixtureAccess(path.join(root)));
    const consumerCalls = calls.filter((c) => c.file.endsWith("consumer.ts") && c.provider === "openai");
    // 5 client variables (c0..c4), each makes one chat call → expect 5 openai-attributed calls.
    assert.ok(
      consumerCalls.length >= 5,
      `expected >=5 openai calls (one per factory variant), got ${consumerCalls.length}: ${JSON.stringify(consumerCalls.map((c) => ({ line: c.line, provider: c.provider })))}`
    );
  });
})().catch((err) => { console.error(err); process.exit(1); });
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
npx tsc -p tsconfig.scanner-tests.json && node dist-test/test/factory-with-args.test.js
```
Expected: `FAIL` — only `c0` (zero-arg) resolves, so fewer than 5 openai calls are attributed.

- [ ] **Step 4: Widen the factory-call regex**

In `extractFactoryCallAssignments` (~674), widen the trailing parens group:
```ts
  const RE = /(?:const|let|var)\s+(\w+)\s*=\s*(\w+)\s*(?:<[^>]*>)?\s*\(\s*[^)]*\)/gm;
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
npx tsc -p tsconfig.scanner-tests.json && node dist-test/test/factory-with-args.test.js
```
Expected: `PASS A5-followup: factory calls with arguments...`.

- [ ] **Step 6: Run the PR #110 factory regression**

```bash
node dist-test/test/a5-factory-di-aliased.test.js
```
Expected: all `PASS` lines (zero-arg factory still resolves).

- [ ] **Step 7: Commit**

```bash
git add src/ast/cross-file-resolver.ts src/test/factory-with-args.test.ts src/test/fixtures/factory-args/
git commit -m "fix(wave3): resolve factory calls with arguments in extractFactoryCallAssignments (#115)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## TRACK B — Fingerprint flag + detectors (#116)

### Task B1: Add `inlineParallelCapable` flag and propagate it

**Files:**
- Modify: `src/scanner/fingerprints/types.ts` (~40)
- Modify: `src/analysis/types.ts` (~19, ~58)
- Modify: `src/ast/ast-scanner.ts` (`AstCallMatch` ~58; propagation ~660, ~802, ~826)

- [ ] **Step 1: Add the field to `MethodFingerprint`**

`src/scanner/fingerprints/types.ts`, after the `batchCapable?` line (~40):
```ts
  batchCapable?: boolean;
  /** True for endpoints with an inline n/count parameter (e.g. images.generate) — NOT a real batch API. */
  inlineParallelCapable?: boolean;
```

- [ ] **Step 2: Add the field to the two `analysis/types.ts` shapes**

In `src/analysis/types.ts`, after each `batchCapable?: boolean;` (lines 19 and 58):
```ts
  batchCapable?: boolean;
  inlineParallelCapable?: boolean;
```

- [ ] **Step 3: Add the field to `AstCallMatch`**

In `src/ast/ast-scanner.ts`, after the `batchCapable?` line in the `AstCallMatch` interface (~58):
```ts
  batchCapable?: boolean;
  inlineParallelCapable?: boolean;
```

- [ ] **Step 4: Propagate from fingerprint at the three copy sites**

In `src/ast/ast-scanner.ts`, at each of the three places that spread `batchCapable: fp.batchCapable` (~660, ~802, ~826), add the new field directly after it:
```ts
batchCapable: fp.batchCapable, inlineParallelCapable: fp.inlineParallelCapable, cacheCapable: fp.cacheCapable
```
(Match the existing line's exact punctuation/spacing at each site.)

- [ ] **Step 5: Verify the build compiles**

```bash
npm run build:ext
```
Expected: clean build, no TypeScript errors (the field is additive/optional).

- [ ] **Step 6: Commit**

```bash
git add src/scanner/fingerprints/types.ts src/analysis/types.ts src/ast/ast-scanner.ts
git commit -m "feat(wave3): add inlineParallelCapable fingerprint flag plumbing (#116)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task B2: Reclassify `images.generate` and add `detectInlineParallel`

**Files:**
- Create: `src/test/ast-inline-parallel.test.ts`
- Modify: `src/scanner/fingerprints/openai.json` (~52–58)
- Modify: `src/ast/waste/concurrency-detector.ts` (~152)
- Modify: `src/ast/waste/batch-detector.ts` (`detectNPlusOne` ~162; new `detectInlineParallel`; `detectBatchWaste` ~288)

- [ ] **Step 1: Write the failing detector test**

Create `src/test/ast-inline-parallel.test.ts`:
```ts
import assert from "node:assert/strict";
import { detectBatchWaste } from "../ast/waste/batch-detector";
import type { AstCallMatch } from "../ast/ast-scanner";
import { pointSpan } from "../scanner/source-span";

function makeMatch(overrides: Partial<AstCallMatch>): AstCallMatch {
  const line = overrides.line ?? 10;
  const column = overrides.column ?? 0;
  return {
    kind: "sdk", provider: "openai", packageName: "openai",
    methodChain: "openai.images.generate", confidence: 1, method: "POST",
    endpoint: "/v1/images/generations", line, column, span: pointSpan(line, column),
    frequency: "single", loopContext: false, enclosingFunction: null,
    streaming: false, batchCapable: false, inlineParallelCapable: false,
    cacheCapable: false, isMiddleware: false, ...overrides,
  };
}

function run(name: string, fn: () => void): void {
  try { fn(); console.log(`PASS ${name}`); }
  catch (err) { console.error(`FAIL ${name}`); throw err; }
}

run("inline-parallel: inlineParallelCapable fan-out → n/count suggestion, NOT batch-endpoint text", () => {
  const match = makeMatch({ inlineParallelCapable: true, frequency: "parallel", loopContext: true, line: 4 });
  const source = [
    "import OpenAI from 'openai';",
    "const openai = new OpenAI();",
    "const prompts = ['a', 'b', 'c'];",
    "const imgs = await Promise.all(prompts.map((p) => openai.images.generate({ prompt: p })));",
  ].join("\n");
  const findings = detectBatchWaste([match], source, "/project/src/img.ts");
  assert.ok(
    findings.some((f) => /n\/count parameter|count parameter|single call/i.test(f.description)),
    `expected an inline-parallel (n/count) suggestion, got: ${JSON.stringify(findings.map((f) => f.description))}`
  );
  assert.ok(
    !findings.some((f) => /batch request|batch endpoint|consolidate into a single batch/i.test(f.description)),
    `must not emit batch-endpoint text: ${JSON.stringify(findings.map((f) => f.description))}`
  );
});

run("inline-parallel: a real batchCapable API in the same shape still emits batch text", () => {
  const match = makeMatch({ methodChain: "client.embeddings.create", batchCapable: true, frequency: "parallel", loopContext: true, line: 4 });
  const source = [
    "import OpenAI from 'openai';",
    "const client = new OpenAI();",
    "const r = await Promise.all(texts.map((t) => client.embeddings.create({ model: 'text-embedding-3-small', input: t })));",
  ].join("\n");
  const findings = detectBatchWaste([match], source, "/project/src/embed.ts");
  assert.ok(findings.some((f) => f.type === "batch" && /batch/i.test(f.description)), "real batch API should still get batch text");
});

run("inline-parallel: Array.from({length:n}) idiom stays fully suppressed", () => {
  const match = makeMatch({ inlineParallelCapable: true, frequency: "parallel", loopContext: true, line: 4 });
  const source = [
    "import OpenAI from 'openai';",
    "const openai = new OpenAI();",
    "const imgs = await Promise.all(Array.from({ length: 4 }).map(() => openai.images.generate({ prompt: 'x' })));",
  ].join("\n");
  const findings = detectBatchWaste([match], source, "/project/src/img.ts");
  assert.equal(findings.length, 0, `expected no findings for the Array.from idiom, got: ${JSON.stringify(findings.map((f) => f.description))}`);
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx tsc -p tsconfig.scanner-tests.json && node dist-test/test/ast-inline-parallel.test.js
```
Expected: `FAIL` on the first case — no detector reads `inlineParallelCapable`, so no n/count suggestion is produced.

- [ ] **Step 3: Reclassify `images.generate` in the fingerprint**

In `src/scanner/fingerprints/openai.json`, the `images.generate` entry (~52–58): replace `"batchCapable": true,` with `"inlineParallelCapable": true,`:
```json
    {
      "pattern": "images.generate",
      "httpMethod": "POST",
      "endpoint": "https://api.openai.com/v1/images/generations",
      "costModel": "per_request",
      "fixedFee": 0.04,
      "inlineParallelCapable": true,
      "description": "Image generation (DALL-E 3 1024×1024 standard)"
    },
```

- [ ] **Step 4: Suppress the fan-out finding on either flag**

In `src/ast/waste/concurrency-detector.ts` (~152):
```ts
  if (match.batchCapable === true || match.inlineParallelCapable === true) return null; // batch / inline-parallel detectors handle it
```

- [ ] **Step 5: Guard `detectNPlusOne` against inline-parallel**

In `src/ast/waste/batch-detector.ts` (~162):
```ts
  if (match.batchCapable || match.inlineParallelCapable) return null; // batch / inline-parallel detectors handle these
```

- [ ] **Step 6: Add `detectInlineParallel` and register it**

In `src/ast/waste/batch-detector.ts`, add this function next to `detectBatch` (mirrors its structure; all helpers are module-scoped):
```ts
// ── Inline-parallel finding (endpoint has an n/count parameter) ───────────────

function detectInlineParallel(
  match: AstCallMatch,
  source: string,
  filePath: string,
  isTestLike: boolean
): LocalWasteFinding | null {
  if (!isRealProviderMatch(match)) return null;
  if (!BATCH_LOOP_FREQS.has(match.frequency)) return null;
  if (!match.inlineParallelCapable) return null;
  if (hasGuardInWindow(source, match.line, BATCH_GUARD)) return null;
  // Array.from({ length: N }) is intentional bounded replication — not naive fan-out.
  if (match.frequency === "parallel" && hasGuardInWindow(source, match.line, BOUNDED_REPLICATION)) return null;

  const evidence: string[] = [
    `Call executes in a "${match.frequency}" context — each iteration issues a separate request.`,
    "This endpoint accepts an n/count parameter that returns multiple results from a single request.",
  ];
  const small = isSmallBounded(source, match.line);
  if (small) evidence.push("Loop appears bounded to a small collection (≤5 items).");

  let score = 1;
  if (match.frequency === "unbounded-loop") score += 3;
  else if (match.frequency === "bounded-loop") score += 2;
  else if (match.frequency === "parallel") score += 2;
  else if (match.frequency === "polling") score += 4;
  if (small) score -= 1;
  if (isTestLike) score -= 1;

  let confidence = 0.52 + Math.min(score, 5) * 0.07;
  if (small) confidence -= 0.10;
  if (isTestLike) confidence -= 0.10;
  confidence = clamp(confidence);
  if (confidence < 0.35) return null;

  return {
    id: `local-inline_parallel-${filePath}:${match.line}`,
    type: "batch" as SuggestionType,
    severity: scoreToSeverity(score),
    confidence,
    description:
      "This endpoint accepts an n/count parameter — request multiple results in a single call instead of issuing one request per item.",
    affectedFile: filePath,
    line: match.line,
    evidence,
  };
}
```
Register it inside `detectBatchWaste`'s per-match loop, right after the `detectNPlusOne` push (~292):
```ts
    const inlineFinding = detectInlineParallel(match, source, filePath, isTestLike);
    if (inlineFinding) findings.push(inlineFinding);
```

- [ ] **Step 7: Run the test to verify it passes**

```bash
npx tsc -p tsconfig.scanner-tests.json && node dist-test/test/ast-inline-parallel.test.js
```
Expected: 3× `PASS`.

- [ ] **Step 8: Run existing detector + fingerprint regressions**

```bash
node dist-test/test/ast-batch-detector.test.js && node dist-test/test/ast-concurrency-detector.test.js && node dist-test/test/fingerprint-registry.test.js
```
Expected: all `PASS`. (If any test asserted `images.generate` is `batchCapable`, update that expectation to `inlineParallelCapable`.)

- [ ] **Step 9: Commit**

```bash
git add src/scanner/fingerprints/openai.json src/ast/waste/concurrency-detector.ts src/ast/waste/batch-detector.ts src/test/ast-inline-parallel.test.ts
git commit -m "feat(wave3): inline-parallel detector + images.generate reclassification (#116)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## PHASE C — Integration & Verification (after Tracks A and B merge)

### Task C1: Wire new tests into the CI chain and run the full suite

**Files:**
- Modify: `package.json` (`test:scanner` script)

- [ ] **Step 1: Append the three new compiled test files to `test:scanner`**

In `package.json`, append to the end of the `test:scanner` command chain (before the closing quote):
```
 && node dist-test/test/a3-default-import-threading.test.js && node dist-test/test/factory-with-args.test.js && node dist-test/test/ast-inline-parallel.test.js
```

- [ ] **Step 2: Run the full scanner suite**

```bash
npm run test:scanner
```
Expected: every test prints `PASS`; the process exits 0. Pay attention to `parity.test.js` (AST↔regex parity #76) — it must still pass.

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "test(wave3): register #114/#115/#116 tests in test:scanner chain

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task C2: Benchmark gate (no regression)

- [ ] **Step 1: Run the benchmark against the pinned fixtures**

```bash
git clone --depth 1 https://github.com/recost-dev/extension-benchmark.git /tmp/wave3-fixtures
cd /tmp/wave3-fixtures && git fetch --depth 1 origin "$(tr -d '\n\r' < /home/andresl/Projects/recost/extension/.benchmark-fixtures-sha)" && git checkout FETCH_HEAD
cd /home/andresl/Projects/recost/extension
npm run build:ext
npm run benchmark -- --fixtures /tmp/wave3-fixtures --report benchmark/report.json
```
Expected: exit 0. The runner fails (exit 1) only if a metric drops more than 1pp below `benchmark/baseline.json`. `detectionRecall` must stay ≥ 51.47%; precision within tolerance. No positive delta is expected (the corpus does not yet exercise barrel/factory patterns — that is Wave 2 / #113).

- [ ] **Step 2: If the gate fails**, inspect which metric dropped (the runner prints `metric: baseline% → current% (Δ pp)`). A precision drop on `images.generate`-adjacent finding types is the likely culprit — re-check the `detectInlineParallel` guards. Do **not** run `--update-baseline` to mask a real regression.

### Task C3: Finish the branch

- [ ] **Step 1: Confirm the issues' acceptance criteria are all met** (re-read #114/#115/#116 checkboxes against the diff).
- [ ] **Step 2: Invoke `superpowers:finishing-a-development-branch`** to open the PR (title referencing "Wave 3", body `Closes #114, #115, #116`) and present merge options. Do not push or merge without explicit user approval.

---

## Self-Review Notes (for the planner)

- **Spec coverage:** #114 → A1; #115 → A2; #116 flag plumbing → B1, detector behavior + fingerprint → B2; benchmark gate → C2; test-registration gotcha → C1. All spec sections mapped.
- **Type consistency:** `inlineParallelCapable?: boolean` is the single field name used in `MethodFingerprint`, both `analysis/types.ts` shapes, and `AstCallMatch`. `detectInlineParallel` and `detectBatchWaste` match `batch-detector.ts` signatures. `resolveExportedMatches`'s new `isDefault` param is threaded at the declaration, the recursive call, and both external call sites.
- **Direct-default-lookup caveat:** A1 Step 8 explicitly tests the PR #110 `default` shape and gives the remediation if it regresses — this is the one place the spec flagged as needing fixture confirmation.
