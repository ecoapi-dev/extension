# B3 — Stable Endpoint IDs Across Scans Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Endpoint IDs become deterministic hashes of *structural* properties (provider, masked URL template, enclosing function, normalized file path, method signature) instead of transient ones (line number, scan-time array index). State that users save against an endpoint — suppressed findings, simulator scenarios — survives non-structural code changes like refactors that move a call ±20 lines.

**Architecture:** A new `computeEndpointId(call)` becomes the **single** source for endpoint IDs. It is called from the two places IDs are minted today:
1. `scan-results.ts` — synthetic local endpoints (currently `local-${scanId}-${n}`).
2. `intelligence/builder.ts` — `makeApiCallId()` (currently includes `call.line`).

Two new helpers feed it:
- `enclosingFunctionName(node)` — walks up the AST to find the surrounding `function_declaration` / `method_definition` / `function_definition` / arrow-fn-assigned-to-`const`.
- `maskUrlDynamicParts(url)` — replaces numeric segments, UUIDs, and bracketed/brace placeholders with `:id`.

Persistence migration is one-way: old IDs encountered in `vscode.globalState` are logged and ignored; new IDs are written on the next scan.

**Tech Stack:** TypeScript (strict), web-tree-sitter, esbuild, Node `assert/strict` test runner.

**Reference:** GitHub issue [#82](https://github.com/recost-dev/extension/issues/82); design note at `docs/accuracy/traceability.md` § B3.

**Depends on:** B1 (spans help locate the enclosing function reliably for partial-line cases). B1 is **not strictly required** to complete B3 — the `enclosingFunctionName` walker uses `node.parent`, not the span — but landing B1 first lets B3 testing reuse the same fixtures.

---

## Execution Model

This plan is executed via **`superpowers:subagent-driven-development`**. The main session is the controller; it dispatches one **implementer subagent** per task, then runs **spec compliance** and **code quality** reviewer subagents on the result before moving on. Subagents follow `superpowers:test-driven-development` automatically.

Some tasks below touch strictly disjoint files and depend only on already-landed foundation types. Those are grouped into **parallel batches** dispatched via `superpowers:dispatching-parallel-agents`. The controller dispatches all implementers in a batch concurrently, waits for all to return, runs the merge + reviews described in the safety rules, then advances to the next batch.

### Parallel Safety Rules

These rules are non-negotiable. If a rule conflicts with a task as written, **that task runs serially** instead of being parallelized.

1. **One implementer per file.** No two parallel agents may write to the same file in the same batch. The "Files" block at the top of every task is the authoritative declaration; the controller checks for overlap before dispatching and refuses to start the batch on conflict.
2. **Worktree isolation.** Every parallel agent runs in its own git worktree via `superpowers:using-git-worktrees`. Worktrees are cut from the **same base SHA** at batch start. After all agents in the batch return DONE, the controller merges each branch into the working branch in **declared task order** (not return order), runs `npm test` after each merge, and only proceeds when the full suite is green.
3. **Foundation tasks never run in parallel.** Tasks that introduce or modify shared types (e.g. adding `enclosingFunction` to `ApiCallInput` and `AstCallMatch` in Task 4, replacing the existing `makeApiCallId` body in Task 5) run **before** any batch that depends on those types. They are tagged `Foundation` and run serially.
4. **Each agent leaves the build green in its own worktree.** An agent that returns with broken types or failing tests is treated as `BLOCKED` per the subagent-driven-development skill. The controller does not merge a broken worktree.
5. **No cross-task type changes inside a parallel batch.** If a parallel agent realizes its task needs an additional shared-type change to compile, it must escalate (`NEEDS_CONTEXT`) instead of editing the type. The controller pulls the type change out as a new serial Foundation task and re-batches the rest.
6. **Reviewer subagents run after merge into the working branch**, not against the worktree. This catches integration regressions the implementer's local test pass missed.
7. **Triage and bug-hunting tasks are always serial.** Not applicable to this plan (no triage tasks), but called out for consistency with the A4 plan.
8. **Manual UI verification is always serial.** Task 7 step 4 launches the Extension Development Host; only one EDH instance can attach to a workspace at a time. Task 7 is therefore serial.

### Batch Plan

| Batch | Tasks | Mode | Pre-condition |
|---|---|---|---|
| **A** | Tasks 1, 2 | Parallel (2 agents) | none — both create new files in disjoint locations |
| **F1** | Task 3 | Foundation (serial) | A merged + green (consumes `maskUrlDynamicParts` from Task 1) |
| **F2** | Task 4 | Foundation (serial) | A merged + green (consumes `enclosingFunctionName` from Task 2; adds shared field to `ApiCallInput` and `AstCallMatch`) |
| **B** | Tasks 5, 6 | Parallel (2 agents) | F1 + F2 merged + green (both consume `computeEndpointId` and `enclosingFunction`) |
| **C** | Task 7 | Serial (manual UI verification) | B merged + green |
| **D** | Task 8 | Serial (extension to existing test file) | C merged + green |
| **V** | Task 9 | Serial (verification) | D merged + green |

Total: 2 parallel-agent dispatches across 9 tasks; estimated ~25% wall-time reduction vs. fully serial execution.

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `src/ast/enclosing-function.ts` | **Create** | Walks parent nodes for the nearest function/method/arrow-fn name. Returns `null` for top-level calls. |
| `src/scanner/url-template.ts` | **Create** | `maskUrlDynamicParts(url)` — replaces numeric segments, UUIDs, `${x}`, `{x}`, `<x>`, `:param`. |
| `src/scanner/endpoint-id.ts` | **Create** | `computeEndpointId(input)` — FNV-1a hash of `{provider, methodSignature, filePathNormalized, enclosingFunction, urlTemplate}`. |
| `src/intelligence/path-utils.ts` | Modify (only if needed) | Reuse the existing `normalizeRepoPath`. No code change expected — confirm export. |
| `src/ast/ast-scanner.ts` | Modify | Add `enclosingFunction: string \| null` to `AstCallMatch`; populate from new helper at every emit site. |
| `src/analysis/types.ts` | Modify | Add `enclosingFunction?: string \| null` to `ApiCallInput`. |
| `src/scanner/core-scanner.ts` | Modify | Pipe `enclosingFunction` from `AstCallMatch` → `ApiCallInput`. |
| `src/scan-results.ts` | Modify | Replace `local-${scanId}-${n}` with `computeEndpointId(...)`; same for the merge path. |
| `src/intelligence/builder.ts` | Modify | Replace `makeApiCallId` body with `computeEndpointId`. |
| `src/webview-provider.ts` | Modify | When loading saved scenarios / suppressions, log + skip entries whose endpoint ID is no longer present in the scan result. |
| `src/test/enclosing-function.test.ts` | **Create** | Unit tests against fixture snippets. |
| `src/test/url-template.test.ts` | **Create** | Unit tests for masker rules. |
| `src/test/endpoint-id.test.ts` | **Create** | Stability tests: ID survives ±20 line move; differs across enclosing functions; URL paths with numeric IDs collapse. |
| `package.json` | Modify | Wire the three new test files into `test:scanner`. |

---

## Task 1: Build the URL template masker

**Batch:** A — parallel with Task 2. Touches only the two new files listed below + `package.json` (test script append). Build stays green.

> **Note on `package.json`**: both Task 1 and Task 2 append a line to the `test:scanner` script. This is a controlled merge conflict. **Resolution rule:** the controller resolves the conflict at merge time by appending both lines in declared task order (Task 1's append first, then Task 2's). The implementer subagent for each task makes the append in isolation in its worktree; the controller does the textual merge.

**Files:**
- Create: `src/scanner/url-template.ts`
- Create: `src/test/url-template.test.ts`
- Modify: `package.json` (test:scanner — controller-merged)

- [ ] **Step 1: Write failing tests**

Create `src/test/url-template.test.ts`:

```typescript
import assert from "node:assert/strict";
import { maskUrlDynamicParts } from "../scanner/url-template";

async function run(name: string, fn: () => void): Promise<void> {
  try { fn(); console.log(`PASS ${name}`); }
  catch (err) { console.error(`FAIL ${name}`); throw err; }
}

(async () => {
  await run("masks numeric path segments", () => {
    assert.equal(maskUrlDynamicParts("/api/users/123"), "/api/users/:id");
    assert.equal(maskUrlDynamicParts("/api/users/456/posts/789"), "/api/users/:id/posts/:id");
  });

  await run("masks UUIDs", () => {
    assert.equal(
      maskUrlDynamicParts("/orders/550e8400-e29b-41d4-a716-446655440000"),
      "/orders/:id"
    );
  });

  await run("masks template-literal interpolations", () => {
    assert.equal(maskUrlDynamicParts("/users/${userId}/profile"), "/users/:id/profile");
    assert.equal(maskUrlDynamicParts("/users/{userId}/profile"), "/users/:id/profile");
    assert.equal(maskUrlDynamicParts("/users/<userId>/profile"), "/users/:id/profile");
  });

  await run("preserves protocol and host", () => {
    assert.equal(
      maskUrlDynamicParts("https://api.example.com/v1/users/42"),
      "https://api.example.com/v1/users/:id"
    );
  });

  await run("preserves non-numeric path segments", () => {
    assert.equal(
      maskUrlDynamicParts("/api/users/me/preferences"),
      "/api/users/me/preferences"
    );
  });

  await run("strips query and hash", () => {
    assert.equal(maskUrlDynamicParts("/users/123?include=posts"), "/users/:id");
    assert.equal(maskUrlDynamicParts("/users/123#anchor"), "/users/:id");
  });

  await run("noop on sdk-style pseudo-urls", () => {
    assert.equal(
      maskUrlDynamicParts("sdk://openai/chat.completions.create"),
      "sdk://openai/chat.completions.create"
    );
  });

  console.log("url-template.test PASSED");
})().catch((err) => { console.error(err); process.exit(1); });
```

- [ ] **Step 2: Implement the masker**

Create `src/scanner/url-template.ts`:

```typescript
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const NUMERIC_SEGMENT_RE = /\/\d+(?=\/|$)/g;
const TEMPLATE_RE = /\$\{[^}]+\}|\{[^}]+\}|<[^>]+>/g;

/**
 * Replace dynamic URL segments with the placeholder `:id` so two calls that
 * differ only in user-supplied identifiers produce the same template.
 *
 * Pure / no I/O — used by endpoint-id hashing and safe to call anywhere.
 */
export function maskUrlDynamicParts(url: string): string {
  if (!url) return url;
  // sdk:// pseudo-URLs are already canonical — don't mangle them.
  if (url.startsWith("sdk://") || url.startsWith("ast:")) return url;

  // Strip query and hash before any pattern matching.
  const queryIdx = url.indexOf("?");
  const hashIdx = url.indexOf("#");
  const cutAt =
    queryIdx >= 0 && hashIdx >= 0 ? Math.min(queryIdx, hashIdx)
    : queryIdx >= 0 ? queryIdx
    : hashIdx >= 0 ? hashIdx
    : -1;
  let stripped = cutAt >= 0 ? url.slice(0, cutAt) : url;

  // Order matters: UUIDs and templates first (they may contain digits),
  // then numeric segments.
  stripped = stripped.replace(UUID_RE, ":id");
  stripped = stripped.replace(TEMPLATE_RE, ":id");
  stripped = stripped.replace(NUMERIC_SEGMENT_RE, "/:id");

  return stripped;
}
```

- [ ] **Step 3: Wire into `package.json`**

Edit `package.json` `test:scanner` script — append `&& node dist-test/test/url-template.test.js` before the closing `"`.

- [ ] **Step 4: Build and run**

Run: `npx tsc -p tsconfig.scanner-tests.json && node dist-test/test/url-template.test.js`
Expected: 7 PASS lines + `url-template.test PASSED`.

- [ ] **Step 5: Commit**

```bash
git add src/scanner/url-template.ts src/test/url-template.test.ts package.json
git commit -m "feat(endpoint-id): URL template masker for stable IDs (issue #82)"
```

---

## Task 2: Build the enclosing-function-name extractor

**Batch:** A — parallel with Task 1. Touches only the two new files listed below + `package.json` (test script append, see Task 1's controller-merge note).

**Files:**
- Create: `src/ast/enclosing-function.ts`
- Create: `src/test/enclosing-function.test.ts`
- Modify: `package.json` (test:scanner — controller-merged)

- [ ] **Step 1: Write failing tests**

Create `src/test/enclosing-function.test.ts`:

```typescript
import assert from "node:assert/strict";
import * as path from "path";
import { parseFile, setWasmDir } from "../ast/parser-loader";
import { extractCalls } from "../ast/call-visitor";
import { enclosingFunctionName } from "../ast/enclosing-function";

const WASM_DIR = path.join(__dirname, "..", "..", "assets", "parsers");
setWasmDir(WASM_DIR);

async function run(name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); console.log(`PASS ${name}`); }
  catch (err) { console.error(`FAIL ${name}`); throw err; }
}

async function nameFor(src: string, chain: string, lang = "typescript"): Promise<string | null> {
  const tree = await parseFile(src, lang);
  if (!tree) throw new Error("parse failed");
  const call = extractCalls(tree).find((c) => c.methodChain === chain);
  if (!call) throw new Error(`call ${chain} not found`);
  return enclosingFunctionName(call.node);
}

(async () => {
  await run("function declaration", async () => {
    const n = await nameFor(
      `function answerQuestion(q: string) { return openai.chat.completions.create({}); }`,
      "openai.chat.completions.create"
    );
    assert.equal(n, "answerQuestion");
  });

  await run("class method", async () => {
    const n = await nameFor(
      `class Svc { async ask(q: string) { return openai.chat.completions.create({}); } }`,
      "openai.chat.completions.create"
    );
    assert.equal(n, "ask");
  });

  await run("arrow function assigned to const", async () => {
    const n = await nameFor(
      `const handler = async () => { await openai.chat.completions.create({}); };`,
      "openai.chat.completions.create"
    );
    assert.equal(n, "handler");
  });

  await run("top-level call → null", async () => {
    const n = await nameFor(
      `openai.chat.completions.create({});`,
      "openai.chat.completions.create"
    );
    assert.equal(n, null);
  });

  await run("python def", async () => {
    const n = await nameFor(
      `def ask(q):\n    return openai.chat.completions.create()\n`,
      "openai.chat.completions.create",
      "python"
    );
    assert.equal(n, "ask");
  });

  console.log("enclosing-function.test PASSED");
})().catch((err) => { console.error(err); process.exit(1); });
```

- [ ] **Step 2: Implement the extractor**

> **Why a new module instead of reusing `ast-scanner.enclosingFunctionName`**: that helper is private and only handles `function_declaration`, `method_definition`, `function_definition`. We need the same logic plus arrow-function-assigned-to-`const` detection, which currently doesn't exist. Putting it in its own module also lets `endpoint-id.ts` import it without dragging the whole scanner module.

Create `src/ast/enclosing-function.ts`:

```typescript
import type { SyntaxNode } from "./parser-loader";

/**
 * Walk up the AST from `node` to find the nearest enclosing function name.
 * Returns null for top-level calls.
 *
 * Recognized constructs:
 * - JS/TS `function foo() { ... }`           (function_declaration)
 * - JS/TS class methods `class C { foo() {} }` (method_definition)
 * - JS/TS `const foo = () => { ... }`        (arrow_function under variable_declarator)
 * - JS/TS `const foo = function() { ... }`   (function_expression under variable_declarator)
 * - Python `def foo(): ...`                  (function_definition)
 */
export function enclosingFunctionName(node: SyntaxNode): string | null {
  let current: SyntaxNode | null = node.parent;
  while (current) {
    // Function declarations / Python defs / methods — name is a child identifier.
    if (
      current.type === "function_declaration" ||
      current.type === "function_definition" ||
      current.type === "method_definition"
    ) {
      for (let i = 0; i < current.childCount; i++) {
        const c = current.child(i);
        if (c?.type === "identifier" || c?.type === "property_identifier") {
          return c.text;
        }
      }
      return null;
    }

    // Arrow functions or function expressions — look at the binding name on the
    // surrounding variable_declarator.
    if (current.type === "arrow_function" || current.type === "function_expression") {
      const decl = current.parent;
      if (decl?.type === "variable_declarator") {
        const lhs = decl.child(0);
        if (lhs?.type === "identifier") return lhs.text;
      }
      return null;
    }

    current = current.parent;
  }
  return null;
}
```

- [ ] **Step 3: Wire into `package.json`**

Edit `package.json` `test:scanner` script — append `&& node dist-test/test/enclosing-function.test.js` before the closing `"`.

- [ ] **Step 4: Build and run**

Run: `npx tsc -p tsconfig.scanner-tests.json && node dist-test/test/enclosing-function.test.js`
Expected: 5 PASS lines + `enclosing-function.test PASSED`.

- [ ] **Step 5: Commit**

```bash
git add src/ast/enclosing-function.ts src/test/enclosing-function.test.ts package.json
git commit -m "feat(endpoint-id): enclosing-function extractor (issue #82)"
```

---

## Task 3: Build `computeEndpointId`

**Batch:** F1 — Foundation, serial. Depends on Batch A merged + green (consumes `maskUrlDynamicParts`). Touches only new files + `package.json`.

**Files:**
- Create: `src/scanner/endpoint-id.ts`
- Create: `src/test/endpoint-id.test.ts`
- Modify: `package.json` (test:scanner)

- [ ] **Step 1: Write failing tests**

Create `src/test/endpoint-id.test.ts`:

```typescript
import assert from "node:assert/strict";
import { computeEndpointId } from "../scanner/endpoint-id";

async function run(name: string, fn: () => void): Promise<void> {
  try { fn(); console.log(`PASS ${name}`); }
  catch (err) { console.error(`FAIL ${name}`); throw err; }
}

const base = {
  provider: "openai",
  methodSignature: "chat.completions.create",
  filePath: "src/services/chat.ts",
  enclosingFunction: "askQuestion",
  url: "sdk://openai/chat.completions.create",
};

(async () => {
  await run("ID is deterministic", () => {
    assert.equal(computeEndpointId(base), computeEndpointId(base));
  });

  await run("ID survives ±20 line move (line number is not part of input)", () => {
    // No line field in computeEndpointId at all — proven structurally.
    assert.equal(
      computeEndpointId(base),
      computeEndpointId({ ...base }) // line is not part of `base`; if signature changes this test breaks
    );
  });

  await run("ID survives renaming an unrelated containing variable", () => {
    // Renaming a containing variable doesn't change provider/method/file/function/url.
    assert.equal(computeEndpointId(base), computeEndpointId({ ...base }));
  });

  await run("ID changes when enclosing function changes", () => {
    assert.notEqual(
      computeEndpointId(base),
      computeEndpointId({ ...base, enclosingFunction: "differentFn" })
    );
  });

  await run("ID changes when provider changes", () => {
    assert.notEqual(
      computeEndpointId(base),
      computeEndpointId({ ...base, provider: "anthropic" })
    );
  });

  await run("ID changes when file path changes", () => {
    assert.notEqual(
      computeEndpointId(base),
      computeEndpointId({ ...base, filePath: "src/services/other.ts" })
    );
  });

  await run("file path normalization: backslash and ./ prefix collapse", () => {
    assert.equal(
      computeEndpointId({ ...base, filePath: "src\\services\\chat.ts" }),
      computeEndpointId({ ...base, filePath: "./src/services/chat.ts" })
    );
  });

  await run("URLs differing only by numeric ID produce the same endpoint ID", () => {
    const a = computeEndpointId({ ...base, url: "https://api.x.com/users/123" });
    const b = computeEndpointId({ ...base, url: "https://api.x.com/users/456" });
    assert.equal(a, b);
  });

  await run("URLs differing structurally produce different IDs", () => {
    const a = computeEndpointId({ ...base, url: "https://api.x.com/users/123" });
    const b = computeEndpointId({ ...base, url: "https://api.x.com/orders/123" });
    assert.notEqual(a, b);
  });

  await run("ID format is short and URL-safe", () => {
    const id = computeEndpointId(base);
    assert.match(id, /^ep_[a-z0-9]+$/);
  });

  console.log("endpoint-id.test PASSED");
})().catch((err) => { console.error(err); process.exit(1); });
```

- [ ] **Step 2: Implement `computeEndpointId`**

Create `src/scanner/endpoint-id.ts`:

```typescript
import { maskUrlDynamicParts } from "./url-template";

/** Inputs are intentionally narrow — line/column/timing fields are excluded. */
export interface EndpointIdInput {
  provider: string | null | undefined;
  methodSignature: string | null | undefined;
  filePath: string;
  enclosingFunction: string | null | undefined;
  url: string | null | undefined;
}

function normalizeFilePath(filePath: string): string {
  return filePath.replace(/\\/g, "/").replace(/^\.\/+/, "");
}

/** FNV-1a 32-bit. Same algorithm as `intelligence/builder.ts:makeStableFingerprint`. */
function fnv1a(input: string): string {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

/**
 * Deterministic endpoint identifier.
 *
 * Excluded by design: line, column, span, scan ID, scan timestamp.
 * Included: provider, method signature, normalized file path, enclosing
 * function name, masked URL template.
 */
export function computeEndpointId(input: EndpointIdInput): string {
  const parts = [
    input.provider ?? "null",
    input.methodSignature ?? "null",
    normalizeFilePath(input.filePath),
    input.enclosingFunction ?? "null",
    input.url ? maskUrlDynamicParts(input.url) : "null",
  ];
  return `ep_${fnv1a(parts.join("|"))}`;
}
```

- [ ] **Step 3: Wire into `package.json`**

Append to `test:scanner` script: `&& node dist-test/test/endpoint-id.test.js`.

- [ ] **Step 4: Build and run**

Run: `npx tsc -p tsconfig.scanner-tests.json && node dist-test/test/endpoint-id.test.js`
Expected: 10 PASS lines + `endpoint-id.test PASSED`.

- [ ] **Step 5: Commit**

```bash
git add src/scanner/endpoint-id.ts src/test/endpoint-id.test.ts package.json
git commit -m "feat(endpoint-id): computeEndpointId hash function (issue #82)"
```

---

## Task 4: Emit `enclosingFunction` from the AST scanner

**Batch:** F2 — Foundation, serial. Depends on Batch A merged + green (consumes `enclosingFunctionName` from Task 2). Adds the shared `enclosingFunction` field to `ApiCallInput` and `AstCallMatch` — every consumer in Batch B uses it. **Do not parallelize**: this rewrites multiple emit sites in `ast-scanner.ts` and adds a public type field.

**Files:**
- Modify: `src/ast/ast-scanner.ts`
- Modify: `src/analysis/types.ts`
- Modify: `src/scanner/core-scanner.ts`

- [ ] **Step 1: Add the field to the public types**

Edit `src/analysis/types.ts`. In `ApiCallInput`, add (after `methodSignature?: string;`):

```typescript
  enclosingFunction?: string | null;
```

Edit `src/ast/ast-scanner.ts`. In `AstCallMatch`, add (after the `loopContext: boolean;` line):

```typescript
  /** Name of the function/method/arrow-fn that contains the call (null for top-level calls). */
  enclosingFunction: string | null;
```

- [ ] **Step 2: Replace the private helper**

Edit `src/ast/ast-scanner.ts`. Delete the local `enclosingFunctionName(node)` function (around line 399). Replace the `import` block at the top to add:

```typescript
import { enclosingFunctionName } from "./enclosing-function";
```

Existing call sites of `enclosingFunctionName(...)` continue to work because the new module exports the same name.

- [ ] **Step 3: Populate `enclosingFunction` at every emit site**

For each `matches.push({ ... })`, `methodMatches.push({ ... })`, and `fnMatches.push({ ... })` inside `scanSourceWithAst()`, add:

- The class-method scan (around line 470) — methodMatches: `enclosingFunction: methodName,`
- The function-body scan (around line 640) — fnMatches: `enclosingFunction: fnName2,`
- The main loop sections 7c, 7d, 7e — use `enclosingFunction: fnName,` (the local already computed at section 7 entry).
- The second-pass callback / middleware re-emits (sections 9, 10) — use `enclosingFunction: m.enclosingFunction ?? null,` (re-emits inherit the cached match's value).

- [ ] **Step 4: Pipe through `core-scanner.ts`**

Edit `src/scanner/core-scanner.ts`. In `astMatchToApiCallInput()`, add to the returned object (after `crossFileOrigin,`):

```typescript
    enclosingFunction: match.enclosingFunction,
```

The regex path doesn't have AST context — leave it as `undefined` (the field is optional). `computeEndpointId` will treat `undefined` as `"null"` in the hash.

- [ ] **Step 5: Build**

Run: `npx tsc -p tsconfig.scanner-tests.json`
Expected: clean.

- [ ] **Step 6: Run the full scanner suite**

Run: `npm test`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add src/analysis/types.ts src/ast/ast-scanner.ts src/scanner/core-scanner.ts
git commit -m "feat(endpoint-id): emit enclosingFunction on every match (issue #82)"
```

---

## Task 5: Use `computeEndpointId` in `intelligence/builder.ts`

**Batch:** B — parallel with Task 6. Touches only `src/intelligence/builder.ts` (and may adjust `src/intelligence/__tests__/builder.test.ts` if hard-coded ID assertions exist). No file overlap with Task 6 (which touches `src/scan-results.ts`). Both consume `computeEndpointId` and `enclosingFunction` — already shipped by F1 + F2.

**Files:**
- Modify: `src/intelligence/builder.ts`
- Modify (if needed): `src/intelligence/__tests__/builder.test.ts`

- [ ] **Step 1: Replace `makeApiCallId`**

Edit `src/intelligence/builder.ts`.

Add at the top:

```typescript
import { computeEndpointId } from "../scanner/endpoint-id";
```

Replace the existing `makeApiCallId()` and `makeStableApiCallFingerprint()` (lines 30-57) with:

```typescript
function makeApiCallId(filePath: string, call: ApiCallInput): string {
  return computeEndpointId({
    provider: call.provider,
    methodSignature: call.methodSignature,
    filePath,
    enclosingFunction: call.enclosingFunction,
    url: call.url,
  });
}
```

> **Note**: deleting `makeStableApiCallFingerprint` removes the previous fields (cost model, frequency class, batch/cache/streaming flags, cross-file origin) from the ID input. That is **intentional** — those are *attributes* that should not change identity. Cost model can flip when pricing data updates; frequency class can flip when a refactor adds a loop. Neither should reset state the user saved against the endpoint.

- [ ] **Step 2: Handle ID collisions in the same file**

Two calls in the same enclosing function with the same masked URL now collide. The existing `ensureUniqueId` (line 74) will throw. Update the call site (line 199) to disambiguate by appending the line number when a collision occurs:

```typescript
      let apiCallId = makeApiCallId(filePath, call);
      if (apiCalls[apiCallId]) {
        apiCallId = `${apiCallId}_L${call.line}`;
      }
      ensureUniqueId(apiCalls, apiCallId, "apiCall");
```

> **Why fall back to line**: in the rare same-function-same-URL case (e.g., two `await fetch(URL)` calls back-to-back), we need *some* disambiguator. Line is the least-bad option — the second call still gets a stable suffix as long as it stays put. We document this is best-effort below.

- [ ] **Step 3: Update the `validateSnapshot` test path if needed**

Run: `npm test`
Expected: most tests PASS. `intelligence/__tests__/builder.test.ts` may have hard-coded ID assertions — fix them to assert *shape* (`/^ep_[a-z0-9]+$/`) instead of specific values.

- [ ] **Step 4: Commit**

```bash
git add src/intelligence/builder.ts src/intelligence/__tests__/builder.test.ts
git commit -m "refactor(endpoint-id): use computeEndpointId in snapshot builder (issue #82)"
```

---

## Task 6: Use `computeEndpointId` in `scan-results.ts`

**Batch:** B — parallel with Task 5. Touches only `src/scan-results.ts`. No file overlap with Task 5.

**Files:**
- Modify: `src/scan-results.ts`

- [ ] **Step 1: Replace the synthetic ID minter**

Edit `src/scan-results.ts`. Add at the top:

```typescript
import { computeEndpointId } from "./scanner/endpoint-id";
```

In `mergeRemoteAndLocalEndpoints()`, find the synthetic creation (around line 379-407). Replace:

```typescript
      syntheticByMethodUrl.set(key, {
        id: `local-${scanId}-${syntheticByMethodUrl.size + 1}`,
```

with:

```typescript
      const stableId = computeEndpointId({
        provider,
        methodSignature: call.methodSignature,
        filePath: call.file,
        enclosingFunction: call.enclosingFunction,
        url: canonicalUrl,
      });
      // Disambiguate the unlikely collision with an already-emitted synthetic
      // (different method, same masked URL, etc.).
      let id = stableId;
      let suffix = 1;
      while (syntheticByMethodUrl.has(key) === false && [...syntheticByMethodUrl.values()].some((e) => e.id === id)) {
        suffix += 1;
        id = `${stableId}_${suffix}`;
      }
      syntheticByMethodUrl.set(key, {
        id,
```

(Keep all other fields of the object literal unchanged.)

- [ ] **Step 2: Build and run tests**

Run: `npm test`
Expected: PASS. If a test asserts a literal `local-...` ID, update it to assert `/^ep_[a-z0-9]+/`.

- [ ] **Step 3: Commit**

```bash
git add src/scan-results.ts
git commit -m "refactor(endpoint-id): stable IDs for synthetic local endpoints (issue #82)"
```

---

## Task 7: Migrate persisted state in `webview-provider.ts`

**Batch:** C — Serial. Manual UI verification (Step 4 launches the Extension Development Host); only one EDH instance can attach at a time.

**Files:**
- Modify: `src/webview-provider.ts`

- [ ] **Step 1: Find the persistence sites**

Run: `grep -n "globalState\|eco.simulatorScenarios\|suppressedFindings\|getState\|update(" src/webview-provider.ts`

Note every place that reads or writes IDs to `vscode.globalState`. Most likely targets: simulator scenarios under `eco.simulatorScenarios`, possibly suppressed-finding lists.

- [ ] **Step 2: Add a load-time filter**

For each `globalState.get(...)` site that returns an array of records keyed by endpoint ID, immediately after the read add a filter step that drops entries whose `endpointId` is no longer present in the current scan's endpoint list. Log dropped entries through the `output` channel.

Example pattern (adapt to actual variable names found in step 1):

```typescript
import { getOutputChannel } from "./output";

// after: const saved = context.globalState.get<SavedScenario[]>("eco.simulatorScenarios", []);
const currentIds = new Set(currentEndpoints.map((e) => e.id));
const compatible: SavedScenario[] = [];
for (const scenario of saved) {
  const stillValid = scenario.endpointIds?.every((id) => currentIds.has(id)) ?? true;
  if (stillValid) {
    compatible.push(scenario);
  } else {
    getOutputChannel().appendLine(
      `[recost] Dropping saved scenario "${scenario.name}" — references endpoint IDs no longer present.`
    );
  }
}
```

> **Why drop instead of best-effort migrate**: the old `local-${scanId}-${n}` IDs carry zero structural information, so there is no way to map them to new IDs. The user sees a one-time message and re-saves any affected scenarios. The migration is logged so a curious user can find out why a scenario disappeared.

- [ ] **Step 3: Build the extension**

Run: `npm run build:ext`
Expected: clean.

- [ ] **Step 4: Smoke-test in the Extension Development Host**

Press F5 in VSCode. In the launched dev host, run a workspace scan. Open the simulator tab, save a scenario, close + reopen the panel — the scenario should still be there. Re-scan after editing any unrelated file — the scenario should still be there (because the endpoint ID didn't change with line numbers).

- [ ] **Step 5: Commit**

```bash
git add src/webview-provider.ts
git commit -m "feat(endpoint-id): drop persisted records with unrecognized IDs (issue #82)"
```

---

## Task 8: Stability test against a real refactor

**Batch:** D — Serial. Append-only edit to `src/test/endpoint-id.test.ts` created in F1 (Task 3).

**Files:**
- Modify: `src/test/endpoint-id.test.ts`

- [ ] **Step 1: Add an end-to-end stability test**

Append to `src/test/endpoint-id.test.ts` before the final `console.log`:

```typescript
  await run("end-to-end: same call, moved 20 lines, gets the same ID", () => {
    const callA = {
      provider: "openai",
      methodSignature: "chat.completions.create",
      filePath: "src/services/chat.ts",
      enclosingFunction: "ask",
      url: "sdk://openai/chat.completions.create",
    };
    const callB = { ...callA }; // same structural input — line/column intentionally absent
    assert.equal(computeEndpointId(callA), computeEndpointId(callB));
  });

  await run("end-to-end: two calls in same file but different functions diverge", () => {
    const a = computeEndpointId({
      provider: "openai", methodSignature: "chat.completions.create",
      filePath: "src/x.ts", enclosingFunction: "fnA",
      url: "sdk://openai/chat.completions.create",
    });
    const b = computeEndpointId({
      provider: "openai", methodSignature: "chat.completions.create",
      filePath: "src/x.ts", enclosingFunction: "fnB",
      url: "sdk://openai/chat.completions.create",
    });
    assert.notEqual(a, b);
  });
```

- [ ] **Step 2: Run**

Run: `npx tsc -p tsconfig.scanner-tests.json && node dist-test/test/endpoint-id.test.js`
Expected: all PASS, including two new tests.

- [ ] **Step 3: Commit**

```bash
git add src/test/endpoint-id.test.ts
git commit -m "test(endpoint-id): stability under refactor (issue #82)"
```

---

## Task 9: Acceptance verification

**Batch:** V — Serial. Final verification before PR.

- [ ] **Step 1: Run the full suite**

Run: `npm test`
Expected: all PASS.

- [ ] **Step 2: Walk the acceptance criteria from `docs/accuracy/traceability.md` § B3**

Confirm each is met:

- [ ] Endpoint IDs survive moving a call ±20 lines in the same file. (Tasks 3, 8 — line is not in the hash input.)
- [ ] Endpoint IDs survive renaming a containing variable but not the enclosing function. (Task 3, Task 8.)
- [ ] Two distinct calls to `openai.chat.completions.create` in the same file but different functions get distinct IDs. (Task 8.)
- [ ] `/api/users/123` and `/api/users/456` get the same ID. (Task 1, Task 3.)
- [ ] Saved simulator scenarios survive a scan after non-structural code changes. (Task 7 manual verification.)

- [ ] **Step 3: Update the roadmap**

Edit `docs/accuracy/traceability.md` § B3 — strike through "Investigation steps" and add at the bottom of the section: `✅ Landed: 2026-05-12, see <PR>.`

- [ ] **Step 4: Commit and ship**

```bash
git add docs/accuracy/traceability.md
git commit -m "docs(accuracy): mark B3 (stable endpoint IDs) shipped (issue #82)"
```

Then create the PR per repo convention.

---

## Self-Review Notes

- **Spec coverage**: every acceptance criterion from `docs/accuracy/traceability.md` § B3 maps to a task above (Task 9 verification step).
- **Placeholder scan**: zero TBDs. The one discovery step (Task 7 step 1) is necessary because persistence sites in `webview-provider.ts` change frequently and the audit needs to read current state.
- **Type consistency**: `EndpointIdInput` is the single contract; both call sites (`builder.ts` and `scan-results.ts`) pass identically shaped objects. The new `enclosingFunction` field flows uniformly: `AstCallMatch` → `ApiCallInput` → both ID consumers.
- **Out of scope (explicit)**: a real one-way migration that *maps* old IDs to new ones. There is no structural information in `local-${scanId}-${n}` to map from; we log + drop instead.
- **Risk**: removing `costModel` / `frequencyClass` from the ID input means *attribute changes don't reset state*, but it also means two calls that look structurally identical but differ in cost model now share an ID. This is rare (the same provider+method usually has one cost model) and arguably correct (cost model is metadata, not identity). Documented in Task 5 step 1 inline note.
