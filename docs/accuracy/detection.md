# A. Detection Completeness

The scanner's first job is to find every real API call and refuse to invent fake ones. This doc lists the known gaps and the proposed fixes.

Each section is one tracked GitHub issue. Anchor links are stable — issue bodies link back to them.

---

## A1. Multi-hop wrapper-function tracing

### Problem
Real codebases wrap SDKs 2–3 layers deep:

```ts
// lib/openai.ts
export const ai = new OpenAI();
export function complete(prompt: string) {
  return ai.chat.completions.create({ messages: [...] });
}

// services/chat.ts
import { complete } from "../lib/openai";
export function answerQuestion(q: string) {
  return complete(q);
}

// routes/api.ts
import { answerQuestion } from "../services/chat";
app.post("/q", (req, res) => res.json(answerQuestion(req.body.q)));
```

There are **three** locations a user might want to find this call: `lib/openai.ts:3`, `services/chat.ts:3`, `routes/api.ts:3`. Today the scanner finds the bottom one only, or attributes the middle layer without surfacing the top.

### Current state
`src/ast/cross-file-resolver.ts` performs cross-file resolution. The header comment lists 5 patterns it claims to handle (utility wrappers, class services, middleware, barrel re-exports, callback refs). Hop depth is not documented — believed to be **1 hop**, but needs verification.

### Target behavior
- Walk the wrapper chain until a fixpoint or a depth budget (suggest: **3 hops max**).
- Each intermediate caller becomes a detection site carrying the original provider/method metadata.
- Stop at function boundaries that are themselves called by other wrappers — propagate up.

### Investigation steps
1. Add a test fixture with 3-hop wrapping (`level1 → level2 → level3 → sdk`).
2. Run the existing resolver; assert which levels currently produce findings.
3. Identify where the recursion stops (likely a single-pass loop in `runCrossFileResolution`).
4. Replace with iterative fixpoint until no new propagations occur or depth limit reached.

### Acceptance criteria
- [ ] Test fixture with 3-hop wrapping produces detections at all 3 wrapper sites + the SDK call.
- [ ] Cycle protection: mutual recursion does not infinite-loop.
- [ ] Depth limit configurable; default 3.
- [ ] Existing single-hop tests still pass.
- [ ] Benchmark (D1) shows precision/recall does not regress.

### Files
- `src/ast/cross-file-resolver.ts`
- `src/ast/import-resolver.ts` (for path resolution at each hop)
- New test fixtures under `src/test/fixtures/wrappers/`

---

## A2. Dynamic URL constant-folding for `fetch`/`axios`

### Problem
Calls like:

```ts
const BASE_URL = "https://api.openai.com";
fetch(`${BASE_URL}/v1/chat/completions`, { ... });
```

produce `provider = "unknown"` today because the URL is a template literal, not a string. The user wrote a real OpenAI call; the scanner pretends it doesn't exist (or sends it to the unknown bucket).

### Current state
`src/scanner/patterns/generic-http.ts` extracts URL string arguments. Template literals with interpolations are skipped or returned as the raw template text.

### Target behavior
Constant-fold simple template literals at scan time:
- Module-level `const` strings → substitute their value.
- `process.env.X || "default"` patterns → substitute the default.
- Static string concatenation → join.
- Anything depending on runtime data (`req.params.id`) stays as-is and remains `unknown`.

### Investigation steps
1. Catalog template-literal call patterns in 3–5 real OSS repos (LangChain, Vercel AI starter, a Bedrock demo).
2. Decide on a fold scope: same-file only (simpler) vs cross-file via the import resolver (more powerful, more risk).
3. Start with same-file `const STRING = "..."` substitution — covers ~70% of cases.

### Acceptance criteria
- [ ] `fetch(\`${BASE}/path\`)` where `BASE` is a same-file string `const` resolves to a static URL.
- [ ] `provider` attribution succeeds when the folded URL matches a host in `endpoint-classification.ts`.
- [ ] Template literals with non-constant interpolations remain `unknown` (no false positives).
- [ ] No regression on plain string URL detection.

### Files
- `src/scanner/patterns/generic-http.ts`
- New helper `src/scanner/constant-fold.ts` or inline in the scanner

---

## A3. Barrel-file / re-export resolution audit

### Problem
Many TS projects use barrel files (`index.ts` that re-exports from siblings). Import resolution has to follow the re-export chain:

```ts
// lib/clients/openai.ts
export const client = new OpenAI();

// lib/clients/index.ts
export * from "./openai";

// services/chat.ts
import { client } from "../lib/clients";  // ← scanner must reach openai.ts
```

### Current state
`src/ast/cross-file-resolver.ts` header comment lists "barrel re-exports" as pattern #4 that it handles. **This needs verification.** It's not clear if `export *` is supported, only `export { x } from "./y"`, only default re-exports, or all of the above.

### Investigation steps
1. Build a fixture matrix:
   - `export * from "./mod"`
   - `export { x } from "./mod"`
   - `export { x as y } from "./mod"`
   - `export { default } from "./mod"`
   - Nested barrels (barrel re-exports another barrel)
   - Mixed barrels (barrel re-exports + local symbols)
2. Run the resolver against each. Document which work and which don't.
3. Fix the gaps.

### Acceptance criteria
- [ ] All five fixture patterns above resolve correctly.
- [ ] Nested barrels (2 levels) resolve.
- [ ] An import that ultimately points to a non-existent symbol fails gracefully (no crash, just no detection).
- [ ] Performance: nested barrel resolution does not blow up scan time on a 1000-file repo.

### Files
- `src/ast/import-resolver.ts`
- `src/ast/cross-file-resolver.ts`
- New fixtures under `src/test/fixtures/barrels/`

### Status (2026-05-14)
Implemented on branch `claude/a3-a5-resolver-recall`. Fixtures live under `src/test/fixtures/a3-a5/barrel-*`; behavioral coverage in `src/test/a3-barrel-reexports.test.ts`. Resolved shapes: direct (`export { x } from`), aliased (`export { x as y } from`), wildcard (`export * from`), nested barrels (2+ levels, depth-capped), and `export { default } from`. Missing-symbol re-exports fail gracefully (no throw). Perf: synthetic 1001-file barrel chain scanned in ~0.3s — well under the 30s ceiling.

---

## A4. AST ↔ regex parity audit

✅ **Landed: 2026-05-12** — see [issue #76](https://github.com/recost-dev/extension/issues/76). Parity runner lives at `src/test/parity.ts`, test entry at `src/test/parity.test.ts`, intentional-divergence allowlist at `docs/accuracy/PARITY.md`. Wired into `test:scanner` in `package.json` and runs in CI via `.github/workflows/test.yml`. First audit surfaced one regex bug (now fixed: `generic-http.ts` now does host-based provider attribution + drops the wrong-method GET fallback for multi-line fetch) and two structural multi-line cases (documented as `astOnly` in the allowlist).

### Problem
The scanner has two detection paths for JS/TS/Python:
- AST scanner (`src/ast/ast-scanner.ts`)
- Regex pattern scanners (`src/scanner/patterns/*`)

For any call both paths can see, do they:
1. Detect it at all (or does one miss it)?
2. Report the same provider, method, and line number?

Currently there's no answer to either question. Silent disagreements mean either the AST is missing things the regex catches (or vice versa), or click-back jumps to the wrong line after a refactor.

### Target behavior
- A test that runs both paths against a shared fixture corpus and asserts they agree on `(provider, method, line)` for every call both detect.
- A documented list of cases where divergence is intentional (regex catches Go/Java/Ruby calls AST does not; AST catches wrapper chains regex cannot).
- The list is short, written down, and enforced.

### Investigation steps
1. Build a parity-test runner: for each fixture file, run both scanners, normalize their output, diff.
2. Categorize divergences: AST-only, regex-only, both-but-different-line, both-but-different-provider.
3. For each category, decide: is this a regex bug, an AST bug, or an intentional design choice?
4. Fix bugs; document intentional divergences in a `PARITY.md` table; gate the test in CI.

### Acceptance criteria
- [x] Parity test runs in CI on every PR.
- [x] Every divergence the test produces is either fixed or annotated in `PARITY.md`.
- [x] Same `line` reported by both paths for every JS/TS/Python file where both detect a call.

### Files
- New: `src/test/parity.test.ts`
- New: `docs/accuracy/PARITY.md` (or inline in `detection.md`)
- Likely fixes in `src/scanner/patterns/*` and/or `src/ast/call-visitor.ts`

---

## A5. Aliased / DI / factory client tracking

### Problem
Patterns that escape simple variable-to-import resolution:

```ts
// Aliased
const ai = new OpenAI();
const create = ai.chat.completions.create.bind(ai);
await create({ ... });  // ← scanner sees `create()`, doesn't know it's OpenAI

// Factory
function makeClient() { return new OpenAI(); }
const ai = makeClient();
await ai.chat.completions.create({ ... });  // ← scanner sees `ai.chat...`, may or may not resolve `ai`

// DI (Spring-style)
class Service {
  constructor(private ai: OpenAI) {}
  ask(q: string) { return this.ai.chat.completions.create({ ... }); }
}
```

### Current state
The first pattern (`.bind`) is almost certainly missed today. The factory pattern depends on whether `import-resolver` follows the return type. DI works if the constructor parameter type is annotated and the resolver reads type annotations.

### Investigation steps
1. Build fixtures for each pattern above.
2. Run the AST scanner; document which resolve correctly.
3. For `.bind` / aliased method references: track the method-reference assignment and propagate provider/method metadata to its call sites.
4. For factory returns: when a local variable is assigned the return of a function that itself returns `new OpenAI()`, propagate.
5. For DI: read constructor parameter type annotations as a provider hint.

### Acceptance criteria
- [ ] All three patterns above produce detections with correct provider/method.
- [ ] No regression on simple `const ai = new OpenAI()` cases.
- [ ] Each new tracked pattern has a fixture + test.

### Status (2026-05-14)
Implemented on branch `claude/a3-a5-resolver-recall`. Fixtures under `src/test/fixtures/a5/`; coverage in `src/test/a5-factory-di-aliased.test.ts`. Landed:
- `.bind()`-aliased method refs — already resolved by the existing scanner (audit confirms the member-access inside `.bind()` is detected).
- Factory return inference — `function makeClient(): X { return new X(); }` plus `const c = makeClient()` is tracked both in-file (per-file `factoryReturnMap` populates `varMap`) and cross-file (post-fixpoint pass synthesises matches for callers in other files).
- DI typed constructor params — `constructor(private readonly ai: OpenAI)` now populates a `thisFieldMap` so `this.ai.<chain>` resolves to the param's declared SDK type.
- Regression test confirms simple `const c = new X()` still resolves.
- Benchmark gate: detection recall +2.94pp, detection precision −0.91pp (within 1pp tolerance); finding precision/recall unchanged.

### Files
- `src/ast/import-resolver.ts`
- `src/ast/call-visitor.ts`
- New fixtures under `src/test/fixtures/aliasing/`

---

## A6. Filter object-literal false positives in AST scanner

(Reformulated from old issue #66.)

### Problem
The AST call visitor emits matches when a method-chain string appears anywhere in the AST — including as a string key in an object literal:

```ts
// pricing.ts — DATA, not a call
const METHOD_PRICING = {
  openai: {
    "chat.completions.create": { costModel: "per_token" }
  }
};
```

This is detected as an API call today, producing false positives in pricing/config files. The current workaround is a filename-based exclude list in `src/scanner/file-discovery.ts:48-59` (`pricing.ts`, `costs.ts`, `api-config.ts`, etc.) — which can silently suppress *real* calls in any file that happens to use those names.

### Target behavior
Walk parent nodes of every match. Emit only when the match is inside a `call_expression` (or `method_invocation` in other grammars). Skip when ancestor is `object`, `array`, `variable_declarator`, or `assignment_expression`.

### Implementation sketch
```ts
function isInsideCallExpression(node: SyntaxNode): boolean {
  let current = node.parent;
  while (current) {
    if (current.type === "call_expression") return true;
    if (current.type === "object" || current.type === "array" ||
        current.type === "variable_declarator" ||
        current.type === "assignment_expression") return false;
    current = current.parent;
  }
  return false;
}
```

### Workaround removal (must ship in the same PR)
Remove from `DEFAULT_IGNORE_PATTERNS` in `src/scanner/file-discovery.ts`:
- `**/pricing.{ts,js,tsx}`
- `**/costs.{ts,js}`
- `**/rates.{ts,js}`
- `**/api-config.{ts,js}`
- `**/provider-config.{ts,js}`
- `**/api-pricing.{ts,js}`

Remove `api/src/config/pricing.ts` from `.recostignore` unless confirmed data-only.

### Acceptance criteria
- [ ] `pricing.ts` fixture with method-chain string keys produces zero findings.
- [ ] Real call in `service.ts` to the same method still detected.
- [ ] All filename-based workaround patterns removed.
- [ ] Existing fingerprint registry tests still pass.
- [ ] Benchmark (D1) precision improves measurably.

### Files
- `src/ast/call-visitor.ts`
- `src/ast/ast-scanner.ts` (any other emission sites)
- `src/scanner/file-discovery.ts`
- `.recostignore`

---

## A7. URL-path → method fallback for raw `fetch`

(Reformulated from old issue #72.)

### Problem
Raw `fetch("https://api.elevenlabs.io/v1/text-to-speech/...")` produces:
- `provider = "elevenlabs"` ✓
- `methodSignature = undefined` ✗ (no SDK chain to extract)

Without `methodSignature`, the fingerprint registry lookup never runs, `costModel` stays `undefined`, and the call falls through to `"unknown"` classification with a stub $0.0001 cost.

### Target behavior
When `provider` is set but `methodSignature` is `undefined`, attempt to match the URL path against the method keys in the provider's fingerprint entry. Use a `_default` fallback per provider for unrecognized paths.

### Implementation sketch
In the analysis layer (server + extension `estimateLocalMonthlyCost`):

```ts
if (!costModel && provider && METHOD_PRICING[provider]) {
  const providerMethods = METHOD_PRICING[provider];
  const matchedKey = Object.keys(providerMethods).find(key => url.includes(key));
  const matched = providerMethods[matchedKey ?? "_default"] ?? providerMethods["_default"];
  if (matched) { costModel = matched.costModel; perCallCost = matched.perRequestCostUsd; }
}
```

### Fingerprint changes
Add URL-path method keys for providers commonly called via raw fetch:
- ElevenLabs: `v1/text-to-speech`, `v1/speech-to-text`, `v1/sound-generation`, `v1/voice-changer`, `_default`
- (Extend pattern to other providers identified by the benchmark D1.)

### Acceptance criteria
- [ ] Raw `fetch("https://api.elevenlabs.io/v1/text-to-speech/...")` resolves to a non-stub cost.
- [ ] Provider not in the URL-path table still falls back gracefully without crashing.
- [ ] Fingerprint JSON schema accepts URL-path-style keys alongside SDK-chain keys.

### Files
- `src/scanner/fingerprints/elevenlabs.json` (and others identified by benchmark)
- `src/scanner/scan-results.ts` (or wherever `costModel` resolution lives)
- `src/intelligence/cost-utils.ts`

---
