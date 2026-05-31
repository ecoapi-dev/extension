# B. Traceability

Once a call is detected, the user needs to click on it and land on the right line. This is harder than it sounds because (a) the scanner has two paths that don't always agree on line numbers, (b) cross-file resolved calls have two valid "homes," and (c) endpoint IDs reset on every scan, breaking any state we save against them.

---

## B1. Span-based source locations (not just line numbers)

### Problem
Each detection currently carries a `line` (1-based int). That's enough to scroll the editor to roughly the right spot, but:
- It can't highlight the *call expression itself* — only the line.
- Multi-line calls (very common in Java/TS builder patterns) only get the first line.
- Tools like the dashboard Graph view can't draw a precise marker over the call.
- When the AST and regex disagree on which line a call is on (see A4), there's no way to assert "the call expression spans lines 12–18, AST says 12, regex says 14, they actually agree on the same call."

The recent commit `a7aaa34 fix: accurate line finding` confirms this has been brittle.

### Target behavior
Every detection carries a full source span:

```ts
interface SourceSpan {
  file: string;
  startLine: number;    // 1-based
  startColumn: number;  // 0-based
  endLine: number;
  endColumn: number;
}
```

### ~~Investigation steps~~ (resolved — see implementation plan `docs/superpowers/plans/2026-05-12-b1-span-based-source-locations.md`)
1. ~~Tree-sitter nodes already expose `startPosition` / `endPosition`. Wire them through `AstCallMatch`.~~ Done in T3/T4.
2. ~~Regex pattern scanners need a way to compute end position — easiest: re-scan with a more permissive regex that captures the full call expression, or use the source text + a balanced-paren walker.~~ Shipped with line-wide span as the documented compromise (T7); tight regex spans require a `matchLine` API change tracked as future work.
3. ~~Update `EndpointRecord` / `ApiCallNode` to carry a span field; keep `line` as a derived shortcut for back-compat.~~ `EndpointCallSite.span?` (T6/T9) and `ApiCallNode.span` (T8) both populated; `line` preserved alongside.
4. ~~Update the webview Endpoints + Graph views to highlight the span, not just the line.~~ Reveal-by-span landed in `webview-provider`'s `openFile` handler and `ResultsPage` (T10).

### Acceptance criteria
- [x] `EndpointRecord` exposes `span: SourceSpan` with all four numbers populated. *(via `EndpointCallSite.span?` — optional only because legacy/synthetic inputs may omit it.)*
- [x] Multi-line calls (>3 lines) have `endLine > startLine`. *(AST path — verified by `src/test/ast-call-visitor.test.ts` "span: multi-line call has endLine > startLine".)*
- [ ] Clicking a detection in the webview opens the editor with the span selected, not just the line scrolled into view. *(Code landed in T10 commit `69ca79d`; **pending manual EDH verification** — F5 the dev host, scan a workspace with a multi-line OpenAI call, click the endpoint row, confirm full-call selection.)*
- [x] Existing tests assertions on `line` continue to work (derive from span). *(`line` is preserved alongside `span` everywhere; all affected unit tests pass.)*

### Files
- `src/ast/call-visitor.ts`
- `src/ast/ast-scanner.ts`
- `src/scanner/patterns/*` (each pattern emits spans)
- `src/scanner/types.ts` (or wherever `EndpointRecord` is defined)
- `src/intelligence/types.ts` (ApiCallNode)
- `webview/src/components/ResultsPage.tsx` (open-file IPC)

✅ Landed: 2026-05-12 on branch `foundation-parser-accuracy`. Acceptance criteria 1, 2, 4 automated-verified; #3 awaiting manual EDH check.

---

## B2. Dual locations for cross-file resolved calls

### Problem
When `cross-file-resolver` propagates a call from a helper file up to its callers, today only one location is surfaced. The user has no way to know:
- The call site they wrote (`services/chat.ts:42`), or
- The underlying SDK invocation (`lib/openai.ts:18`).

Clicking either is sometimes the right answer:
- For "where did I add this feature" → the call site.
- For "where does my OpenAI usage actually happen" → the SDK location.

### Target behavior
Every propagated detection exposes both:

```ts
interface PropagatedLocation {
  callSite: SourceSpan;       // where the user's code calls the wrapper
  resolvedSite: SourceSpan;   // where the wrapper makes the SDK call
  hops: number;               // 0 = direct call, ≥1 = propagated
}
```

The UI offers both as click targets. Default click lands on `callSite` (where the user worked); a "Show underlying call" affordance jumps to `resolvedSite`.

### Acceptance criteria
- [x] Propagated detections carry both spans + hop count. *(`CallTrace { callSite, resolvedSite, hops }` on `AstCallMatch.trace` → `ApiCallInput.callTrace` → `EndpointCallSite.callTrace` + `ApiCallNode.callTrace`.)*
- [x] Direct (non-propagated) detections have `hops = 0` and the two spans equal. *(`directTrace()` fallback applied at the three call-site construction sites in `scan-results.ts`.)*
- [~] Webview shows both locations with clear labels. *(Code landed: `ResultsPage.tsx` Endpoints view shows the call site by default plus a "↳ underlying call" link when `hops > 0`. **Pending manual EDH verification** — F5 the dev host, scan a workspace where a helper wraps an SDK call, confirm both links navigate correctly.)*
- [x] Stable IDs hash is call-site-stable. *(Satisfied by B3 design — `computeEndpointId` excludes line/column/span, so moving a call site cannot reset the ID; locked in by `endpoint-id.test.ts` "B2/AC-4". The hash is intentionally **not** re-keyed on `resolvedSite.file`: doing so would collapse distinct callers into one endpoint and risk a benchmark detection-metric regression.)*

> **#113 (corpus fixtures) — blocked here.** The 7 barrel/factory/DI fixtures live in
> `recost-dev/extension-benchmark` (separate repo). Once they land, refresh the baseline:
> `npm run benchmark -- --fixtures ../extension-benchmark --update-baseline`, then commit the
> regenerated `benchmark/baseline.json`. No `extension`-repo code change is required for #113.

### Files
- `src/scanner/call-trace.ts` (new — `CallTrace`/`ResolvedLocation`/`directTrace`)
- `src/ast/ast-scanner.ts` (`AstCallMatch.trace`)
- `src/ast/cross-file-resolver.ts`
- `src/analysis/types.ts` (`ApiCallInput.callTrace`, `EndpointCallSite.callTrace`)
- `src/scanner/core-scanner.ts`, `src/scan-results.ts`
- `src/intelligence/types.ts` (`ApiCallNode.callTrace`), `src/intelligence/builder.ts`
- `webview/src/types.ts`, `webview/src/components/ResultsPage.tsx`

### Depends on
- B1 (spans must exist first). *(Landed.)*
- A1 (wrapper depth — once hops can be >1, this becomes more useful).

✅ Landed: 2026-05-30 on branch `claude/recent-pr-explanation-C7Xcw`. Acceptance criteria 1, 2, 4 automated-verified (`npm run test:scanner` green incl. 7 new B2 cases; `npm run build` clean); #3 awaits manual EDH check. Benchmark gate runs in CI only (fixtures repo not accessible locally); Δ expected +0.00pp — B2 is additive metadata and changes no detection/inclusion/finding logic.

---

## B3. Stable endpoint IDs across scans

### Problem
If endpoints get a fresh ID every scan:
- Saved suppressions break ("I dismissed this finding" → it comes back on next scan).
- Scenario simulator inputs tied to specific endpoints reset.
- Findings tied to endpoints can't be persisted in any meaningful way.

Today's IDs are likely line-number-based or array-index-based — both break on every code change.

### Target behavior
Endpoint IDs are deterministic hashes of *structural* properties, not transient ones:

```ts
function endpointId(call: EndpointRecord): string {
  return hash(JSON.stringify({
    provider: call.provider,
    methodSignature: call.methodSignature,
    filePathNormalized: normalizeRepoPath(call.filePath),
    enclosingFunction: call.enclosingFunctionName,  // requires AST extraction
    urlTemplate: call.url ? maskUrlDynamicParts(call.url) : null,
  }));
}
```

Key properties:
- **No line numbers** — refactors that move code around don't reset IDs.
- **Includes enclosing function name** — disambiguates two calls to the same method in the same file.
- **URL templates masked** — `/users/123` and `/users/456` get the same ID (mask numeric IDs, UUIDs, etc.).

### ~~Investigation steps~~ (resolved — see implementation plan `docs/superpowers/plans/2026-05-12-b3-stable-endpoint-ids.md`)
1. ~~Add an enclosing-function-name extractor in `call-visitor.ts` (walk parent nodes for `function_declaration`, `method_definition`, `arrow_function` parent var name).~~ Done in T2 (new module `src/ast/enclosing-function.ts`, used by both `endpoint-id.ts` and `ast-scanner.ts`).
2. ~~Add `maskUrlDynamicParts(url)` in a util module — replaces numeric segments, UUIDs, and known ID patterns with `:id`.~~ Done in T1 (`src/scanner/url-template.ts`).
3. ~~Wire into a single `computeEndpointId()` function. Use it in `EndpointRecord` construction.~~ Done in T3/T5/T6: `src/scanner/endpoint-id.ts` is the canonical hasher; `intelligence/builder.ts` and `scan-results.ts` both consume it; `webview-provider.ts`'s parallel synthetic-ID minter was migrated alongside (T7 scope expansion).
4. ~~Migration: existing persisted state keyed by old IDs needs a fallback — log warning, ignore the old state, write new IDs on next scan.~~ Done in T7: `pruneSavedScenariosAgainst` drops saved simulator scenarios whose referenced endpoint IDs are absent from the current scan and persists the cleaned list to `recost.simulatorScenarios`. Includes a zero-endpoint guard to avoid wiping all scenarios on misconfigured/empty scans.

### Acceptance criteria
- [x] Endpoint IDs survive moving a call ±20 lines in the same file. *(T3 + T8: `computeEndpointId` has no `line`/`column`/`span` input; verified by tests "ID survives ±20 line move" and "end-to-end: same call, moved 20 lines, gets the same ID".)*
- [x] Endpoint IDs survive renaming a containing variable but not the function. *(T3 test "ID survives renaming an unrelated containing variable"; T3 test "ID changes when enclosing function changes".)*
- [x] Two distinct calls to `openai.chat.completions.create` in the same file but different functions get distinct IDs. *(T8 test "end-to-end: two calls in same file but different functions diverge"; supported by collision-disambiguation fallback `_L<line>` in `builder.ts` for same-function same-URL repeats.)*
- [x] `/api/users/123` and `/api/users/456` get the same ID. *(T1 url-template masks numeric segments to `:id`; T3 test "URLs differing only by numeric ID produce the same endpoint ID".)*
- [~] Saved simulator scenarios and suppressed findings survive a scan after non-structural code changes. *(Code path verified: stable IDs mean a re-scan after non-structural change produces the same IDs, so `pruneSavedScenariosAgainst` keeps scenarios. T7 Step 4 — F5 EDH, save a scenario, edit an unrelated file, re-scan, confirm scenario still loads — is **pending manual verification**.)*

### Files
- New: `src/ast/enclosing-function.ts`
- New: `src/scanner/url-template.ts`
- New: `src/scanner/endpoint-id.ts` (+ test)
- Modified: `src/analysis/types.ts` (`ApiCallInput.enclosingFunction?`), `src/ast/ast-scanner.ts` (emit `enclosingFunction` on every match), `src/scanner/core-scanner.ts` (pipe through), `src/intelligence/builder.ts` (use `computeEndpointId` + `_L<line>` collision fallback), `src/scan-results.ts` (use `computeEndpointId` + Set-based collision check), `src/webview-provider.ts` (parallel synthetic-ID migration + `pruneSavedScenariosAgainst`).

### Depends on
- B1 (spans help identify the enclosing function reliably). *(B1 landed first; B3's `enclosingFunctionName` walker uses `node.parent` so the dependency is documentary, not blocking.)*

✅ Landed: 2026-05-12 on branch `foundation-parser-accuracy`. Acceptance criteria 1–4 automated-verified across `src/test/url-template.test.ts`, `src/test/enclosing-function.test.ts`, and `src/test/endpoint-id.test.ts` (13 cases). Criterion #5 is code-complete but awaits manual EDH verification per T7 Step 4.

---
