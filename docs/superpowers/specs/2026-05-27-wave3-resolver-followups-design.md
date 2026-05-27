# Wave 3 — Resolver Follow-ups Design

**Date:** 2026-05-27
**Closes:** #114, #115, #116
**Wave label:** `wave/3-resolver-followups`
**Area:** `area/detection`
**PR shape:** one bundled PR

## Goal

Three precision/recall follow-ups left behind by PR #110 (A3 barrels + A5 factories), all in the cross-file resolver and the AST waste detectors:

1. **#114** — `resolveExportedMatches` cannot tell a default import from a named one, so a named import can wrongly inherit the provider of a sibling `export { default } from "./x"` re-export in a heterogeneous barrel.
2. **#115** — `extractFactoryCallAssignments` matches only no-arg factory calls (`makeClient()`); `makeClient(config)` and friends silently fail to resolve.
3. **#116** — `openai.images.generate` carries `batchCapable: true`, which conflates a true batch endpoint with DALL·E's inline `n`/count parameter. In a generic loop/fan-out this makes the batch detector emit the wrong guidance ("use the batch endpoint").

These ship together because #114 and #115 live in the same file (`src/ast/cross-file-resolver.ts`) and #116 unblocks Wave 4 (#117); a single benchmark run covers all three.

## Non-goals

- **Wave 4 / #117** (recovering the two C1 false negatives) depends on #116's flag but is a separate PR.
- **No `baseline.json` refresh** unless the benchmark gate demands it. These patterns are not yet exercised by the D1 corpus (that is Wave 2 / #113), so a measurable recall delta is not expected here.
- **No conversion of the factory post-pass to AST.** The post-pass operates on raw source text by design; #115 stays a regex change consistent with that surface.
- **No new wrapper-chain depth or cycle changes.** Only the default-vs-named filter logic in `resolveExportedMatches` changes.

## Architecture

All three changes are localized:

- **#114, #115** — `src/ast/cross-file-resolver.ts` only (plus fixtures + tests).
- **#116** — a new optional fingerprint flag threaded through the type definitions and the AST scanner, one fingerprint JSON edit, and the two waste detectors (plus fixtures + tests).

No interface in `src/intelligence/types.ts` changes. No IPC message changes.

---

## Section A — #114: default-vs-named disambiguation

### Root cause

`extractRelativeImports` (`cross-file-resolver.ts:187`) parses both default imports (`import D from "./p"`, line 215–218) and named imports (`import { A, B as C } from "./p"`, line 197–212), but emits both as `{ localName, specifier }` — the import *kind* is discarded.

Downstream, `resolveExportedMatches` (line 359) receives only `name` (the local name). Its re-export filter at line 393:

```ts
if (re.exportedName !== null && re.exportedName !== name && re.exportedName !== "default") continue;
```

The `re.exportedName !== "default"` clause means **any** lookup — including a named import — will follow a `export { default } from "./x"` re-export and look up `"default"` in `x`. If `x`'s default export is, say, an OpenAI client, a named import like `ask` wrongly inherits OpenAI as its provider when the barrel mixes shapes.

### Change

1. Add `isDefault: boolean` to the `ImportedName` interface (line 178). Set `true` in the default-import branch, `false` in the named-import branch of `extractRelativeImports`.
2. Add an `isDefault` parameter to `resolveExportedMatches`. Pass it from both call sites:
   - Regular import propagation (line 561): pass the import entry's `isDefault`.
   - Middleware propagation (line 608): middleware names are always named imports → pass `false`.
3. Replace the single-line filter with an explicit per-binding split:

```ts
for (const re of reExports) {
  let follow = false;
  let nextName = name;
  let nextIsDefault = false;
  if (isDefault) {
    // A default binding flows ONLY through `export { default } from "./x"`.
    if (re.exportedName === "default") { follow = true; nextName = "default"; nextIsDefault = true; }
  } else {
    // A named binding flows through wildcards and name-matching named re-exports,
    // NEVER through `export { default }`.
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

4. **Verify the direct-lookup path** (line 376, `fileExports.get(name)`): a default import's `name` is the consumer's local alias, but the export registry may key the default export under `"default"`. The mixed-barrel fixture must include a *direct* default import of an `export default` declaration to confirm this resolves; if it does not, map `name → "default"` for direct lookups when `isDefault` is true. (Confirm during implementation; do not pre-emptively change without a failing fixture.)

### Tests

- Fixtures under `src/test/fixtures/a3-followup/`:
  - `barrel.ts`: `export { default } from "./a"` (a.ts default-exports an OpenAI client) **mixed with** `export { ask } from "./b"` (b.ts makes a different-provider call).
  - `consumer.ts`: `import client, { ask } from "./barrel"; client.chat...; ask(...)`.
- `src/test/a3-default-import-threading.test.ts`:
  - `client.chat.*` resolves to OpenAI; `ask(...)` resolves to b.ts's provider — **not** OpenAI.
  - Regression: re-run the 5 PR #110 barrel shapes (`src/test/a3-barrel-reexports.test.ts` fixtures) — all still resolve.

---

## Section B — #115: factory-with-arguments

### Change

In `extractFactoryCallAssignments` (line 670), widen the trailing argument group:

```diff
- const RE = /(?:const|let|var)\s+(\w+)\s*=\s*(\w+)\s*(?:<[^>]*>)?\s*\(\s*\)/gm;
+ const RE = /(?:const|let|var)\s+(\w+)\s*=\s*(\w+)\s*(?:<[^>]*>)?\s*\(\s*[^)]*\)/gm;
```

The `(\w+)` capture groups for var name and factory-fn name precede the argument list, so they are unaffected. `[^)]*` (no `s` flag needed — a negated class matches newlines) covers single-level args and multi-line arg lists. Deeply nested-paren args (`makeClient(getConfig())`) still match because the regex only needs to find the opening `(` plus the captured names; the trailing unmatched `)` is harmless. Degrades to no-detection (never a false positive) for anything it cannot match.

### Tests

- Fixtures demonstrating: zero-arg (`makeClient()`), single-arg (`makeClient(config)`), object-arg (`makeClient({ apiKey: process.env.KEY })`), multi-arg (`makeClient(env, options)`), and multi-line args.
- Test asserting each variant resolves to the factory's `factoryReturnMap` provider.
- Regression: PR #110's zero-arg factory test still passes.

---

## Section C — #116: `inlineParallelCapable` flag

### Flag plumbing

Add `inlineParallelCapable?: boolean` to:
- `src/scanner/fingerprints/types.ts` (alongside `batchCapable`, line 40).
- `src/analysis/types.ts` — both shapes that carry `batchCapable` (the AST-match shape ~line 19 and the endpoint shape ~line 58).
- The `AstCallMatch` interface in `src/ast/ast-scanner.ts` (~line 58).
- Propagate from fingerprint → match at the three sites in `ast-scanner.ts` (~660, ~802, ~826) that already copy `batchCapable`/`cacheCapable`/`streaming`.

### Fingerprint

`src/scanner/fingerprints/openai.json`, `images.generate` (line 52–58): remove `"batchCapable": true`, add `"inlineParallelCapable": true`.

### Detectors

**`src/ast/waste/concurrency-detector.ts:152`** — preserve PR #110's fan-out suppression for inline-parallel endpoints:

```diff
- if (match.batchCapable === true) return null; // let batch detector handle it
+ if (match.batchCapable === true || match.inlineParallelCapable === true) return null;
```

**`src/ast/waste/batch-detector.ts`** — stop the wrong text and route inline-parallel separately:
- `detectBatch` (line 105): `if (!match.batchCapable) return null;` stays as-is. With `batchCapable` removed from `images.generate`, this detector no longer fires the "use the batch endpoint" text for it. (The existing `BOUNDED_REPLICATION` guard at line 109 continues to protect true batch APIs in the `Array.from({length:N})` idiom.)
- `detectNPlusOne` (line 162): `if (match.batchCapable) return null;` → `if (match.batchCapable || match.inlineParallelCapable) return null;`, so inline-parallel endpoints in a bounded/unbounded loop don't fall through to the N+1 finding.
- **New** `detectInlineParallel`: fires for `match.inlineParallelCapable` in the same loop/parallel frequency contexts as `detectBatch`, applying the same `isRealProviderMatch`, guard-window, and `BOUNDED_REPLICATION` checks. Emits:
  - `type: "batch"` (reuses the existing suggestion type; acceptance only requires the **text** to differ),
  - id prefix `local-inline_parallel-`,
  - description: *"This endpoint accepts an `n`/count parameter — request multiple results in a single call instead of issuing one request per item."*
- Register `detectInlineParallel` in the detector's exported finding list alongside `detectBatch`/`detectNPlusOne`.

### Tests

- `images.generate` inside a generic `items.map(() => images.generate(...))` (no `Array.from` idiom) → one finding with the inline-parallel text; **no** "batch endpoint" text; **no** `concurrency_control` finding.
- A real batch API (`embeddings.create`, still `batchCapable`) in the same shape → the existing "consolidate into a single batch request" text, unchanged.
- The `Array.from({ length: n }).map(() => images.generate(...))` idiom → still fully suppressed (no finding).

---

## Verification gates

1. `npm run test:scanner` — all new + existing tests pass, including the AST↔regex parity suite (#76) and the PR #110 regression fixtures (`a3-barrel-reexports`, `a5-factory-di-aliased`). **Gotcha:** `test:scanner` runs an *explicit list* of compiled `dist-test/...` files, not a glob — each new test file (`a3-default-import-threading`, the factory-args test, the #116 detector test) must be added to that chain in `package.json` and compiled via `tsconfig.scanner-tests.json`, or it silently never runs.
2. `npm run build:ext` — clean TypeScript build (new optional field is additive, no breaking type changes).
3. Benchmark gate (`benchmark.yml` → `benchmark/runner.ts`, fails on >1pp drop): **no regression.** `detectionRecall ≥ 51.47%`, `detectionPrecision` within the 1pp threshold, finding precision/recall by type unchanged. The corpus does not yet exercise barrel/factory patterns (Wave 2 / #113), so a positive delta is not expected — the gate is a no-regression guard here, and in-repo unit tests are the correctness proof.

## Files touched

- `src/ast/cross-file-resolver.ts` — #114 (`ImportedName`, `extractRelativeImports`, `resolveExportedMatches` signature + filter) and #115 (`extractFactoryCallAssignments` regex).
- `src/scanner/fingerprints/types.ts`, `src/analysis/types.ts`, `src/ast/ast-scanner.ts` — #116 flag definition + propagation.
- `src/scanner/fingerprints/openai.json` — #116 `images.generate` reclassification.
- `src/ast/waste/concurrency-detector.ts`, `src/ast/waste/batch-detector.ts` — #116 detector logic + new `detectInlineParallel`.
- New: `src/test/fixtures/a3-followup/*`, `src/test/a3-default-import-threading.test.ts`, factory-args fixtures + test, #116 detector test.
