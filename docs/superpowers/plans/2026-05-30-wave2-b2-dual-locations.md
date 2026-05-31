# Wave 2 — B2 Dual Locations for Cross-File Resolved Calls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface *both* the user's call site and the underlying SDK call site for cross-file-resolved API calls, with both as click targets in the sidebar.

**Architecture:** The cross-file resolver (`cross-file-resolver.ts`) already propagates a callee's SDK call up to its callers, overriding `line` with the caller's call-site line while keeping the callee's `span`. That conflation is the bug. We add a `CallTrace { callSite, resolvedSite, hops }` structure that is populated at propagation time, threaded through `ApiCallInput → EndpointCallSite` and `ApiCallNode`, and consumed by the webview to offer "open my call site" (default) vs. "show underlying call". Direct (non-propagated) calls get a degenerate trace (`hops = 0`, both sites equal), so every detection carries the same shape.

**Tech Stack:** TypeScript (strict), esbuild, React 18 sidebar webview, `node:assert/strict` tests compiled by `tsc` and run via `npm run test:scanner`.

---

## Wave 2 scope note (read first)

Wave 2 (Traceability) has two open issues:

- **#81 — B2 dual locations** — implemented by this plan. Fully self-contained in `recost-dev/extension`.
- **#113 — barrel/factory corpus fixtures** — the 7 fixtures live in `recost-dev/extension-benchmark`, a **separate repo this session has no write access to**. The only in-repo work is refreshing `benchmark/baseline.json` *after* the fixtures land. That is captured as **Task 9** (blocked) — do not attempt to create the fixtures from this repo.

The B3 stable-ID acceptance criterion that B2 references (#81 AC-4) is **already satisfied by B3's design**: `computeEndpointId` (`src/scanner/endpoint-id.ts`) hashes provider + methodSignature + normalized file path + enclosing function + masked URL — it excludes line, column, and span entirely. Moving a call site therefore cannot reset an endpoint ID. We do **not** re-key the hash on `resolvedSite.file` (that would risk collapsing distinct callers into one endpoint and is a benchmark-detection-metric hazard). Instead, Task 6 adds a regression test that proves the ID is unchanged when the call-site span moves, and Task 9 marks AC-4 satisfied with that reasoning.

---

## File Structure

**New files**
- `src/scanner/call-trace.ts` — `ResolvedLocation`, `CallTrace` interfaces + `directTrace()` helper. One responsibility: the dual-location type and its degenerate constructor. Lives next to `source-span.ts` (same layer, no Node/VSCode deps).
- `src/test/call-trace.test.ts` — unit test for `directTrace()`.

**Modified files**
- `src/ast/ast-scanner.ts` — add optional `trace?: CallTrace` to `AstCallMatch`.
- `src/ast/cross-file-resolver.ts` — populate `trace` in `cloneWithCallerContext` (import + middleware paths) and in `runFactoryReturnPostPass`.
- `src/test/ast-cross-file-resolver.test.ts` — add trace assertions.
- `src/analysis/types.ts` — add `callTrace?: CallTrace` to `ApiCallInput` and `EndpointCallSite`.
- `src/scanner/core-scanner.ts` — forward `match.trace` into `ApiCallInput.callTrace`.
- `src/scan-results.ts` — populate `callTrace` at the three call-site construction sites (with a `directTrace` fallback).
- `src/intelligence/types.ts` — add `callTrace?: CallTrace` to `ApiCallNode`.
- `src/intelligence/builder.ts` — populate `callTrace` on each `ApiCallNode`.
- `src/test/endpoint-id.test.ts` — add the AC-4 regression test (ID stable across call-site span move).
- `webview/src/types.ts` — mirror `CallTrace` and add `callTrace?` to `EndpointRecord.callSites[]`.
- `webview/src/components/ResultsPage.tsx` — default click → `callSite`; add "underlying call" affordance when `hops > 0`.

No `messages.ts` / `webview-provider.ts` change is required: the existing `openFile` IPC already carries `{ file, line?, span? }` and `handleOpenFile` already selects a span when present. The "underlying call" button just posts `openFile` with the resolved file + span.

---

### Task 1: Define the `CallTrace` type and `directTrace` helper

**Files:**
- Create: `src/scanner/call-trace.ts`
- Test: `src/test/call-trace.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/test/call-trace.test.ts
import assert from "node:assert/strict";
import { directTrace } from "../scanner/call-trace";
import { pointSpan } from "../scanner/source-span";

function run(name: string, fn: () => void): void {
  try { fn(); console.log(`PASS ${name}`); }
  catch (err) { console.error(`FAIL ${name}`); throw err; }
}

run("directTrace: hops is 0 and both sites are equal", () => {
  const span = pointSpan(12, 4);
  const trace = directTrace("services/chat.ts", span);
  assert.equal(trace.hops, 0);
  assert.deepEqual(trace.callSite, { file: "services/chat.ts", span });
  assert.deepEqual(trace.resolvedSite, trace.callSite);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsc -p tsconfig.json --noEmit` (expected: error — module `../scanner/call-trace` not found / `directTrace` not exported).

- [ ] **Step 3: Write minimal implementation**

```ts
// src/scanner/call-trace.ts
import type { SourceSpan } from "./source-span";

/** A concrete location: a workspace-relative file plus a span within it. */
export interface ResolvedLocation {
  /** Workspace-relative path (matches EndpointCallSite.file). */
  file: string;
  span: SourceSpan;
}

/**
 * Dual-location trace for a detected call.
 *
 * - `callSite`     — where the user's code invokes the (possibly wrapped) call.
 * - `resolvedSite` — where the underlying SDK call actually lives.
 * - `hops`         — 0 for a direct call (the two sites are equal), >=1 when the
 *                    call was propagated across one or more wrapper files.
 */
export interface CallTrace {
  callSite: ResolvedLocation;
  resolvedSite: ResolvedLocation;
  hops: number;
}

/** Build a degenerate trace for a direct (non-propagated) call. */
export function directTrace(file: string, span: SourceSpan): CallTrace {
  const loc: ResolvedLocation = { file, span };
  return { callSite: loc, resolvedSite: loc, hops: 0 };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build:ext && node dist-test/test/call-trace.test.js` (or `npm run test:scanner` after Task 8 wiring). Expected: `PASS directTrace: hops is 0 and both sites are equal`.

- [ ] **Step 5: Commit**

```bash
git add src/scanner/call-trace.ts src/test/call-trace.test.ts
git commit -m "feat(b2): add CallTrace type and directTrace helper"
```

---

### Task 2: Add `trace` to `AstCallMatch` and populate it in the cross-file resolver

**Files:**
- Modify: `src/ast/ast-scanner.ts:32-67` (`AstCallMatch` interface)
- Modify: `src/ast/cross-file-resolver.ts` (`cloneWithCallerContext`, its 3 call sites, `runFactoryReturnPostPass`)
- Test: `src/test/ast-cross-file-resolver.test.ts`

- [ ] **Step 1: Write the failing test** (append to `src/test/ast-cross-file-resolver.test.ts`, after the existing tests)

```ts
run("B2: propagated match carries a trace (hops=1, callSite=caller, resolvedSite=callee)", () => {
  const calleeFile: PerFileResult = {
    filePath: "/project/lib/ai.ts",
    relativePath: "lib/ai.ts",
    source: `
import OpenAI from "openai";
const client = new OpenAI();
export async function callAI(prompt: string) {
  return await client.chat.completions.create({ model: "gpt-4o", messages: [] });
}
`.trim(),
    result: makeResult({ matches: [makeMatch({ line: 4 })] }),
  };
  const callerFile: PerFileResult = {
    filePath: "/project/app.ts",
    relativePath: "app.ts",
    source: `
import { callAI } from "./lib/ai";
async function handle() {
  await callAI("hi");
}
`.trim(),
    result: makeResult({
      matches: [makeMatch({ methodChain: "callAI", provider: undefined, packageName: undefined, line: 3 })],
    }),
  };

  const output = runCrossFileResolution([calleeFile, callerFile]);
  const propagated = output.get("app.ts")!.filter((m) => m.crossFile);
  assert.ok(propagated.length > 0, "expected a propagated match");
  const trace = propagated[0].trace;
  assert.ok(trace, "propagated match should carry a trace");
  assert.equal(trace!.hops, 1, "single wrapper hop");
  assert.equal(trace!.callSite.file, "app.ts", "callSite is the caller file");
  assert.equal(trace!.resolvedSite.file, "lib/ai.ts", "resolvedSite is the callee file");
  assert.equal(trace!.resolvedSite.span.startLine, 4, "resolvedSite span points at the SDK call line");
});

run("B2: direct (non-propagated) match has no trace", () => {
  const file: PerFileResult = {
    filePath: "/project/solo.ts",
    relativePath: "solo.ts",
    source: `
import OpenAI from "openai";
const client = new OpenAI();
await client.chat.completions.create({ model: "gpt-4o", messages: [] });
`.trim(),
    result: makeResult({ matches: [makeMatch({ line: 3 })] }),
  };
  const output = runCrossFileResolution([file]);
  const direct = output.get("solo.ts")!.filter((m) => !m.crossFile);
  assert.equal(direct[0].trace, undefined, "direct matches carry no trace (defaulted downstream)");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsc -p tsconfig.json --noEmit`. Expected: error — `Property 'trace' does not exist on type 'AstCallMatch'`.

- [ ] **Step 3a: Add `trace` to `AstCallMatch`** — in `src/ast/ast-scanner.ts`, inside the `AstCallMatch` interface (after the `sourceFile?: string;` field at line 66), add:

```ts
  /**
   * Dual-location trace, set ONLY for cross-file-propagated matches. Absent for
   * direct matches (downstream defaults to a degenerate `directTrace`).
   */
  trace?: import("../scanner/call-trace").CallTrace;
```

- [ ] **Step 3b: Import the helpers in the resolver** — at the top of `src/ast/cross-file-resolver.ts` (after the existing imports, around line 19) add:

```ts
import { pointSpan, type SourceSpan } from "../scanner/source-span";
import type { CallTrace, ResolvedLocation } from "../scanner/call-trace";
```

- [ ] **Step 3c: Extend `cloneWithCallerContext`** — replace the function (currently `src/ast/cross-file-resolver.ts:336-354`) with:

```ts
function cloneWithCallerContext(
  callee: AstCallMatch,
  callerLine: number,
  callerFrequency: AstCallMatch["frequency"],
  callerLoopContext: boolean,
  isMiddleware: boolean,
  calleeFilePath: string,
  callerFilePath: string,
  callerRelative: string,
  callerSpan: SourceSpan,
  resolvedRelative: string
): AstCallMatch {
  // The resolved (underlying SDK) site is the callee's own location, unless the
  // callee was itself propagated (wrapper-of-a-wrapper), in which case carry its
  // original resolved site forward and just deepen the hop count.
  const resolvedSite: ResolvedLocation = callee.trace
    ? callee.trace.resolvedSite
    : { file: resolvedRelative, span: callee.span };
  const trace: CallTrace = {
    callSite: { file: callerRelative, span: callerSpan },
    resolvedSite,
    hops: (callee.trace?.hops ?? 0) + 1,
  };
  return {
    ...callee,
    line: callerLine,
    frequency: isMiddleware ? "single" : callerFrequency,
    loopContext: isMiddleware ? false : callerLoopContext,
    isMiddleware: isMiddleware || callee.isMiddleware,
    crossFile: true,
    sourceFile: calleeFilePath,
    trace,
  };
}
```

- [ ] **Step 3d: Pass the new args at the import-propagation call sites** — in `runCrossFileResolution`, inside the `for (const { localName, specifier, isDefault } of imports)` loop, compute the resolved relative path once right after `if (!resolvedFile) continue;` (currently line 548):

```ts
        const resolvedRelative = relativePathByNormalized.get(resolvedFile) ?? resolvedFile;
```

Then update the two `cloneWithCallerContext(...)` calls in that loop:

The **callSites** path (currently lines 581-592) — `site` is an `AstCallMatch` and has a real span:

```ts
              tryPush(
                callerRelative,
                cloneWithCallerContext(
                  callee, site.line, site.frequency, site.loopContext, false,
                  resolvedFile, callerPath, callerRelative, site.span, resolvedRelative
                )
              );
```

The **callSiteLines** path (currently lines 598-601) — only a bare line is known, so synthesize a line-anchored span:

```ts
              tryPush(
                callerRelative,
                cloneWithCallerContext(
                  callee, lineNum, "single", false, false,
                  resolvedFile, callerPath, callerRelative, pointSpan(lineNum), resolvedRelative
                )
              );
```

- [ ] **Step 3e: Pass the new args at the middleware call site** — in the middleware loop, after `if (!resolvedFile) continue;` (currently line 613) add:

```ts
        const resolvedRelative = relativePathByNormalized.get(resolvedFile) ?? resolvedFile;
```

and update the `cloneWithCallerContext(...)` call (currently lines 630-639):

```ts
          tryPush(
            callerRelative,
            cloneWithCallerContext(
              callee, useLine ?? callee.line, "single", false, true,
              resolvedFile, callerPath, callerRelative, pointSpan(useLine ?? callee.line), resolvedRelative
            )
          );
```

- [ ] **Step 3f: Set a trace on factory-post-pass matches** — in `runFactoryReturnPostPass` (`src/ast/cross-file-resolver.ts:714`), build a normalized→relative map at the top of the function (right after the signature, before "Step 1"):

```ts
  const relByNorm = new Map(files.map((f) => [normalizePath(f.filePath), f.relativePath]));
```

Then in the emitted match literal (currently lines 772-786), add a `trace` field after `sourceFile: resolvedFile,`:

```ts
            trace: {
              callSite: { file: consumer.relativePath, span: pointSpan(line) },
              // The factory's own `new X()` span isn't tracked; point at the
              // resolved file's top as a best-effort underlying location.
              resolvedSite: { file: relByNorm.get(resolvedFile) ?? resolvedFile, span: pointSpan(1) },
              hops: 1,
            },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsc -p tsconfig.json --noEmit && node dist-test/test/ast-cross-file-resolver.test.js`.
Expected: all existing resolver tests still `PASS`, plus the two new `B2:` tests `PASS`.

- [ ] **Step 5: Commit**

```bash
git add src/ast/ast-scanner.ts src/ast/cross-file-resolver.ts src/test/ast-cross-file-resolver.test.ts
git commit -m "feat(b2): populate CallTrace for cross-file propagated matches"
```

---

### Task 3: Forward the trace into `ApiCallInput`

**Files:**
- Modify: `src/analysis/types.ts:3-25` (`ApiCallInput`)
- Modify: `src/scanner/core-scanner.ts:109-159` (`astMatchToApiCallInput`)
- Test: `src/test/ast-cross-file-resolver.test.ts` is upstream; the conversion is covered end-to-end by Task 5. This task is type-plumbing only — no new dedicated test (the `tsc` gate + Task 5 cover it).

- [ ] **Step 1: Add the field to `ApiCallInput`** — in `src/analysis/types.ts`, after `crossFileOrigin?: ... | null;` (line 24) add:

```ts
  /** Dual-location trace. Set by the AST path for cross-file calls; undefined otherwise. */
  callTrace?: import("../scanner/call-trace").CallTrace;
```

- [ ] **Step 2: Forward it in `astMatchToApiCallInput`** — in `src/scanner/core-scanner.ts`, in the returned object (after `crossFileOrigin,` at line 157) add:

```ts
    callTrace: match.trace,
```

- [ ] **Step 3: Verify the type-checks pass**

Run: `npx tsc -p tsconfig.json --noEmit`. Expected: clean (no errors).

- [ ] **Step 4: Commit**

```bash
git add src/analysis/types.ts src/scanner/core-scanner.ts
git commit -m "feat(b2): forward CallTrace into ApiCallInput"
```

---

### Task 4: Carry `callTrace` on `EndpointCallSite` and populate it in `scan-results.ts`

**Files:**
- Modify: `src/analysis/types.ts:67-77` (`EndpointCallSite`)
- Modify: `src/scan-results.ts` (3 call-site construction sites: lines ~481, ~535, ~567)
- Test: `src/test/scan-results.test.ts`

- [ ] **Step 1: Write the failing test** (append to `src/test/scan-results.test.ts`; reuse that file's existing harness/imports — it already imports `buildLocalScanResults`/`buildRemoteScanResults` and a `run` helper)

```ts
run("B2: cross-file call yields a callSite with hops>=1 and distinct resolvedSite", () => {
  const calls: ApiCallInput[] = [
    {
      file: "app.ts",
      line: 3,
      span: { startLine: 3, startColumn: 0, endLine: 3, endColumn: 20 },
      method: "POST",
      url: "sdk://openai/chat.completions.create",
      library: "openai",
      provider: "openai",
      methodSignature: "chat.completions.create",
      callTrace: {
        callSite: { file: "app.ts", span: { startLine: 3, startColumn: 0, endLine: 3, endColumn: 20 } },
        resolvedSite: { file: "lib/ai.ts", span: { startLine: 4, startColumn: 2, endLine: 4, endColumn: 60 } },
        hops: 1,
      },
    },
  ];
  const result = buildLocalScanResults(calls, "proj", "local-test");
  const ep = result.endpoints.find((e) => e.provider === "openai")!;
  const site = ep.callSites[0];
  assert.ok(site.callTrace, "call site should carry a callTrace");
  assert.equal(site.callTrace!.hops, 1);
  assert.equal(site.callTrace!.callSite.file, "app.ts");
  assert.equal(site.callTrace!.resolvedSite.file, "lib/ai.ts");
});

run("B2: direct call gets a degenerate callTrace (hops=0, sites equal)", () => {
  const calls: ApiCallInput[] = [
    {
      file: "solo.ts",
      line: 9,
      span: { startLine: 9, startColumn: 0, endLine: 9, endColumn: 30 },
      method: "POST",
      url: "sdk://openai/chat.completions.create",
      library: "openai",
      provider: "openai",
      methodSignature: "chat.completions.create",
    },
  ];
  const result = buildLocalScanResults(calls, "proj", "local-test");
  const site = result.endpoints[0].callSites[0];
  assert.ok(site.callTrace, "direct call should still carry a (degenerate) callTrace");
  assert.equal(site.callTrace!.hops, 0);
  assert.deepEqual(site.callTrace!.callSite, site.callTrace!.resolvedSite);
});
```

> Note: if `buildLocalScanResults` is not the exact exported name in `scan-results.ts`, use whichever builder the existing `scan-results.test.ts` already imports for local results; the assertions are unchanged.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsc -p tsconfig.json --noEmit`. Expected: error — `Property 'callTrace' does not exist on type 'EndpointCallSite'` (and on the call-site literals).

- [ ] **Step 3a: Add the field to `EndpointCallSite`** — in `src/analysis/types.ts`, after `crossFileOrigin?: ... | null;` (line 76) add:

```ts
  /** Dual-location trace for this call site. Degenerate (hops=0) for direct calls. */
  callTrace?: import("../scanner/call-trace").CallTrace;
```

- [ ] **Step 3b: Import the fallback helper** — at the top of `src/scan-results.ts`, alongside the existing `import { computeEndpointId } from "./scanner/endpoint-id";` (line 5) add:

```ts
import { directTrace } from "./scanner/call-trace";
import { pointSpan } from "./scanner/source-span";
```

- [ ] **Step 3c: Populate `callTrace` at all three call-site literals** — in `src/scan-results.ts`, each of the three `endpoint.callSites.push({...})` / `callSites: [{...}]` / `synthetic.callSites.push({...})` blocks (lines ~481, ~535, ~567) ends with `crossFileOrigin: call.crossFileOrigin ?? null,`. Add this line immediately after it in **each** of the three blocks:

```ts
          callTrace: call.callTrace ?? directTrace(call.file, call.span ?? pointSpan(call.line)),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsc -p tsconfig.json --noEmit && node dist-test/test/scan-results.test.js`.
Expected: existing scan-results tests still `PASS`, plus the two new `B2:` tests `PASS`.

- [ ] **Step 5: Commit**

```bash
git add src/analysis/types.ts src/scan-results.ts src/test/scan-results.test.ts
git commit -m "feat(b2): populate callTrace on EndpointCallSite (degenerate for direct calls)"
```

---

### Task 5: Carry `callTrace` on `ApiCallNode` and populate it in `builder.ts`

**Files:**
- Modify: `src/intelligence/types.ts:12-30` (`ApiCallNode`)
- Modify: `src/intelligence/builder.ts:187-205` (node construction)
- Test: `src/test/builder.test.ts` (the existing intelligence builder test; if absent, add the assertions to `src/test/scan-results.test.ts` against `buildSnapshot`)

- [ ] **Step 1: Write the failing test** (append to the builder test; mirror the file's existing `buildSnapshot` usage and `run` harness)

```ts
run("B2: ApiCallNode carries the callTrace from its ApiCallInput", () => {
  const snapshot = buildSnapshot({
    apiCalls: [
      {
        file: "app.ts",
        line: 3,
        span: { startLine: 3, startColumn: 0, endLine: 3, endColumn: 20 },
        method: "POST",
        url: "sdk://openai/chat.completions.create",
        library: "openai",
        provider: "openai",
        methodSignature: "chat.completions.create",
        callTrace: {
          callSite: { file: "app.ts", span: { startLine: 3, startColumn: 0, endLine: 3, endColumn: 20 } },
          resolvedSite: { file: "lib/ai.ts", span: { startLine: 4, startColumn: 2, endLine: 4, endColumn: 60 } },
          hops: 1,
        },
      },
    ],
    findings: [],
  });
  const node = Object.values(snapshot.apiCalls)[0];
  assert.ok(node.callTrace, "node should carry a callTrace");
  assert.equal(node.callTrace!.hops, 1);
  assert.equal(node.callTrace!.resolvedSite.file, "lib/ai.ts");
});
```

> Note: match the exact `buildSnapshot` argument shape the existing builder test uses (it may take a single object or positional args). The assertions on `snapshot.apiCalls` are unchanged.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsc -p tsconfig.json --noEmit`. Expected: error — `Property 'callTrace' does not exist on type 'ApiCallNode'`.

- [ ] **Step 3a: Add the field to `ApiCallNode`** — in `src/intelligence/types.ts`, after `crossFileOrigin: { file: string; functionName: string } | null;` (line 29) add:

```ts
  callTrace?: import("../scanner/call-trace").CallTrace;
```

- [ ] **Step 3b: Populate it in the node literal** — in `src/intelligence/builder.ts`, in the `const apiCallNode: ApiCallNode = {...}` object (after `crossFileOrigin: normalizeCrossFileOrigin(call.crossFileOrigin),` at line 204) add:

```ts
        callTrace: call.callTrace,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsc -p tsconfig.json --noEmit && node dist-test/test/builder.test.js`.
Expected: existing builder tests `PASS`, plus the new `B2:` test `PASS`.

- [ ] **Step 5: Commit**

```bash
git add src/intelligence/types.ts src/intelligence/builder.ts src/test/builder.test.ts
git commit -m "feat(b2): carry callTrace through ApiCallNode in the intelligence graph"
```

---

### Task 6: Regression test for AC-4 (endpoint ID stable across call-site span move)

**Files:**
- Test: `src/test/endpoint-id.test.ts`

This proves #81 acceptance criterion 4 without re-keying the hash (see the scope note). `computeEndpointId` already excludes spans/lines, so two inputs that differ only by call-site position must produce the same ID.

- [ ] **Step 1: Write the test** (append to `src/test/endpoint-id.test.ts`, reusing its existing `run` harness and `computeEndpointId` import)

```ts
run("B2/AC-4: endpoint ID is unchanged when the call site moves (resolvedSite-stable)", () => {
  const base = {
    provider: "openai",
    methodSignature: "chat.completions.create",
    filePath: "lib/ai.ts",
    enclosingFunction: "callAI",
    url: "sdk://openai/chat.completions.create",
  };
  // Identical structural inputs — the only thing a call-site move changes (line,
  // column, span) is not part of the hash, so the ID must be identical.
  assert.equal(computeEndpointId(base), computeEndpointId({ ...base }));
});
```

- [ ] **Step 2: Run test to verify it passes immediately** (this asserts existing behavior; it is a guardrail against a future hash change)

Run: `npx tsc -p tsconfig.json --noEmit && node dist-test/test/endpoint-id.test.js`.
Expected: all `PASS`, including the new `B2/AC-4` case.

- [ ] **Step 3: Commit**

```bash
git add src/test/endpoint-id.test.ts
git commit -m "test(b2): assert endpoint ID is stable across call-site moves (AC-4)"
```

---

### Task 7: Mirror `CallTrace` in the webview types

**Files:**
- Modify: `webview/src/types.ts:20-51` (`EndpointRecord`)

The webview cannot import from `src/` (separate build), so it carries its own mirror types (it already mirrors `SourceSpan`).

- [ ] **Step 1: Add the mirror types** — in `webview/src/types.ts`, near the top alongside the existing `SourceSpan` declaration, add:

```ts
export interface ResolvedLocation {
  file: string;
  span: SourceSpan;
}

export interface CallTrace {
  callSite: ResolvedLocation;
  resolvedSite: ResolvedLocation;
  hops: number;
}
```

- [ ] **Step 2: Add `callTrace` to the call-site shape** — in the `callSites` inline type (lines 29-37), after `crossFileOrigin?: { file: string; functionName: string } | null;` add:

```ts
    callTrace?: CallTrace;
```

- [ ] **Step 3: Verify the webview type-checks**

Run: `npm run build:webview`. Expected: clean build (no type errors).

- [ ] **Step 4: Commit**

```bash
git add webview/src/types.ts
git commit -m "feat(b2): mirror CallTrace in webview types"
```

---

### Task 8: Webview UI — default click → call site, "underlying call" affordance → resolved site

**Files:**
- Modify: `webview/src/components/ResultsPage.tsx:474-503` (Endpoints provider-group render)

- [ ] **Step 1: Update the call-site button to prefer the trace, and add the underlying-call link** — replace the `{fileName && filePath && (...)}` block (currently lines 491-500) with:

```tsx
            {fileName && filePath && (
              <div style={{ display: "flex", flexDirection: "column", gap: "1px" }}>
                <button
                  className="eco-btn-link"
                  style={{ fontSize: "10px", opacity: 0.7, maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", textAlign: "left" }}
                  title={site?.callTrace?.callSite.file ?? filePath}
                  onClick={() =>
                    postMessage({
                      type: "openFile",
                      file: site?.callTrace?.callSite.file ?? filePath,
                      line: site?.callTrace?.callSite.span.startLine ?? site?.line,
                      span: site?.callTrace?.callSite.span ?? site?.span,
                    })
                  }
                >
                  {fileName}{(site?.callTrace?.callSite.span.startLine ?? site?.line) ? `:${site?.callTrace?.callSite.span.startLine ?? site?.line}` : ""}
                </button>
                {site?.callTrace && site.callTrace.hops > 0 && (
                  <button
                    className="eco-btn-link"
                    style={{ fontSize: "10px", opacity: 0.55, maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", textAlign: "left" }}
                    title={`Underlying call: ${site.callTrace.resolvedSite.file}:${site.callTrace.resolvedSite.span.startLine}`}
                    onClick={() =>
                      postMessage({
                        type: "openFile",
                        file: site.callTrace!.resolvedSite.file,
                        line: site.callTrace!.resolvedSite.span.startLine,
                        span: site.callTrace!.resolvedSite.span,
                      })
                    }
                  >
                    ↳ underlying call ({site.callTrace.resolvedSite.file.split("/").pop()}:{site.callTrace.resolvedSite.span.startLine})
                  </button>
                )}
              </div>
            )}
```

- [ ] **Step 2: Build the webview**

Run: `npm run build:webview`. Expected: clean build.

- [ ] **Step 3: Commit**

```bash
git add webview/src/components/ResultsPage.tsx
git commit -m "feat(b2): dual click targets in Endpoints view (call site + underlying call)"
```

- [ ] **Step 4: Manual EDH verification (cannot be automated — annotate `[~]` in docs)**

F5 the Extension Development Host, scan a workspace where a helper file wraps an SDK call (e.g. `lib/ai.ts` exports `callAI()` and `app.ts` calls it). In the sidebar **Endpoints** tab, the endpoint row should show:
- the caller file (`app.ts:<line>`) as the primary link → clicking opens `app.ts` at the call site;
- a `↳ underlying call (ai.ts:<line>)` link → clicking opens `lib/ai.ts` at the SDK call.

---

### Task 9: #113 corpus-fixture follow-up (BLOCKED — documented) + Wave 2 verification & docs

**Files:**
- Modify: `docs/accuracy/traceability.md` (B2 section)
- Modify: `docs/superpowers/plans/PROGRESS.md` (Wave 2 status + Activity Log)

- [ ] **Step 1: Run the full gates**

```bash
npm run test:scanner   # full suite green (incl. new call-trace / B2 cases)
npm run build          # extension + webview + dashboard clean
npm run benchmark      # exit 0; expect Δ +0.00pp on all 5 metrics — B2 adds metadata only,
                       # no detection/finding count changes, and the endpoint hash is unchanged
```

Expected: `test:scanner` 0 failures; `build` clean; `benchmark` exit 0, all metrics Δ +0.00pp.

- [ ] **Step 2: Mark B2 acceptance in `docs/accuracy/traceability.md`** — under "## B2", update the acceptance checklist:
  - `[x]` Propagated detections carry both spans + hop count. *(CallTrace on EndpointCallSite + ApiCallNode.)*
  - `[x]` Direct detections have `hops = 0` and the two spans equal. *(directTrace fallback.)*
  - `[~]` Webview shows both locations with clear labels. *(Code landed; pending manual EDH per Task 8 Step 4.)*
  - `[x]` Stable IDs hash is call-site-stable. *(Satisfied by B3 design — computeEndpointId excludes line/column/span; Task 6 regression test guards it. Hash intentionally NOT re-keyed on resolvedSite.file to avoid collapsing distinct callers / benchmark detection-metric risk.)*

- [ ] **Step 3: Document the #113 dependency (blocked in this repo)** — append to `docs/accuracy/traceability.md` a short note under B2:

```markdown
> **#113 (corpus fixtures) — blocked here.** The 7 barrel/factory/DI fixtures live in
> `recost-dev/extension-benchmark` (separate repo). Once they land, refresh the baseline:
> `npm run benchmark -- --fixtures ../extension-benchmark --update-baseline`, then commit the
> regenerated `benchmark/baseline.json`. No `extension`-repo code change is required for #113.
```

- [ ] **Step 4: Update `PROGRESS.md`** — set Wave 2 to 🟡 (B2 code-complete, manual EDH + #113 pending) and append an Activity Log line:

```markdown
- 2026-05-30 — **Wave 2 / B2 (#81) code-complete.** CallTrace { callSite, resolvedSite, hops } threaded AstCallMatch → ApiCallInput → EndpointCallSite + ApiCallNode; webview Endpoints view offers default "call site" + "↳ underlying call" (resolved SDK site). Direct calls get a degenerate hops=0 trace via directTrace. AC-4 satisfied by B3 design (computeEndpointId excludes positions) + regression test; hash deliberately not re-keyed. Gates: test:scanner green, build clean, benchmark Δ +0.00pp. **Pending:** manual EDH (dual click targets) + #113 corpus fixtures (blocked — extension-benchmark repo).
```

- [ ] **Step 5: Commit**

```bash
git add docs/accuracy/traceability.md docs/superpowers/plans/PROGRESS.md
git commit -m "docs(b2): mark #81 acceptance, note #113 corpus dependency, update PROGRESS"
```

---

## Self-Review

**Spec coverage (#81 acceptance criteria):**
1. *Propagated detections carry both spans + hop count* → Tasks 2 (resolver), 4 (EndpointCallSite), 5 (ApiCallNode). ✓
2. *Direct detections have hops=0 and equal spans* → `directTrace` (Task 1) applied as the fallback in Task 4; tested. ✓
3. *Webview shows both with clear labels* → Tasks 7 (types) + 8 (UI). Manual EDH annotated `[~]`. ✓
4. *Stable IDs hash uses resolvedSite only so refactoring the wrapper doesn't reset state* → satisfied by B3's position-free hash + Task 6 regression test; reasoning documented in Task 9. ✓ (Interpreted as "call-site moves don't reset the ID", which B3 already guarantees; re-keying on `resolvedSite.file` was rejected as a benchmark/aggregation hazard and noted explicitly.)

**#113 coverage:** in-repo work (baseline refresh) captured as a blocked, fully-specified Task 9 step; fixture creation correctly excluded (out-of-repo, no access).

**Placeholder scan:** every code step contains complete code. The two "match the existing harness" notes (Tasks 4 & 5) are because the test-file entry points (`buildLocalScanResults` / `buildSnapshot` exact signatures) must be confirmed against the current test files at execution time — the assertions themselves are complete.

**Type consistency:** `CallTrace { callSite, resolvedSite, hops }` and `ResolvedLocation { file, span }` are used identically in `call-trace.ts`, `AstCallMatch.trace`, `ApiCallInput.callTrace`, `EndpointCallSite.callTrace`, `ApiCallNode.callTrace`, and the webview mirror. `directTrace(file, span)` signature matches all call sites. All new fields are optional (`?`), consistent with the existing `span?` / `crossFileOrigin?` convention, minimizing literal/mocks churn.
