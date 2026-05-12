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
- [ ] Propagated detections carry both spans + hop count.
- [ ] Direct (non-propagated) detections have `hops = 0` and the two spans equal.
- [ ] Webview shows both locations with clear labels.
- [ ] Stable IDs (B3) hash includes only one of the two spans (suggest: `resolvedSite`) so refactors that move the call site don't reset state.

### Files
- `src/ast/cross-file-resolver.ts`
- `src/intelligence/types.ts`
- `webview/src/components/ResultsPage.tsx`

### Depends on
- B1 (spans must exist first).
- A1 (wrapper depth — once hops can be >1, this becomes more useful).

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

### Investigation steps
1. Add an enclosing-function-name extractor in `call-visitor.ts` (walk parent nodes for `function_declaration`, `method_definition`, `arrow_function` parent var name).
2. Add `maskUrlDynamicParts(url)` in a util module — replaces numeric segments, UUIDs, and known ID patterns with `:id`.
3. Wire into a single `computeEndpointId()` function. Use it in `EndpointRecord` construction.
4. Migration: existing persisted state keyed by old IDs needs a fallback — log warning, ignore the old state, write new IDs on next scan.

### Acceptance criteria
- [ ] Endpoint IDs survive moving a call ±20 lines in the same file.
- [ ] Endpoint IDs survive renaming a containing variable but not the function.
- [ ] Two distinct calls to `openai.chat.completions.create` in the same file but different functions get distinct IDs.
- [ ] `/api/users/123` and `/api/users/456` get the same ID.
- [ ] Saved simulator scenarios and suppressed findings survive a scan after non-structural code changes.

### Files
- New: `src/ast/enclosing-function.ts`
- New: `src/scanner/url-template.ts`
- `src/scanner/types.ts` (EndpointRecord id field)
- Wherever endpoint IDs are currently generated (search for `id:` in scan-results / webview-provider)

### Depends on
- B1 (spans help identify the enclosing function reliably).

---
