# B1 — Span-Based Source Locations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace single-line `line: number` with a full `SourceSpan` (start/end line + column) on every detection so the editor can highlight the call expression itself, multi-line calls report their true extent, and the parity test in A4 can compare locations meaningfully.

**Architecture:** Tree-sitter already exposes `node.startPosition` and `node.endPosition`; we wire those through the AST visitor → `AstCallMatch` → `ApiCallInput` → `ApiCallNode`. The regex path computes `endLine` as `startLine + (newlines in match)` and `endColumn` as `startColumn + lastLineLength`. The legacy `line: number` field is **kept** as a derived shortcut so existing tests don't break.

**Tech Stack:** TypeScript (strict), web-tree-sitter, esbuild, Node `assert/strict` test runner.

**Reference:** GitHub issue [#80](https://github.com/recost-dev/extension/issues/80); design note at `docs/accuracy/traceability.md` § B1.

---

## Execution Model

This plan is executed via **`superpowers:subagent-driven-development`**. The main session is the controller; it dispatches one **implementer subagent** per task, then runs **spec compliance** and **code quality** reviewer subagents on the result before moving on. Subagents follow `superpowers:test-driven-development` automatically.

Some tasks below touch strictly disjoint files and depend only on already-landed foundation types. Those are grouped into **parallel batches** dispatched via `superpowers:dispatching-parallel-agents`. The controller dispatches all implementers in a batch concurrently, waits for all to return, runs the merge + reviews described in the safety rules, then advances to the next batch.

### Parallel Safety Rules

These rules are non-negotiable. If a rule conflicts with a task as written, **that task runs serially** instead of being parallelized.

1. **One implementer per file.** No two parallel agents may write to the same file in the same batch. The "Files" block at the top of every task is the authoritative declaration; the controller checks for overlap before dispatching and refuses to start the batch on conflict.
2. **Worktree isolation.** Every parallel agent runs in its own git worktree via `superpowers:using-git-worktrees`. Worktrees are cut from the **same base SHA** at batch start. After all agents in the batch return DONE, the controller merges each branch into the working branch in **declared task order** (not return order), runs `npm test` after each merge, and only proceeds when the full suite is green.
3. **Foundation tasks never run in parallel.** Tasks that introduce or modify shared types (e.g. defining `SourceSpan`, adding fields to `ApiCallInput`, `AstCallMatch`, `ApiCallNode`) run **before** any batch that depends on those types. They are tagged `Foundation` and run serially.
4. **Each agent leaves the build green in its own worktree.** An agent that returns with broken types or failing tests is treated as `BLOCKED` per the subagent-driven-development skill. The controller does not merge a broken worktree.
5. **No cross-task type changes inside a parallel batch.** If a parallel agent realizes its task needs an additional shared-type change to compile, it must escalate (`NEEDS_CONTEXT`) instead of editing the type. The controller pulls the type change out as a new serial Foundation task and re-batches the rest.
6. **Reviewer subagents run after merge into the working branch**, not against the worktree. This catches integration regressions the implementer's local test pass missed.
7. **Triage and bug-hunting tasks are always serial.** Not applicable to this plan (no triage tasks), but called out for consistency with the B3 and A4 plans.
8. **Manual UI verification is always serial.** Tasks that require launching the Extension Development Host (Task 10 step 6 here) must be in a serial batch — only one EDH instance can attach to a workspace at a time.

### Batch Plan

| Batch | Tasks | Mode | Pre-condition |
|---|---|---|---|
| **F1** | Task 1 | Foundation (serial) | none |
| **F2** | Task 2 | Foundation (serial) | F1 merged |
| **A** | Tasks 3, 5, 6 | Parallel (3 agents) | F2 merged + green |
| **F3** | Task 4 | Foundation (serial) | A merged + green (Task 3 must have landed `CallInfo.span`) |
| **F4** | Task 7 | Foundation (serial) | F3 merged + green (consumes both `AstCallMatch.span` and `ApiCallMatch.span`) |
| **B** | Tasks 8, 9 | Parallel (2 agents) | F4 merged + green |
| **C** | Task 10 | Serial (manual UI verification) | B merged + green |
| **V** | Task 11 | Serial (verification) | C merged + green |

Total: ~5 parallel-agent dispatches across 11 tasks; estimated ~30% wall-time reduction vs. fully serial execution.

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `src/scanner/source-span.ts` | **Create** | `SourceSpan` interface + `pointSpan()` helper used everywhere a span is needed |
| `src/ast/call-visitor.ts` | Modify | Add `span: SourceSpan` to `CallInfo`; populate from tree-sitter node positions |
| `src/ast/ast-scanner.ts` | Modify | Add `span` to `AstCallMatch`; pass through in every emit site |
| `src/scanner/patterns/types.ts` | Modify | Add optional `span` to `ApiCallMatch` and `HttpCallMatch` (regex-side optional, AST-side required at the call-input layer) |
| `src/scanner/core-scanner.ts` | Modify | Compute regex-path span from match offset + source text; populate `span` on every `ApiCallInput` |
| `src/scanner/patterns.ts` | Modify | Pass match offset through to `matchLine` callers via a richer return type so `core-scanner` can compute spans |
| `src/analysis/types.ts` | Modify | Add `span?: SourceSpan` to `ApiCallInput` and `EndpointCallSite` |
| `src/intelligence/types.ts` | Modify | Add `span` to `ApiCallNode` |
| `src/intelligence/builder.ts` | Modify | Pipe `span` from `ApiCallInput` to `ApiCallNode` |
| `src/scan-results.ts` | Modify | Pipe `span` into `EndpointCallSite` when synthesizing endpoints |
| `src/messages.ts` | Modify | Add `revealSpan` IPC message (extends/replaces existing `openFile`) |
| `src/webview-provider.ts` | Modify | Handle `revealSpan` by calling `vscode.window.showTextDocument` with a `Selection` covering the span |
| `webview/src/components/ResultsPage.tsx` | Modify | Send the span (not just the line) when the user clicks an endpoint or finding |
| `src/test/source-span.test.ts` | **Create** | Unit tests for the regex-side span computer |
| `src/test/ast-call-visitor.test.ts` | Modify | Add assertions that `span` is populated and multi-line calls span >1 line |
| `package.json` | Modify | Add the new test file to `test:scanner` |

---

## Task 1: Define the `SourceSpan` type

**Batch:** F1 — Foundation, serial. No predecessors.

**Files:**
- Create: `src/scanner/source-span.ts`

- [ ] **Step 1: Write the new type module**

Create `src/scanner/source-span.ts`:

```typescript
/**
 * Span describing where a detection lives in source.
 *
 * - Lines are 1-based to match VSCode's display convention.
 * - Columns are 0-based to match tree-sitter's `startPosition.column`
 *   and VSCode's `Position` constructor.
 */
export interface SourceSpan {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

/** Build a zero-width span at a single point (used as a safe fallback). */
export function pointSpan(line: number, column = 0): SourceSpan {
  return { startLine: line, startColumn: column, endLine: line, endColumn: column };
}

/**
 * Compute the end position of a regex match given (a) the start line/column
 * inside the source and (b) the matched text. Walks the matched text counting
 * newlines so multi-line matches report their true extent.
 */
export function spanFromMatch(
  startLine: number,
  startColumn: number,
  matchText: string
): SourceSpan {
  let endLine = startLine;
  let endColumn = startColumn + matchText.length;
  const newlineCount = (matchText.match(/\n/g) ?? []).length;
  if (newlineCount > 0) {
    endLine = startLine + newlineCount;
    const lastNewline = matchText.lastIndexOf("\n");
    endColumn = matchText.length - lastNewline - 1;
  }
  return { startLine, startColumn, endLine, endColumn };
}
```

- [ ] **Step 2: Commit**

```bash
git add src/scanner/source-span.ts
git commit -m "feat(span): add SourceSpan type and helpers (issue #80)"
```

---

## Task 2: Test the regex-side span helper

**Batch:** F2 — Foundation, serial. Depends on F1.

**Files:**
- Create: `src/test/source-span.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/test/source-span.test.ts`:

```typescript
import assert from "node:assert/strict";
import { pointSpan, spanFromMatch } from "../scanner/source-span";

async function run(name: string, fn: () => Promise<void> | void): Promise<void> {
  try { await fn(); console.log(`PASS ${name}`); }
  catch (err) { console.error(`FAIL ${name}`); throw err; }
}

(async () => {
  await run("pointSpan: zero-width at line/col", () => {
    const s = pointSpan(5, 12);
    assert.deepEqual(s, { startLine: 5, startColumn: 12, endLine: 5, endColumn: 12 });
  });

  await run("spanFromMatch: single-line match", () => {
    const s = spanFromMatch(10, 4, `fetch("https://x")`);
    assert.equal(s.startLine, 10);
    assert.equal(s.startColumn, 4);
    assert.equal(s.endLine, 10);
    assert.equal(s.endColumn, 4 + `fetch("https://x")`.length);
  });

  await run("spanFromMatch: multi-line match", () => {
    const s = spanFromMatch(7, 0, `fetch(\n  "u",\n  { method: "POST" }\n)`);
    assert.equal(s.startLine, 7);
    assert.equal(s.endLine, 10);
    // The character after the last newline is `)`, so endColumn = 1 (one char on that line).
    assert.equal(s.endColumn, 1);
  });

  console.log("source-span.test PASSED");
})().catch((err) => { console.error(err); process.exit(1); });
```

- [ ] **Step 2: Wire the test into the script**

Edit `package.json` — append to the `test:scanner` script (just before the closing `"`):

```
 && node dist-test/test/source-span.test.js
```

- [ ] **Step 3: Build the tests**

Run: `npx tsc -p tsconfig.scanner-tests.json`
Expected: clean build (no TS errors).

- [ ] **Step 4: Run the test, verify it passes**

Run: `node dist-test/test/source-span.test.js`
Expected output: three `PASS` lines, then `source-span.test PASSED`.

- [ ] **Step 5: Commit**

```bash
git add src/test/source-span.test.ts package.json
git commit -m "test(span): unit-test SourceSpan helpers (issue #80)"
```

---

## Task 3: Add `span` to `CallInfo` (AST visitor)

**Batch:** A — parallel with Tasks 5 and 6. Touches only `src/ast/call-visitor.ts` and `src/test/ast-call-visitor.test.ts`. Build stays green: this task *adds* a field to `CallInfo` and populates it; existing consumers in `ast-scanner.ts` don't read the new field, so they continue to compile. F3 (Task 4) consumes the new field.

**Files:**
- Modify: `src/ast/call-visitor.ts`

- [ ] **Step 1: Update the type and emit-site**

Edit `src/ast/call-visitor.ts`:

Replace the `CallInfo` interface (currently around lines 12–25):

```typescript
import type { Tree, SyntaxNode } from "./parser-loader";
import type { SourceSpan } from "../scanner/source-span";

export interface CallInfo {
  /** Full dot-separated chain, e.g. "openai.chat.completions.create" */
  methodChain: string;
  /** Leftmost segment of the chain, e.g. "openai" */
  rootIdentifier: string;
  /** Raw argument AST nodes (caller can inspect for URL strings, etc.) */
  args: SyntaxNode[];
  /** 1-based line number of the call start (kept for back-compat). */
  line: number;
  /** 0-based column of the call start (kept for back-compat). */
  column: number;
  /** Full source span of the entire call expression. */
  span: SourceSpan;
  /** The call_expression AST node — used by callers for ancestor traversal. */
  node: SyntaxNode;
}
```

In `collectCalls()` (around line 87) replace the `results.push({...})` block (currently lines 105-112) with:

```typescript
        results.push({
          methodChain: segments.join("."),
          rootIdentifier: segments[0],
          args,
          line: node.startPosition.row + 1,
          column: node.startPosition.column,
          span: {
            startLine: node.startPosition.row + 1,
            startColumn: node.startPosition.column,
            endLine: node.endPosition.row + 1,
            endColumn: node.endPosition.column,
          },
          node,
        });
```

- [ ] **Step 2: Build to confirm types are consistent**

Run: `npx tsc -p tsconfig.scanner-tests.json`
Expected: clean build. `CallInfo` gains a new field; consumers in `ast-scanner.ts` don't read it yet (they will in F3/Task 4), so nothing breaks.

- [ ] **Step 3: Add a span assertion to the existing visitor test**

Edit `src/test/ast-call-visitor.test.ts`. Inside the existing first test (`"OpenAI SDK: chat.completions.create is extracted"`, around line 51), append after the existing assertions:

```typescript
    assert.equal(found!.span.startLine, 2);
    assert.ok(found!.span.endColumn >= found!.span.startColumn);
```

Then add a new test after the OpenAI block (before the Stripe section):

```typescript
  await run("span: multi-line call has endLine > startLine", async () => {
    const src = `
const r = await openai.chat.completions.create({
  model: "gpt-4o",
  messages: [{ role: "user", content: "hi" }],
});
`;
    const found = find(await calls(src), "openai.chat.completions.create");
    assert.ok(found, "must find call");
    assert.equal(found!.span.startLine, 2);
    assert.ok(found!.span.endLine > found!.span.startLine, "multi-line call must span >1 line");
  });
```

- [ ] **Step 4: Commit**

```bash
git add src/ast/call-visitor.ts src/test/ast-call-visitor.test.ts
git commit -m "feat(span): emit SourceSpan from AST call-visitor (issue #80)"
```

---

## Task 4: Add `span` to `AstCallMatch` and propagate through `ast-scanner.ts`

**Batch:** F3 — Foundation, serial. Depends on Batch A merged + green (specifically needs `CallInfo.span` from Task 3 and `pointSpan` from Task 1). Touches `src/ast/ast-scanner.ts`.

**Files:**
- Modify: `src/ast/ast-scanner.ts`

- [ ] **Step 1: Add `span` to the `AstCallMatch` interface**

Edit `src/ast/ast-scanner.ts`. Add `import type { SourceSpan } from "../scanner/source-span";` near the existing imports.

In the `AstCallMatch` interface (around line 30), add **immediately after the `column` field** (line 46):

```typescript
  /** Full source span of the call expression. */
  span: SourceSpan;
```

- [ ] **Step 2: Pipe `span` through every emit site**

Every `matches.push({ ... })` and `methodMatches.push({ ... })` and `fnMatches.push({ ... })` call inside `scanSourceWithAst()` currently sets `line` and `column`. For each one, also set `span`:

- For matches built directly from `callInfo` (the common case in sections 7c, 7e, the function-body scan in section 8): use `span: callInfo.span`.
- For matches re-emitted from the class registry / function-body cache with new `line, column` (sections 7d, 9, 10): build `span: { startLine: line, startColumn: column, endLine: line, endColumn: column }` (point-span — we lost the original node by the time we re-emit). Import and use `pointSpan(line, column)` from `../scanner/source-span` instead.

Concrete example for section 7e (around line 615), replace:

```typescript
      matches.push({
        kind: "sdk", provider, packageName, methodChain, confidence: 1.0, method: fp.httpMethod,
        endpoint: fp.endpoint, line, column, frequency, loopContext: inLoop,
        streaming: fp.streaming, batchCapable: fp.batchCapable, cacheCapable: fp.cacheCapable,
      });
    } else {
      matches.push({ kind: "sdk", provider, packageName, methodChain, confidence: provider ? 0.7 : 0.1, line, column, frequency, loopContext: inLoop });
    }
```

with:

```typescript
      matches.push({
        kind: "sdk", provider, packageName, methodChain, confidence: 1.0, method: fp.httpMethod,
        endpoint: fp.endpoint, line, column, span: callInfo.span, frequency, loopContext: inLoop,
        streaming: fp.streaming, batchCapable: fp.batchCapable, cacheCapable: fp.cacheCapable,
      });
    } else {
      matches.push({ kind: "sdk", provider, packageName, methodChain, confidence: provider ? 0.7 : 0.1, line, column, span: callInfo.span, frequency, loopContext: inLoop });
    }
```

For the spread-and-override sites (e.g. `matches.push({ ...m, line, column, frequency, ... })` around lines 593, 676, 697, 723), add `span: pointSpan(line, column)` after `column,`. Add `import { pointSpan } from "../scanner/source-span";`.

For the section 7c HTTP push (around line 561), add `span: callInfo.span,` after `column,`.

- [ ] **Step 3: Build and confirm ast-scanner compiles**

Run: `npx tsc -p tsconfig.scanner-tests.json`
Expected: clean build. `AstCallMatch` now requires `span`; every emit site populates it from `callInfo.span` or via `pointSpan(line, column)`. Downstream consumers (`core-scanner.ts`, etc.) don't read the new `span` field yet, so they continue to compile.

- [ ] **Step 4: Run the visitor test (built in task 3)**

Run: `node dist-test/test/ast-call-visitor.test.js`
Expected: all PASS, including the new multi-line span test.

- [ ] **Step 5: Commit**

```bash
git add src/ast/ast-scanner.ts
git commit -m "feat(span): propagate SourceSpan through AstCallMatch (issue #80)"
```

---

## Task 5: Add optional `span` to regex `ApiCallMatch` / `HttpCallMatch`

**Batch:** A — parallel with Tasks 3 and 6. Touches only `src/scanner/patterns/types.ts`. Build stays green: the new field is optional; no consumer is forced to populate it yet.

**Files:**
- Modify: `src/scanner/patterns/types.ts`

- [ ] **Step 1: Update the types**

Edit `src/scanner/patterns/types.ts`. Add at the top:

```typescript
import type { SourceSpan } from "../source-span";
```

Add `span?: SourceSpan;` as the last field of both `HttpCallMatch` and `ApiCallMatch` (the regex layer can't always compute it precisely — `core-scanner` will fill it in from the source text instead).

- [ ] **Step 2: Build to confirm**

Run: `npx tsc -p tsconfig.scanner-tests.json`
Expected: clean build. The new `span` field is optional, so existing matchers that don't emit it still satisfy the type.

- [ ] **Step 3: Commit**

```bash
git add src/scanner/patterns/types.ts
git commit -m "feat(span): allow regex matchers to carry SourceSpan (issue #80)"
```

---

## Task 6: Add `span` to `ApiCallInput` and `EndpointCallSite`

**Batch:** A — parallel with Tasks 3 and 5. Touches only `src/analysis/types.ts`. Build stays green: both fields are optional, so existing producers still satisfy the type.

**Files:**
- Modify: `src/analysis/types.ts`

- [ ] **Step 1: Update the types**

Edit `src/analysis/types.ts`. Add at the top:

```typescript
import type { SourceSpan } from "../scanner/source-span";
```

In `ApiCallInput`, add right after the existing `line: number;` field (line 3):

```typescript
  /** Full span of the call expression. Optional only because synthetic test inputs may omit it. */
  span?: SourceSpan;
```

In `EndpointCallSite`, add right after the existing `line: number;` field (line 61):

```typescript
  span?: SourceSpan;
```

- [ ] **Step 2: Commit**

```bash
git add src/analysis/types.ts
git commit -m "feat(span): add SourceSpan to ApiCallInput and EndpointCallSite (issue #80)"
```

---

## Task 7: Compute spans in `core-scanner.ts` for both AST and regex paths

**Batch:** F4 — Foundation, serial. Depends on F3 (Task 4) merged + green AND Task 6 merged + green (consumes both `AstCallMatch.span` and `ApiCallInput.span`).

**Files:**
- Modify: `src/scanner/core-scanner.ts`

- [ ] **Step 1: Update the AST → input mapper**

Edit `src/scanner/core-scanner.ts`. In `astMatchToApiCallInput()` (currently line 60), add `span: match.span,` immediately after `line: match.line,`. The function should now end with the existing return object plus the new field.

- [ ] **Step 2: Compute spans in the regex path**

Find the per-line regex-match loop in `scanFiles()` (around lines 160–200, both the route loop and the `matchLine` loop). For each `allCalls.push({ ... })` the function currently builds without a `span`. Before the push, compute the span using:

```typescript
            // span: regex matched a substring on this line; we can't recover the
            // exact match offset here without a richer matchLine API, so report a
            // line-wide span: column 0 → end of line.
            const span = {
              startLine: lineNum,
              startColumn: 0,
              endLine: lineNum,
              endColumn: line.length,
            };
```

Add `span,` to each `allCalls.push({ ... })` in this function.

> **Note on regex-side precision**: a true call-expression-tight span from the regex path requires changing `matchLine` to return offsets. That is a bigger refactor and is **out of scope** for this task — the line-wide span here is the documented compromise. The acceptance criterion "Multi-line calls (>3 lines) have endLine > startLine" is satisfied by the AST path; the regex path is single-line by construction (it iterates `lines[lineIndex]`).

- [ ] **Step 3: Build**

Run: `npx tsc -p tsconfig.scanner-tests.json`
Expected: clean build. `core-scanner.ts` now populates `span` on every `ApiCallInput`. Downstream consumers (`intelligence/builder.ts`, `scan-results.ts`) don't read it yet, so they continue to compile.

- [ ] **Step 4: Commit**

```bash
git add src/scanner/core-scanner.ts
git commit -m "feat(span): populate SourceSpan in ApiCallInput from both scan paths (issue #80)"
```

---

## Task 8: Add `span` to `ApiCallNode` and pipe through `intelligence/builder.ts`

**Batch:** B — parallel with Task 9. Touches only `src/intelligence/types.ts` and `src/intelligence/builder.ts` (plus optional `src/intelligence/__tests__/builder.test.ts`). No file overlap with Task 9 (which touches `src/scan-results.ts`).

**Files:**
- Modify: `src/intelligence/types.ts`
- Modify: `src/intelligence/builder.ts`

- [ ] **Step 1: Update the node type**

Edit `src/intelligence/types.ts`. Add at the top:

```typescript
import type { SourceSpan } from "../scanner/source-span";
```

In `ApiCallNode`, add immediately after `line: number;`:

```typescript
  span: SourceSpan | null;
```

- [ ] **Step 2: Pipe `span` through the builder**

Edit `src/intelligence/builder.ts`. In `buildRepoIntelligenceSnapshot()`, locate the `apiCallNode: ApiCallNode = { ... }` literal (around line 202). Add immediately after `line: call.line,`:

```typescript
        span: call.span ?? null,
```

- [ ] **Step 3: Build**

Run: `npx tsc -p tsconfig.scanner-tests.json`
Expected: clean (or only `scan-results.ts` / webview errors remaining).

- [ ] **Step 4: Run the existing intelligence builder tests**

Run: `node dist-test/intelligence/__tests__/builder.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/intelligence/types.ts src/intelligence/builder.ts
git commit -m "feat(span): wire SourceSpan into ApiCallNode and snapshot builder (issue #80)"
```

---

## Task 9: Pipe `span` into `EndpointCallSite` in `scan-results.ts`

**Batch:** B — parallel with Task 8. Touches only `src/scan-results.ts`. No file overlap with Task 8.

**Files:**
- Modify: `src/scan-results.ts`

- [ ] **Step 1: Add `span` to every constructed `callSite` object**

Edit `src/scan-results.ts`. There are four sites where a `callSites` entry is built or pushed (around lines 350-360, 388-396, 417-425). For each, add `span: call.span,` right after `line: call.line,`.

Example (the synthetic-create site around line 388):

```typescript
        callSites: [{
          file: call.file,
          line: call.line,
          span: call.span,
          library: call.library ?? "",
          frequency: call.frequency,
          frequencyClass: call.frequencyClass,
          crossFileOrigin: call.crossFileOrigin ?? null,
        }],
```

- [ ] **Step 2: Build**

Run: `npx tsc -p tsconfig.scanner-tests.json`
Expected: clean for the extension backend.

- [ ] **Step 3: Run the full scanner test suite**

Run: `npm test`
Expected: all PASS.

- [ ] **Step 4: Commit**

```bash
git add src/scan-results.ts
git commit -m "feat(span): include SourceSpan on EndpointCallSite (issue #80)"
```

---

## Task 10: Reveal-by-span in the IPC layer

**Batch:** C — Serial. Manual UI verification (Step 6 launches the Extension Development Host); only one EDH instance can attach at a time, so this can never be parallel with another EDH-using task.

**Files:**
- Modify: `src/messages.ts`
- Modify: `src/webview-provider.ts`
- Modify: `webview/src/components/ResultsPage.tsx`

- [ ] **Step 1: Find the existing open-file IPC**

Run: `grep -rn "showTextDocument\|revealRange\|openFile\|revealSpan" src/ webview/src/`
Read both sides — the message name and shape vary. Note the existing IPC name (likely something like `openFile` or `revealLocation`).

- [ ] **Step 2: Extend the existing message with `span`**

In `src/messages.ts`, locate the existing reveal/open-file message type and add an optional `span?: SourceSpan` field next to the existing `line` field. Import `SourceSpan` from `./scanner/source-span` if not already imported.

- [ ] **Step 3: Use the span in `webview-provider.ts`**

In `src/webview-provider.ts`, locate the handler for that message. Where it currently builds a `vscode.Position` or calls `revealRange` from `line`, prefer the span if present:

```typescript
import * as vscode from "vscode";

const range = msg.span
  ? new vscode.Range(
      msg.span.startLine - 1, msg.span.startColumn,
      msg.span.endLine - 1, msg.span.endColumn,
    )
  : new vscode.Range(msg.line - 1, 0, msg.line - 1, 0);

const editor = await vscode.window.showTextDocument(uri);
editor.selection = new vscode.Selection(range.start, range.end);
editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
```

- [ ] **Step 4: Send the span from the webview**

In `webview/src/components/ResultsPage.tsx`, find where endpoints/findings dispatch the open-file IPC. Where the payload currently includes `{ file, line }`, add `span: callSite.span` (or the equivalent local field). The webview type for that field comes from the shared type module; if there's a webview-side mirror, add `span?: SourceSpan` there too.

- [ ] **Step 5: Build the extension and webview**

Run: `npm run build:ext && npm run build:webview`
Expected: clean builds, no TS errors.

- [ ] **Step 6: Manual test in Extension Development Host**

In a separate terminal: open VSCode, press F5 to launch the Extension Development Host, run a workspace scan on a fixture project containing this multi-line OpenAI call:

```typescript
const r = await openai.chat.completions.create({
  model: "gpt-4o",
  messages: [{ role: "user", content: "hi" }],
});
```

Click the endpoint in the sidebar.

Expected: editor opens with the **whole call selected** (lines highlighted from `await openai...` through the closing `)`), not just the cursor parked on line 1.

- [ ] **Step 7: Commit**

```bash
git add src/messages.ts src/webview-provider.ts webview/src/components/ResultsPage.tsx
git commit -m "feat(span): reveal full call expression on click (issue #80)"
```

---

## Task 11: Acceptance verification

**Batch:** V — Serial. Final verification before PR.

- [ ] **Step 1: Run full test suite**

Run: `npm test`
Expected: all PASS.

- [ ] **Step 2: Verify each acceptance criterion against the diff**

Walk the four acceptance criteria from `docs/accuracy/traceability.md` § B1 and confirm each is met:

- [ ] `EndpointRecord` (via `EndpointCallSite.span`) exposes a `SourceSpan` with all four numbers populated.
- [ ] Multi-line calls (>3 lines) have `endLine > startLine` (covered by Task 3 test).
- [ ] Clicking a detection in the webview opens the editor with the span selected (covered by Task 10 manual test).
- [ ] Existing `line`-based test assertions still work (covered by `npm test` PASS in step 1; `line` is still emitted alongside `span`).

- [ ] **Step 3: Update the roadmap**

Edit `docs/accuracy/traceability.md` § B1 — strike through "Investigation steps" and add a line at the bottom of the section: `✅ Landed: 2026-05-12, see <PR>.`

- [ ] **Step 4: Commit and ship**

```bash
git add docs/accuracy/traceability.md
git commit -m "docs(accuracy): mark B1 (span-based locations) shipped (issue #80)"
```

Then create the PR per repo convention.

---

## Self-Review Notes

- **Spec coverage**: every acceptance criterion in `docs/accuracy/traceability.md` § B1 is mapped to a task above (Task 11 verification step).
- **Placeholder scan**: zero TBDs; every step has either explicit code, an explicit command, or an explicit edit target. The one "find the existing IPC" step (Task 10 step 1) is necessarily a discovery — `messages.ts` is small and the existing reveal-file IPC name varies between past audits.
- **Type consistency**: `SourceSpan` is defined once in `src/scanner/source-span.ts`; every consumer imports it from that location. `line: number` is preserved everywhere as a derived shortcut.
- **Out of scope (explicit)**: tightening regex-side spans below line granularity. That requires a `matchLine` API change and would balloon this plan. The line-wide span is the documented compromise; A4 (parity) only requires comparable line numbers, which we satisfy.
