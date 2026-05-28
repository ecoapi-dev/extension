# Wave 1 — Findings Quality Implementation Plan (#84, #85, #112)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make surfaced findings honest and prioritized — derive severity from cost + structural signals (#85), collapse duplicate AI/local findings while recording every source that detected them (#84), and stop the `CACHE_GUARD`/`BATCH_GUARD` literal-word leak that suppresses real cache/batch findings (#112).

**Architecture:** Three coupled changes shipped in one PR on `claude/superpowers-plugins-skills-1Yaij`. They share one seam: the `Suggestion` pipeline (the user-facing finding type), not the `FindingNode` intelligence graph the spec idealizes. Severity becomes *derived* at one place — `deriveSeverity()` in `scan-results.ts` — combining the detector's existing structural `riskScore` (a **floor**, preserving C1's calibrated precision) with a confidence-weighted `costImpactUsd` **amplifier** (escalates expensive endpoints, satisfies "different cost → different severity"). Because severity reassignment never adds or removes findings, the per-type precision benchmark gate is unaffected; because cost can only escalate above the structural floor, C1's severity calibration can't regress. Dedupe collapses findings by a structural key (`type | file | endpoint/line-bucket`), unioning `sources` and taking `max()` confidence. `costImpactUsd` stays internal (drives severity + ordering); it is never rendered.

**Tech Stack:** TypeScript (strict), esbuild, React 18 webview. Tests are plain `node:assert/strict` files compiled by `tsc -p tsconfig.scanner-tests.json` into `dist-test/` and run via the `test:scanner` npm script chain. Benchmark gate: `npm run benchmark` (per-type finding precision/recall against `benchmark/baseline.json`).

**Spec mapping (important — read before starting):**
- Spec `docs/accuracy/findings.md` C2/C3 references `FindingNode`, `finding-dedupe.ts`, `endpointId`, `lineRange`. The findings users see are `Suggestion[]` (built in `scan-results.ts` + `chat-handler.ts`), and the real AI-vs-local merge point is `chat-handler.ts:mergeAiSuggestions`. **This plan targets the `Suggestion` pipeline.** We mirror the new fields onto `FindingNode` for graph/export parity, but the authoritative behavior (UI filter, "detected by N sources" badge, severity grouping) lives on `Suggestion`.
- Severity model decision (locked with the user): **Hybrid** — structural floor + cost amplifier, `Math.max` of the two tiers. Not the spec's pure `confidence × cost` formula (which would zero-out free-endpoint risk and re-baseline the benchmark).
- `costImpactUsd` source decision (locked): **reuse the existing heuristic** — endpoint `monthlyCost` (from `estimateLocalMonthlyCost` / `LOCAL_PRICING`) × the shared `FREQUENCY_CLASS_MULTIPLIERS`. No new pricing model.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `src/analysis/types.ts` | Shared `Suggestion` / `Severity` / `SuggestionType` | Add `sources?: string[]`, `costImpactUsd?: number \| null` to `Suggestion` |
| `src/scanner/local-waste-detector.ts` | Regex waste detectors → `LocalWasteFinding` | Add `riskScore` to `LocalWasteFinding`; emit it (the `score` already computed); tighten `CACHE_GUARD`/`BATCH_GUARD` via comment-stripped guard window (#112) |
| `src/scanner/python-waste-detector.ts` | Python waste detector | Emit `riskScore` (1 site) |
| `src/ast/waste/batch-detector.ts` / `cache-detector.ts` / `concurrency-detector.ts` | AST waste detectors | Emit `riskScore` (10 sites) |
| `src/simulator/engine.ts` | Simulator; owns `FREQUENCY_CLASS_MULTIPLIERS` | `export` the multiplier map (single source of truth) |
| `src/scan-results.ts` | Suggestion construction (local + remote merge) | Add `deriveSeverity()`, `computeCostImpact()`, `collapseSuggestions()`; apply at every construction site; set `sources` |
| `src/webview/chat-handler.ts` | AI review → Suggestion merge | Rewrite `mergeAiSuggestions` to collapse-not-drop; derive severity for AI findings; set `sources: ["ai"]` |
| `src/webview/scan-publishing-handler.ts` | Remote-path Suggestion construction | Apply `deriveSeverity`/`computeCostImpact`/`sources` at its 2 construction sites |
| `src/intelligence/types.ts` | `FindingNode` (graph) | Add `sources: string[]`, `costImpactUsd: number \| null` |
| `src/intelligence/builder.ts` | Builds `FindingNode` from `LocalWasteFinding` | Populate new fields |
| `webview/src/types.ts` | Webview mirror of `Suggestion` | Mirror `sources` (already has `confidence`) |
| `webview/src/components/ResultsPage.tsx` | Sidebar results UI | Confidence filter control (#85); "detected by N sources" badge (#84) |
| `src/test/local-waste-detector.test.ts` | existing | Add #112 guard-leak regression cases |
| `src/test/scan-results.test.ts` | **new** | `deriveSeverity`, `computeCostImpact`, `collapseSuggestions` unit tests |
| `src/test/chat-handler-merge.test.ts` | **new** | `mergeAiSuggestions` collapse + sources tests |
| `package.json` | `test:scanner` chain | Register the 2 new test files |

**Task groups** (logically separable; can be reviewed/committed as units within the one PR):
- **Group A — #112** guard tightening (independent; smallest; do first).
- **Group B — #85** confidence + derived severity + cost impact + confidence filter UI.
- **Group C — #84** dedupe + sources field + sources badge UI (depends on B's `deriveSeverity`/`collapseSuggestions`).
- **Group V** — verification (full suite + benchmark + manual EDH).

---

## Group A — #112: Tighten CACHE_GUARD / BATCH_GUARD

**Root cause:** `extractCallSites` builds an ±8-line `windowText` (`getWindow`, `local-waste-detector.ts:105`) and the cache/batch detectors suppress findings when `CACHE_GUARD`/`BATCH_GUARD` match anywhere in it (`local-waste-detector.ts:151-152`). The regexes include bare `\bcache\b` and `\bbatch\b`, so a comment like `// TODO: batch these later` or `# we cache elsewhere` silently kills a real finding (the "literal-word leak" noted in `docs/superpowers/plans/2026-05-15-c1-pr4-rate-limit-batch-tightening.md:128`).

**Fix:** Test guards against a *comment-stripped* copy of the window so prose mentions don't count, while real code mechanisms (`cacheClient.get`, `staleTime:`, `messageBatches`, `.bulk(`) still guard. Keep all other signals on the raw window.

### Task A1: Comment-stripping helper + apply to guard detection

**Files:**
- Modify: `src/scanner/local-waste-detector.ts` (add helper near `getWindow` ~line 105; use it in the `cacheGuard`/`batchGuard` assignments ~line 151-152)
- Test: `src/test/local-waste-detector.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/test/local-waste-detector.test.ts`:

```ts
import { detectLocalWasteFindingsInText } from "../scanner/local-waste-detector";

run("#112: bare 'cache' in a comment does not suppress a cache finding", () => {
  const text = [
    "// we should cache this someday but do not yet",
    "export async function loadUsers(ids) {",
    "  const out = [];",
    "  for (const id of ids) {",
    "    out.push(await fetch(`https://api.example.com/users/${id}`));",
    "  }",
    "  return out;",
    "}",
  ].join("\n");
  const findings = detectLocalWasteFindingsInText("src/users.ts", text);
  assert.ok(findings.some((f) => f.type === "cache"), "expected a cache finding despite the comment word");
});

run("#112: bare 'batch' in a comment does not suppress a batch finding", () => {
  const text = [
    "// batch these calls in a follow-up PR",
    "export async function embedAll(items) {",
    "  for (const it of items) {",
    "    await openai.embeddings.create({ input: it });",
    "  }",
    "}",
  ].join("\n");
  const findings = detectLocalWasteFindingsInText("src/embed.ts", text);
  assert.ok(findings.some((f) => f.type === "batch"), "expected a batch finding despite the comment word");
});

run("#112: a real cache mechanism in code still suppresses the cache finding", () => {
  const text = [
    "import { queryClient } from './qc';",
    "export async function loadUsers(ids) {",
    "  const out = [];",
    "  for (const id of ids) {",
    "    out.push(await queryClient.fetchQuery(['u', id], () => fetch(`/users/${id}`), { staleTime: 60000 }));",
    "  }",
    "  return out;",
    "}",
  ].join("\n");
  const findings = detectLocalWasteFindingsInText("src/users2.ts", text);
  assert.ok(!findings.some((f) => f.type === "cache"), "real staleTime/queryClient guard should still suppress");
});
```

- [ ] **Step 2: Run to verify the first two fail (leak), third passes**

Run: `npm run test:scanner 2>&1 | grep -A2 "#112"`
Expected: the two comment-word tests FAIL (finding suppressed by leak); the real-mechanism test PASSES.

- [ ] **Step 3: Add `stripComments` and a comment-free guard window**

In `src/scanner/local-waste-detector.ts`, add after `getWindow` (~line 109):

```ts
// #112: guard regexes (CACHE_GUARD/BATCH_GUARD/...) must not be tripped by the
// bare words "cache"/"batch" appearing in comments. Strip line + block comments
// before testing guards; all other signals keep using the raw window text.
function stripComments(windowText: string): string {
  return windowText
    .replace(/\/\*[\s\S]*?\*\//g, " ")   // block comments
    .replace(/\/\/[^\n]*/g, " ")          // // line comments
    .replace(/(^|\s)#[^\n]*/g, "$1 ");    // # line comments (python)
}
```

- [ ] **Step 4: Use the stripped window for the guard signals**

In `extractCallSites` (~line 137-165), the `windowText` is computed once. Add a sibling and switch the five guard signals to it. Replace:

```ts
    const windowText = getWindow(lines, line - 1);
    const callKind = classifyCallKind(match);
    return {
      line,
      match,
      windowText,
```
with:
```ts
    const windowText = getWindow(lines, line - 1);
    const guardWindowText = stripComments(windowText);
    const callKind = classifyCallKind(match);
    return {
      line,
      match,
      windowText,
```
and change the guard assignments (same object literal) from testing `windowText` to `guardWindowText`:
```ts
      cacheGuard: CACHE_GUARD.test(guardWindowText),
      batchGuard: BATCH_GUARD.test(guardWindowText),
      concurrencyGuard: CONCURRENCY_GUARD.test(guardWindowText),
      retryGuard: RETRY_GUARD.test(guardWindowText),
      idempotencyGuard: IDEMPOTENCY_GUARD.test(guardWindowText),
      explicitGuard: EXPLICIT_GUARD.test(guardWindowText),
```
Leave `promiseAll`, `mapFanout`, `arrayFanout`, `hotPath`, `polling`, `retryNearby`, `authLookup`, `configLookup`, `smallBounded` on the raw `windowText`.

- [ ] **Step 5: Run to verify all three pass**

Run: `npm run test:scanner 2>&1 | grep -A2 "#112"`
Expected: all three PASS.

- [ ] **Step 6: Run the benchmark to confirm no precision/recall regression**

Run: `npm run benchmark`
Expected: `cache` and `batch` finding precision do not drop > 1pp on types with sample ≥ 3; recall does not drop. (Comment-only suppressions were false negatives; recall should hold or improve.) Record the Δ.

- [ ] **Step 7: Commit**

```bash
git add src/scanner/local-waste-detector.ts src/test/local-waste-detector.test.ts
git commit -m "fix(scanner): stop CACHE_GUARD/BATCH_GUARD comment-word leak (#112)"
```

---

## Group B — #85: Confidence everywhere + severity derived from signals

### Task B1: Export `FREQUENCY_CLASS_MULTIPLIERS` from the simulator (single source of truth)

**Files:**
- Modify: `src/simulator/engine.ts:16`

- [ ] **Step 1: Read the current map**

Run: `sed -n '16,24p' src/simulator/engine.ts`
Expected: `const FREQUENCY_CLASS_MULTIPLIERS: Record<string, number> = { "unbounded-loop": 10, "polling": 8, "parallel": 3, "bounded-loop": 3, "conditional": 0.5, "cache-guarded": 0.1 };`

- [ ] **Step 2: Add `export`**

Change `const FREQUENCY_CLASS_MULTIPLIERS` to `export const FREQUENCY_CLASS_MULTIPLIERS`. No other change. (CLAUDE.md mandates these multipliers stay single-sourced; we reuse, never copy.)

- [ ] **Step 3: Verify build**

Run: `npm run build:ext`
Expected: clean (no new errors).

- [ ] **Step 4: Commit**

```bash
git add src/simulator/engine.ts
git commit -m "refactor(simulator): export FREQUENCY_CLASS_MULTIPLIERS for reuse (#85)"
```

### Task B2: `riskScore` on `LocalWasteFinding` + emit from every detector

**Files:**
- Modify: `src/scanner/local-waste-detector.ts` (`LocalWasteFinding` interface ~line 34; `makeFinding` ~line 221)
- Modify: `src/scanner/python-waste-detector.ts:170`
- Modify: `src/ast/waste/batch-detector.ts:136,189,250,305`
- Modify: `src/ast/waste/cache-detector.ts:246`
- Modify: `src/ast/waste/concurrency-detector.ts:132,177,224,268`
- Test: covered transitively by B4 (`deriveSeverity` consumes `riskScore`)

- [ ] **Step 1: Add the field to the interface**

In `src/scanner/local-waste-detector.ts`, in `interface LocalWasteFinding` (~line 34), add after `confidence: number;`:

```ts
  /** Structural risk score from the detector (pre-cost). Feeds deriveSeverity(); the
   *  `severity` field is now provisional/structural and overridden at Suggestion build. */
  riskScore: number;
```

- [ ] **Step 2: Emit it from the central `makeFinding`**

In `src/scanner/local-waste-detector.ts`, `makeFinding` (~line 221) takes `score`. Add `riskScore: score,` to the returned object (next to `severity: scoreToSeverity(score)`):

```ts
  return {
    id: `local-${type}-${relativePath}:${line}`,
    type,
    severity: scoreToSeverity(score),
    riskScore: score,
    confidence,
    description,
    affectedFile: relativePath,
    line,
    evidence,
  };
```

- [ ] **Step 3: Emit it from python + AST detectors**

Each site already computes a `score` immediately before `severity: scoreToSeverity(score)`. Add `riskScore: score,` directly beneath each `severity: scoreToSeverity(score),` line at these exact locations:
- `src/scanner/python-waste-detector.ts:170`
- `src/ast/waste/batch-detector.ts:136`, `:189`, `:250`, `:305`
- `src/ast/waste/cache-detector.ts:246`
- `src/ast/waste/concurrency-detector.ts:132`, `:177`, `:224`, `:268`

For each, the edit is identical in shape:
```ts
    severity: scoreToSeverity(score),
    riskScore: score,
```
(If a site's local variable is not named `score`, use whatever value is passed to `scoreToSeverity(...)` on that line.)

- [ ] **Step 4: Verify build**

Run: `npm run build:ext`
Expected: clean. If any AST-detector object is typed as `LocalWasteFinding` and a site is missed, tsc flags the missing required `riskScore` — fix that site.

- [ ] **Step 5: Run scanner tests (no behavior change yet)**

Run: `npm run test:scanner 2>&1 | tail -5`
Expected: all PASS (these tests assert on `type`/`severity`/`confidence`, which are unchanged here).

- [ ] **Step 6: Commit**

```bash
git add src/scanner/local-waste-detector.ts src/scanner/python-waste-detector.ts src/ast/waste/*.ts
git commit -m "feat(scanner): carry structural riskScore on findings (#85)"
```

### Task B3: `deriveSeverity` + `computeCostImpact` in scan-results.ts

**Files:**
- Modify: `src/scan-results.ts` (add near `calculateSavings` ~line 62)
- Test: `src/test/scan-results.test.ts` (**new**)

- [ ] **Step 1: Write the failing tests**

Create `src/test/scan-results.test.ts`:

```ts
import assert from "node:assert/strict";
import { deriveSeverity, computeCostImpact } from "../scan-results";

function run(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

run("computeCostImpact amplifies by frequency class and rounds", () => {
  assert.equal(computeCostImpact(10, "polling"), 80);          // 10 * 8
  assert.equal(computeCostImpact(10, "unbounded-loop"), 100);  // 10 * 10
  assert.equal(computeCostImpact(10, undefined), 10);          // no class → 1x
  assert.equal(computeCostImpact(0, "polling"), null);         // no baseline → null
  assert.equal(computeCostImpact(10, "cache-guarded"), 1);     // 10 * 0.1
});

run("deriveSeverity keeps the structural floor when cost is ~0 (benchmark-safe)", () => {
  // high structural score on a free endpoint stays high (not dropped to low)
  assert.equal(deriveSeverity({ riskScore: 6, confidence: 0.9, costImpactUsd: 0 }), "high");
  assert.equal(deriveSeverity({ riskScore: 4, confidence: 0.9, costImpactUsd: null }), "medium");
  assert.equal(deriveSeverity({ riskScore: 1, confidence: 0.9, costImpactUsd: 0 }), "low");
});

run("deriveSeverity escalates a cheap-structure finding on an expensive endpoint", () => {
  // low structural score, but big confidence-weighted cost → high
  assert.equal(deriveSeverity({ riskScore: 1, confidence: 0.9, costImpactUsd: 200 }), "high"); // 0.9*200=180
  assert.equal(deriveSeverity({ riskScore: 1, confidence: 0.9, costImpactUsd: 20 }), "medium"); // 0.9*20=18
});

run("deriveSeverity: same type, different cost → different severity (#85 acceptance)", () => {
  const cheap = deriveSeverity({ riskScore: 2, confidence: 0.8, costImpactUsd: 0 });
  const pricey = deriveSeverity({ riskScore: 2, confidence: 0.8, costImpactUsd: 500 });
  assert.notEqual(cheap, pricey);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test:scanner 2>&1 | grep -A2 "scan-results"` (after Step 4 wiring) — for now:
Run: `tsc -p tsconfig.scanner-tests.json 2>&1 | grep scan-results.test || echo "compiles-but-functions-missing"`
Expected: FAIL — `deriveSeverity`/`computeCostImpact` not exported.

- [ ] **Step 3: Implement both functions**

In `src/scan-results.ts`, add the import at the top (next to the other imports):

```ts
import { FREQUENCY_CLASS_MULTIPLIERS } from "./simulator/engine";
```

Add after `calculateSavings` (~line 62):

```ts
/**
 * #85: monthly $ exposure of a finding (internal severity signal — never shown).
 * Heuristic only: endpoint monthlyCost (LOCAL_PRICING/fingerprints) amplified by the
 * shared frequency-class multiplier. Returns null when no baseline cost is known.
 */
export function computeCostImpact(
  baselineMonthlyCost: number,
  frequencyClass: string | undefined
): number | null {
  if (!baselineMonthlyCost || baselineMonthlyCost <= 0) return null;
  const multiplier = frequencyClass ? (FREQUENCY_CLASS_MULTIPLIERS[frequencyClass] ?? 1) : 1;
  return Number((baselineMonthlyCost * multiplier).toFixed(2));
}

export interface SeveritySignals {
  riskScore: number;             // structural score (0..~7) from the detector
  confidence: number;            // 0..1
  costImpactUsd: number | null;  // from computeCostImpact()
}

/**
 * #85: the single place severity is derived. Hybrid model —
 *  - structural FLOOR (riskScore thresholds 5/3, matching the calibrated scoreToSeverity)
 *    preserves C1 precision and keeps free-endpoint risks visible;
 *  - cost AMPLIFIER (confidence × costImpactUsd, thresholds 100/10) can only escalate.
 * severity = max(structuralTier, costTier). Never drops below structural → benchmark-safe.
 */
export function deriveSeverity(signals: SeveritySignals): Severity {
  const structuralTier = signals.riskScore >= 5 ? 2 : signals.riskScore >= 3 ? 1 : 0;
  const costScore = signals.confidence * (signals.costImpactUsd ?? 0);
  const costTier = costScore >= 100 ? 2 : costScore >= 10 ? 1 : 0;
  const tier = Math.max(structuralTier, costTier);
  return tier === 2 ? "high" : tier === 1 ? "medium" : "low";
}

/** Map a finding's own/structural severity back to an approximate riskScore.
 *  Used for AI findings (no structural score) so deriveSeverity works uniformly. */
export const SEVERITY_TO_RISK_SCORE: Record<Severity, number> = { high: 5, medium: 3, low: 1 };
```

Confirm `Severity` is imported in this file — `src/scan-results.ts:1` imports from `./analysis/types`; add `Severity` to that import if not present.

- [ ] **Step 4: Register the new test file**

In `package.json` `test:scanner`, append ` && node dist-test/test/scan-results.test.js` to the chain (after `local-waste-detector.test.js` is fine).

- [ ] **Step 5: Run to verify it passes**

Run: `npm run test:scanner 2>&1 | grep -A2 "scan-results\|deriveSeverity\|computeCostImpact"`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add src/scan-results.ts src/test/scan-results.test.ts package.json
git commit -m "feat(findings): central deriveSeverity + computeCostImpact (#85)"
```

### Task B4: Apply derived severity + costImpact at every Suggestion-construction site

**Files:**
- Modify: `src/scan-results.ts` — `buildAggressiveSuggestions` (~line 150), `mergeLocalWasteFindings` (~line 235)
- Modify: `src/webview/scan-publishing-handler.ts` — 2 construction sites (~line 188, ~line 268)
- Modify: `src/webview/chat-handler.ts` — `mapAiFindingToSuggestion` (~line 431)
- Test: extend `src/test/scan-results.test.ts`

- [ ] **Step 1: Write the failing integration test**

Append to `src/test/scan-results.test.ts`:

```ts
import { buildLocalScanResults } from "../scan-results";
import type { ApiCallInput } from "../analysis/types";
import type { LocalWasteFinding } from "../scanner/local-waste-detector";

run("buildLocalScanResults: every suggestion has costImpactUsd defined and sources set", () => {
  const calls: ApiCallInput[] = [{
    file: "src/a.ts", line: 5, method: "POST", url: "https://api.openai.com/v1/chat/completions",
    library: "openai", provider: "openai", frequency: "per-request", frequencyClass: "unbounded-loop",
    methodSignature: "chat.completions.create", costModel: "per_token",
  }];
  const findings: LocalWasteFinding[] = [{
    id: "f1", type: "n_plus_one", severity: "low", riskScore: 6, confidence: 0.9,
    description: "loop-driven openai call", affectedFile: "src/a.ts", line: 5,
    evidence: ["Outbound call occurs inside a loop."],
  }];
  const { suggestions } = buildLocalScanResults(calls, findings, "proj", "scan");
  assert.ok(suggestions.length >= 1);
  for (const s of suggestions) {
    assert.ok(s.costImpactUsd !== undefined, "costImpactUsd must be populated (null allowed)");
    assert.ok(Array.isArray(s.sources) && s.sources.length >= 1, "sources must be set");
    assert.ok(["high", "medium", "low"].includes(s.severity));
  }
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test:scanner 2>&1 | grep -A2 "every suggestion"`
Expected: FAIL — `costImpactUsd`/`sources` undefined.

- [ ] **Step 3: Add fields to the `Suggestion` type**

In `src/analysis/types.ts`, `interface Suggestion` (~line 89), add:
```ts
  sources?: string[];
  costImpactUsd?: number | null;
```

- [ ] **Step 4: Wire `buildAggressiveSuggestions` (scan-results.ts ~line 150)**

Replace the pushed object's `severity`/`estimatedMonthlySavings` lines and add the new fields. The block currently is:
```ts
      severity: chooseSeverity(endpoint.status, endpoint.monthlyCost),
      affectedEndpoints: [endpoint.id],
      affectedFiles: endpoint.files,
      estimatedMonthlySavings: calculateSavings(type, "medium", endpoint.monthlyCost),
```
Replace with:
```ts
      ...(() => {
        const confidence = confidenceFromEndpointStatus(endpoint);
        const costImpactUsd = computeCostImpact(endpoint.monthlyCost, endpoint.frequencyClass);
        const severity = deriveSeverity({
          riskScore: SEVERITY_TO_RISK_SCORE[chooseSeverity(endpoint.status, endpoint.monthlyCost)],
          confidence,
          costImpactUsd,
        });
        return {
          severity,
          affectedEndpoints: [endpoint.id],
          affectedFiles: endpoint.files,
          estimatedMonthlySavings: calculateSavings(type, severity, endpoint.monthlyCost),
          costImpactUsd,
        };
      })(),
```
And remove the later standalone `confidence: confidenceFromEndpointStatus(endpoint),` line if it now duplicates — instead keep a single `confidence` and add `sources: ["remote"]` (these are aggressive suggestions derived from endpoint status on the remote path). Net: the object must end up with exactly one `severity`, `confidence`, `estimatedMonthlySavings`, `costImpactUsd`, and `sources: ["remote"]`.

> Note for implementer: the IIFE is to keep `confidence`/`costImpactUsd`/`severity` consistent in one spot. If you prefer, hoist three `const`s above the `extras.push({...})` call instead — same result, less nesting. Pick the clearer form.

- [ ] **Step 5: Wire `mergeLocalWasteFindings` (scan-results.ts ~line 235)**

The pushed object currently sets `severity: finding.severity` and `estimatedMonthlySavings: calculateSavings(finding.type, finding.severity, baselineCost)`. Just above the `locals.push({...})`, add:
```ts
    const frequencyClass = closestEndpoint?.frequencyClass
      ?? fileEndpoints.find((ep) => ep.frequencyClass)?.frequencyClass;
    const costImpactUsd = computeCostImpact(baselineCost, frequencyClass);
    const severity = deriveSeverity({
      riskScore: finding.riskScore,
      confidence: finding.confidence,
      costImpactUsd,
    });
```
Then in the pushed object replace `severity: finding.severity,` with `severity,`, replace the `estimatedMonthlySavings` value's severity arg with the derived `severity`, and add `costImpactUsd,` and `sources: ["local-rule"],`.

- [ ] **Step 6: Wire `scan-publishing-handler.ts` (2 sites ~line 188, ~line 268)**

These mirror `buildAggressiveSuggestions` (endpoint-status path, ~188) and `mergeLocalWasteFindings` (local-finding path, ~268) — apply the same pattern: import `deriveSeverity, computeCostImpact, SEVERITY_TO_RISK_SCORE` from `../scan-results` (it already imports `classifyPricing, calculateSavings` from there per `scan-publishing-handler.ts:13`), compute `costImpactUsd` + derived `severity`, pass derived severity to `calculateSavings`, and set `sources` (`["remote"]` for the status-derived site, `["local-rule"]` for the local-finding site). `LocalWasteFinding.riskScore` is available on the finding-path site.

- [ ] **Step 7: Wire `chat-handler.ts:mapAiFindingToSuggestion` (~line 431)**

Import `deriveSeverity, computeCostImpact, SEVERITY_TO_RISK_SCORE` from `../scan-results` (it already imports `classifyPricing, calculateSavings` per `chat-handler.ts:7`). Just before the `return {`, add:
```ts
    const aiFrequencyClass = closestEndpoint?.frequencyClass
      ?? fileEndpoints.find((ep) => ep.frequencyClass)?.frequencyClass;
    const costImpactUsd = computeCostImpact(monthlyBaseline, aiFrequencyClass);
    const severity = deriveSeverity({
      riskScore: SEVERITY_TO_RISK_SCORE[finding.severity],
      confidence: finding.confidence,
      costImpactUsd,
    });
```
In the returned object: replace `severity: finding.severity,` with `severity,`; change `estimatedMonthlySavings: calculateSavings(finding.type, finding.severity, monthlyBaseline)` to use `severity`; add `costImpactUsd,` and `sources: ["ai"],`.

- [ ] **Step 8: Run tests + build**

Run: `npm run build:ext && npm run test:scanner 2>&1 | grep -A2 "every suggestion"`
Expected: PASS. Full chain green.

- [ ] **Step 9: Run the benchmark (severity changes must not move per-type precision)**

Run: `npm run benchmark`
Expected: per-type finding precision/recall Δ = 0 (severity reassignment adds/removes no findings). Record Δ.

- [ ] **Step 10: Commit**

```bash
git add src/analysis/types.ts src/scan-results.ts src/webview/scan-publishing-handler.ts src/webview/chat-handler.ts src/test/scan-results.test.ts
git commit -m "feat(findings): derive severity + cost impact at all suggestion sites (#85)"
```

### Task B5: FindingNode graph parity

**Files:**
- Modify: `src/intelligence/types.ts` (`FindingNode` ~line 31)
- Modify: `src/intelligence/builder.ts` (~line 246)
- Modify: `src/scanner/local-waste-detector.ts` (so `LocalWasteFinding` can carry `costImpactUsd` into the graph) — **only if** the builder needs it; otherwise default to `null`.
- Test: `src/intelligence/__tests__/builder.test.ts` (existing)

- [ ] **Step 1: Add fields to FindingNode**

In `src/intelligence/types.ts` `interface FindingNode`, add:
```ts
  sources: string[];
  costImpactUsd: number | null;
```

- [ ] **Step 2: Populate in builder**

In `src/intelligence/builder.ts` (~line 246), the `findingNode` literal — add:
```ts
        sources: ["local-rule"],
        costImpactUsd: null,
```
(The graph is built from `LocalWasteFinding[]` only — all local-rule — so `["local-rule"]` is correct here; `costImpactUsd` is `null` at graph-build time because endpoint cost is resolved later in the Suggestion layer. This keeps the graph honest rather than fabricating a number.)

- [ ] **Step 3: Build + run intelligence tests**

Run: `npm run build:ext && node dist-test/intelligence/__tests__/builder.test.js`
(After a `tsc -p tsconfig.scanner-tests.json`.) Expected: PASS — if `builder.test.ts` asserts exact `FindingNode` shape, update its fixtures to include the two new fields.

- [ ] **Step 4: Commit**

```bash
git add src/intelligence/types.ts src/intelligence/builder.ts src/intelligence/__tests__/builder.test.ts
git commit -m "feat(intelligence): mirror sources + costImpactUsd on FindingNode (#85/#84)"
```

### Task B6: Confidence filter in the sidebar UI

**Files:**
- Modify: `webview/src/components/ResultsPage.tsx` (Findings/Issues subtab, near `visibleSuggestions` ~line 597 and the type-filter dropdown ~line 687)

- [ ] **Step 1: Add `minConfidence` state**

Near the other `useState` hooks in the `ResultsPage` component, add:
```tsx
const [minConfidence, setMinConfidence] = useState(0); // 0 = show all
```

- [ ] **Step 2: Apply to `visibleSuggestions`**

`visibleSuggestions` (~line 597) currently filters by `typeFilter`. Chain the confidence filter (findings without a confidence value are treated as fully confident so they are never hidden):
```tsx
const visibleSuggestions = (typeFilter === "all" ? suggestions : suggestions.filter((s) => s.type === typeFilter))
  .filter((s) => (typeof s.confidence === "number" ? s.confidence : 1) >= minConfidence);
```

- [ ] **Step 3: Add the control next to the type-filter dropdown (~line 687)**

Beside the existing `<select>` for type, add:
```tsx
<select
  aria-label="Minimum confidence"
  value={minConfidence}
  onChange={(e) => setMinConfidence(Number(e.target.value))}
  className="eco-select"
>
  <option value={0}>Any confidence</option>
  <option value={0.4}>≥ 40%</option>
  <option value={0.6}>≥ 60%</option>
  <option value={0.8}>≥ 80%</option>
</select>
```
(Reuse whatever className/styling the adjacent type `<select>` uses so it matches.)

- [ ] **Step 4: Build the webview**

Run: `npm run build:webview`
Expected: clean build.

- [ ] **Step 5: Manual EDH check (UI correctness — cannot be unit-tested)**

F5 the Extension Development Host, scan a workspace with mixed-confidence findings, set "≥ 80%", confirm low-confidence findings disappear and severity groups recompute from the visible set. **Document the result; do not claim success without observing it.**

- [ ] **Step 6: Commit**

```bash
git add webview/src/components/ResultsPage.tsx
git commit -m "feat(webview): confidence filter for findings (#85)"
```

---

## Group C — #84: Dedupe AI + local findings; record every source

**Current behavior (`chat-handler.ts:mergeAiSuggestions`, lines 451-494):** an incoming AI suggestion whose `type|file|line|normalizedDescription` matches an existing one — or that lands within ±5 lines of a same-type deterministic finding — is **dropped** (`filtered += 1`). The surviving finding does not learn that a second source also detected it. Also, the description is part of the key, so two differently-worded findings about the *same* call can both survive.

**Target:** collapse same-issue findings to one, union their `sources`, take `max()` confidence, prefer the AI's (richer) description, recompute severity from the merged signals.

### Task C1: `collapseSuggestions` in scan-results.ts

**Files:**
- Modify: `src/scan-results.ts` (add after `deriveSeverity`)
- Test: `src/test/scan-results.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/test/scan-results.test.ts`:

```ts
import { collapseSuggestions } from "../scan-results";
import type { Suggestion } from "../analysis/types";

function sug(p: Partial<Suggestion>): Suggestion {
  return {
    id: p.id ?? "x", projectId: "p", scanId: "s",
    type: p.type ?? "n_plus_one", severity: p.severity ?? "low",
    affectedEndpoints: p.affectedEndpoints ?? [], affectedFiles: p.affectedFiles ?? ["src/a.ts"],
    targetLine: p.targetLine, estimatedMonthlySavings: p.estimatedMonthlySavings ?? 0,
    description: p.description ?? "d", codeFix: "", source: p.source, confidence: p.confidence,
    evidence: p.evidence ?? [], sources: p.sources, costImpactUsd: p.costImpactUsd ?? null,
  };
}

run("collapseSuggestions: same type+endpoint collapses, unions sources, max confidence, prefers AI desc", () => {
  const local = sug({ id: "l", type: "n_plus_one", affectedEndpoints: ["ep1"], confidence: 0.7,
    description: "loop call", source: "local-rule", sources: ["local-rule"], severity: "medium" });
  const ai = sug({ id: "a", type: "n_plus_one", affectedEndpoints: ["ep1"], confidence: 0.9,
    description: "N+1: this fetch runs once per user in the loop", source: "ai", sources: ["ai"], severity: "low" });
  const out = collapseSuggestions([local, ai]);
  assert.equal(out.length, 1);
  assert.deepEqual([...out[0].sources!].sort(), ["ai", "local-rule"]);
  assert.equal(out[0].confidence, 0.9);
  assert.match(out[0].description, /N\+1/);
});

run("collapseSuggestions: different endpoints do not collapse", () => {
  const a = sug({ id: "a", affectedEndpoints: ["ep1"] });
  const b = sug({ id: "b", affectedEndpoints: ["ep2"] });
  assert.equal(collapseSuggestions([a, b]).length, 2);
});

run("collapseSuggestions: no endpoint → 5-line bucket collapses nearby same-type findings", () => {
  const a = sug({ id: "a", affectedEndpoints: [], targetLine: 12, sources: ["local-rule"] });
  const b = sug({ id: "b", affectedEndpoints: [], targetLine: 14, sources: ["ai"], description: "richer", source: "ai" });
  const out = collapseSuggestions([a, b]);
  assert.equal(out.length, 1);
  assert.deepEqual([...out[0].sources!].sort(), ["ai", "local-rule"]);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test:scanner 2>&1 | grep -A2 "collapseSuggestions"`
Expected: FAIL — function not exported.

- [ ] **Step 3: Implement `collapseSuggestions`**

In `src/scan-results.ts`, add after `deriveSeverity`:

```ts
function suggestionMergeKey(s: Suggestion): string {
  const file = s.affectedFiles[0] ?? "";
  const endpoint = s.affectedEndpoints[0];
  const locationBucket = endpoint ?? `L${Math.round((s.targetLine ?? 0) / 5)}`;
  return `${s.type}::${file}::${locationBucket}`;
}

const SOURCE_DESCRIPTION_RANK: Record<string, number> = { ai: 3, remote: 2, "local-rule": 1 };

function sourcesOf(s: Suggestion): string[] {
  if (s.sources && s.sources.length > 0) return s.sources;
  return s.source ? [s.source] : [];
}

/**
 * #84: collapse findings that describe the same issue at the same location into one.
 * - dedupe key: type | file | endpointId (or 5-line bucket when no endpoint)
 * - sources: union of both findings' sources
 * - confidence: max()
 * - description/evidence: from the highest-ranked source (ai > remote > local-rule)
 * - severity: recomputed from merged signals (max confidence, max costImpact)
 */
export function collapseSuggestions(suggestions: Suggestion[]): Suggestion[] {
  const byKey = new Map<string, Suggestion>();
  for (const incoming of suggestions) {
    const key = suggestionMergeKey(incoming);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { ...incoming, sources: [...new Set(sourcesOf(incoming))] });
      continue;
    }

    const mergedSources = [...new Set([...sourcesOf(existing), ...sourcesOf(incoming)])];
    const confidence = Math.max(existing.confidence ?? 0, incoming.confidence ?? 0);
    const costImpactUsd = Math.max(existing.costImpactUsd ?? 0, incoming.costImpactUsd ?? 0) || null;
    const rank = (s: Suggestion) => SOURCE_DESCRIPTION_RANK[s.source ?? ""] ?? 0;
    const descSource = rank(incoming) > rank(existing) ? incoming : existing;
    const riskScore = SEVERITY_TO_RISK_SCORE[
      ([existing.severity, incoming.severity].includes("high")
        ? "high"
        : [existing.severity, incoming.severity].includes("medium")
        ? "medium"
        : "low") as Severity
    ];
    const severity = deriveSeverity({ riskScore, confidence, costImpactUsd });

    byKey.set(key, {
      ...existing,
      sources: mergedSources,
      confidence,
      costImpactUsd,
      description: descSource.description,
      evidence: descSource.evidence ?? existing.evidence,
      severity,
      estimatedMonthlySavings: Math.max(existing.estimatedMonthlySavings, incoming.estimatedMonthlySavings),
    });
  }
  return [...byKey.values()];
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm run test:scanner 2>&1 | grep -A2 "collapseSuggestions"`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/scan-results.ts src/test/scan-results.test.ts
git commit -m "feat(findings): collapseSuggestions merges sources + max confidence (#84)"
```

### Task C2: Replace `mergeAiSuggestions` drop-logic with collapse

**Files:**
- Modify: `src/webview/chat-handler.ts:451` (`mergeAiSuggestions`) and its caller (~line 543)
- Test: `src/test/chat-handler-merge.test.ts` (**new**)

- [ ] **Step 1: Write the failing test**

Create `src/test/chat-handler-merge.test.ts`:

```ts
import assert from "node:assert/strict";
import { collapseSuggestions } from "../scan-results";
import type { Suggestion } from "../analysis/types";

function run(name: string, fn: () => void): void {
  try { fn(); console.log(`PASS ${name}`); }
  catch (e) { console.error(`FAIL ${name}`); throw e; }
}

function sug(p: Partial<Suggestion>): Suggestion {
  return {
    id: p.id ?? "x", projectId: "p", scanId: "s", type: p.type ?? "n_plus_one",
    severity: p.severity ?? "low", affectedEndpoints: p.affectedEndpoints ?? ["ep1"],
    affectedFiles: p.affectedFiles ?? ["src/a.ts"], targetLine: p.targetLine ?? 10,
    estimatedMonthlySavings: 0, description: p.description ?? "d", codeFix: "",
    source: p.source, confidence: p.confidence ?? 0.5, evidence: [], sources: p.sources,
    costImpactUsd: p.costImpactUsd ?? null,
  };
}

run("#84: AI + local on the same endpoint collapse to one with both sources", () => {
  const local = sug({ id: "l", source: "local-rule", sources: ["local-rule"], confidence: 0.7 });
  const ai = sug({ id: "a", source: "ai", sources: ["ai"], confidence: 0.9, description: "richer ai desc" });
  const out = collapseSuggestions([local, ai]);
  assert.equal(out.length, 1);
  assert.deepEqual([...out[0].sources!].sort(), ["ai", "local-rule"]);
  assert.equal(out[0].confidence, 0.9);
});
```
(The merge logic now lives in `collapseSuggestions`; `mergeAiSuggestions` becomes a thin wrapper, so the unit test targets the shared function. The wrapper's added/filtered counting is asserted in Step 4 via the EDH check + the count math below.)

- [ ] **Step 2: Run to verify it passes (function exists) and register the file**

Append ` && node dist-test/test/chat-handler-merge.test.js` to `package.json` `test:scanner`.
Run: `npm run test:scanner 2>&1 | grep -A2 "#84"`
Expected: PASS.

- [ ] **Step 3: Rewrite `mergeAiSuggestions` to collapse**

Replace the body of `mergeAiSuggestions` (`chat-handler.ts:451-494`) with:

```ts
  private mergeAiSuggestions(existing: Suggestion[], incoming: Suggestion[]): { merged: Suggestion[]; added: number; filtered: number } {
    const collapsed = collapseSuggestions([...existing, ...incoming]);
    // "added" = net new distinct findings the AI pass contributed;
    // "filtered" = AI findings that collapsed into an existing one.
    const added = collapsed.length - existing.length;
    const filtered = incoming.length - added;
    return { merged: collapsed, added: Math.max(0, added), filtered: Math.max(0, filtered) };
  }
```
Add the import at the top of `chat-handler.ts` (extend the existing `from "../scan-results"` import): `collapseSuggestions`.

> Behavior change: previously AI findings overlapping a local one were discarded. Now they collapse and the surviving finding gains `sources: ["local-rule","ai"]`, `max` confidence, and the AI's description. The `added`/`filtered` counts reported in the `aiReviewComplete` message keep the same meaning (net-new vs absorbed).

- [ ] **Step 4: Build + run**

Run: `npm run build:ext && npm run test:scanner 2>&1 | tail -5`
Expected: green. Remove the now-unused `normalizeDescription` / `deterministicOverlap` locals in `chat-handler.ts` if nothing else references them (tsc `noUnusedLocals` will flag them — delete to keep the build clean).

- [ ] **Step 5: Commit**

```bash
git add src/webview/chat-handler.ts src/test/chat-handler-merge.test.ts package.json
git commit -m "feat(ai-review): collapse AI+local findings, record sources (#84)"
```

### Task C3: Apply `collapseSuggestions` on the scan paths

**Files:**
- Modify: `src/scan-results.ts` — `buildLocalScanResults` (~line 471) and `buildRemoteScanResults` (~line 491)

- [ ] **Step 1: Write the failing test**

Append to `src/test/scan-results.test.ts`:

```ts
run("buildLocalScanResults collapses a local finding that duplicates an aggressive one", () => {
  // Two same-type findings on the same endpoint should not both survive.
  const calls: ApiCallInput[] = [{
    file: "src/b.ts", line: 8, method: "GET", url: "https://api.openai.com/v1/models",
    library: "openai", provider: "openai", frequency: "per-request", frequencyClass: "polling",
  }];
  const findings: LocalWasteFinding[] = [{
    id: "f1", type: "n_plus_one", severity: "medium", riskScore: 4, confidence: 0.8,
    description: "dup", affectedFile: "src/b.ts", line: 8, evidence: [],
  }];
  const { suggestions } = buildLocalScanResults(calls, findings, "p", "s");
  const nplus = suggestions.filter((s) => s.type === "n_plus_one" && s.affectedFiles[0] === "src/b.ts");
  assert.ok(nplus.length <= 1, "duplicate n_plus_one on same endpoint should collapse");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test:scanner 2>&1 | grep -A2 "collapses a local finding"`
Expected: FAIL (two findings survive).

- [ ] **Step 3: Apply collapse at the return of both builders**

In `buildLocalScanResults` (~line 478), wrap suggestions:
```ts
  const suggestions = collapseSuggestions(
    mergeLocalWasteFindings([], localWasteFindings, endpoints, 0, projectId, scanId)
  );
```
In `buildRemoteScanResults` (~line 501), wrap the `mergeLocalWasteFindings(...)` result the same way:
```ts
  const suggestions = collapseSuggestions(
    mergeLocalWasteFindings(
      buildAggressiveSuggestions(endpoints, tagRemoteSuggestions(remoteSuggestions)),
      localWasteFindings, endpoints, remoteSummary.totalMonthlyCost, projectId, scanId
    )
  );
```
`summary.highRiskCount` (computed from `suggestions.filter(s => s.severity === "high")`) now reflects the collapsed, re-derived set automatically.

- [ ] **Step 4: Run + benchmark**

Run: `npm run test:scanner 2>&1 | grep -A2 "collapses a local finding"` → PASS.
Run: `npm run benchmark` → record Δ. Collapsing duplicates can only *reduce* double-counted findings; confirm precision does not drop and recall holds (a real finding must survive the collapse, not vanish).

- [ ] **Step 5: Commit**

```bash
git add src/scan-results.ts src/test/scan-results.test.ts
git commit -m "feat(findings): collapse duplicate suggestions on scan paths (#84)"
```

### Task C4: "detected by N sources" badge in the UI

**Files:**
- Modify: `webview/src/types.ts` (mirror `sources` on the webview `Suggestion`)
- Modify: `webview/src/components/ResultsPage.tsx` (`SuggestionCard` header, near the confidence/source badges ~line 252-264)

- [ ] **Step 1: Mirror the field**

In `webview/src/types.ts`, add to the `Suggestion` interface: `sources?: string[];` and `costImpactUsd?: number | null;`.

- [ ] **Step 2: Render the badge**

In `ResultsPage.tsx` `SuggestionCard`, where source/confidence badges render in the header (~line 252-264), add:
```tsx
{suggestion.sources && suggestion.sources.length > 1 && (
  <span className="eco-badge" title={suggestion.sources.join(", ")}>
    detected by {suggestion.sources.length} sources
  </span>
)}
```
(Match the existing badge className/inline-style used by the adjacent confidence/source badges so it visually fits.)

- [ ] **Step 3: Build**

Run: `npm run build:webview`
Expected: clean.

- [ ] **Step 4: Manual EDH check**

F5 the dev host; scan, then run AI review on a file where a local finding and an AI finding overlap; confirm a single card shows "detected by 2 sources". Document the observation.

- [ ] **Step 5: Commit**

```bash
git add webview/src/types.ts webview/src/components/ResultsPage.tsx
git commit -m "feat(webview): 'detected by N sources' badge (#84)"
```

---

## Group V — Verification & docs

### Task V1: Full gate + benchmark baseline + docs

- [ ] **Step 1: Full build**

Run: `npm run build`
Expected: dashboard + webview + extension all clean.

- [ ] **Step 2: Full scanner suite**

Run: `npm run test:scanner`
Expected: every test PASS, including the 2 new files.

- [ ] **Step 3: Benchmark, with a deliberate baseline decision**

Run: `npm run benchmark`
Expected: per-type finding precision Δ ≥ 0 on sampled types; recall ≥ baseline. If #112 improved cache/batch recall (fewer comment-suppressed false negatives), update the baseline intentionally: `node dist-test/benchmark/runner.js --update-baseline` and note the new numbers in the commit. **Do not blindly update — only if the Δ is an understood improvement.**

- [ ] **Step 4: Update the calibration + progress docs**

In `docs/accuracy/findings.md`: tick C2 acceptance boxes (collapse, `sources`, max-confidence, AI-preferred description) and C3 acceptance boxes (confidence + costImpactUsd populated, severity at one place, confidence filter, cost-differentiated severity, grouping intact). Add a short note under C3 that the model is the **Hybrid floor+amplifier**, not the literal `confidence × cost`, and why (benchmark-safety + free-endpoint visibility).
In `docs/superpowers/plans/PROGRESS.md`: flip Wave 1 (#84/#85/#112) to 🟢 and append an Activity Log line.

- [ ] **Step 5: Manual EDH acceptance pass (the criteria that can't be unit-tested)**

F5 the dev host and confirm: (a) confidence filter hides low-confidence findings and severity groups recompute; (b) an expensive-endpoint finding outranks an identical-type free-endpoint finding (different severity buckets); (c) overlapping AI+local finding shows one card with "detected by 2 sources". Document each.

- [ ] **Step 6: Commit + push**

```bash
git add docs/accuracy/findings.md docs/superpowers/plans/PROGRESS.md benchmark/baseline.json
git commit -m "docs(accuracy): mark Wave 1 findings-quality complete (#84/#85/#112)"
git push -u origin claude/superpowers-plugins-skills-1Yaij
```

---

## Self-Review

**1. Spec coverage:**
- #112 (tighten guards) → Group A. ✔
- #85 acceptance: every finding has confidence (already) + costImpactUsd → B4/B5; severity at one place → `deriveSeverity` (B3) applied B4/C1; confidence filter hides low-confidence → B6; same-type/different-cost → different severity → B3 test + `deriveSeverity` amplifier; grouping still works → B4 (severity stays `high|medium|low`; ResultsPage groups unchanged). ✔
- #84 acceptance: same type+endpoint collapse → C1/C3; `sources` lists both → C1 union + B4/C2 init; confidence = max → C1; description prefers AI → C1 `SOURCE_DESCRIPTION_RANK`. ✔

**2. Placeholder scan:** No "TODO/handle edge cases" steps; every code step shows code. The one IIFE-vs-hoist choice in B4 Step 4 is an explicit either/or with both forms equivalent, not a gap.

**3. Type consistency:** `deriveSeverity(SeveritySignals)`, `computeCostImpact(number, string|undefined)`, `SEVERITY_TO_RISK_SCORE`, `collapseSuggestions(Suggestion[])`, `riskScore` on `LocalWasteFinding`, `sources`/`costImpactUsd` on `Suggestion` + `FindingNode` — names used identically across B3, B4, C1, C2, C3. `mergeAiSuggestions` keeps its `{merged, added, filtered}` return shape so its caller at `chat-handler.ts:543` is unchanged.

**4. Risk notes for the implementer:**
- B2 touches 11 emission sites — tsc's required-field check on `LocalWasteFinding.riskScore` is the safety net; if a site is missed the build fails loudly.
- The benchmark gate is the real arbiter for #112 and the severity change. Run it after A, after B4, and after C3 — not just at the end.
- `noUnusedLocals` will flag the dead `normalizeDescription`/`deterministicOverlap` in `chat-handler.ts` after C2 — delete them (don't leave a `_`-renamed stub).
