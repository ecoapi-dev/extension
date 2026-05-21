# Wave 7 — Cost / Simulator Consistency (Design)

**Issues:** [#92](https://github.com/recost-dev/extension/issues/92), [#93](https://github.com/recost-dev/extension/issues/93)
**Roadmap:** `wave/7-cost-simulator-consistency`
**Date:** 2026-05-21
**Status:** Spec — pending implementation plan

## Goal

Resolve #92 and #93 without changing the extension's pricing logic or frequency-class multipliers. Both issues describe **divergence between the extension's static-analysis numbers and the API's authoritative numbers**. The right fix is to acknowledge the two-layer model explicitly in code comments, CLAUDE.md, and the webview UI — not to force one set of numbers onto the other.

This is a labeling + documentation wave. Zero behavioral changes to cost estimation or simulation.

## The two-layer model (the framing this spec codifies)

| Layer | Source of truth for | How it's computed |
|---|---|---|
| **Authoritative** (API + runtime middleware) | Real cost, real call volume, real spend | Synced fingerprints + actual runtime telemetry |
| **Heuristic** (extension static scan) | Risk surfacing, relative comparison, scale projections before deployment | Local pricing table + `frequencyClass` derived from AST signals |

Extension numbers are **estimates by design**. The simulator multipliers (relative scaling) and the API's analysis-service constants (absolute calls/day) serve different purposes and should not be reconciled.

## Non-goals

- **Not** syncing `LOCAL_PRICING` (`src/intelligence/cost-utils.ts:6`) from the backend. It stays static.
- **Not** changing the simulator's `FREQUENCY_CLASS_MULTIPLIERS` (`src/simulator/engine.ts:17-22`).
- **Not** changing the sidebar scan's `callsPerDay=1` behavior (`src/scan-results.ts:378`).
- **Not** touching the api repo. No cross-repo PR.
- **Not** adding a CI test that compares extension and API constants.
- **Not** adding a settings flag or feature gate.

## What changes

### 1. Webview UI — "estimate" labeling

The existing `ResultsPage.tsx` already renders an `EstimateDisclaimer` banner (line 684, above tab content — visible on both Issues and Endpoints subtabs) and uses `"Est."` prefix / `"est. savings"` suffix on cost figures. The `SimulatePage.tsx` has no equivalent disclaimer. The work is to:

#### 1a. Update the disclaimer copy

Refine `ESTIMATE_DISCLAIMER` in `webview/src/components/ResultsPage.tsx:12` to explicitly point at the dashboard as the source of authoritative cost:

> Static-analysis estimates based on code patterns. The ReCost dashboard shows runtime-measured costs from production.

The new copy keeps the existing "estimate" framing but names the dashboard explicitly.

#### 1b. Add the same disclaimer to Simulate tab

Hoist `EstimateDisclaimer` (and `ESTIMATE_DISCLAIMER`) into a small shared module (e.g. `webview/src/components/EstimateDisclaimer.tsx`) so both `ResultsPage.tsx` and `SimulatePage.tsx` import and render the same component. Render it at the top of `SimulatePage`'s scroll container (just inside the existing `eco-scroll-invisible` div around line 396), with the same styling.

#### 1c. No other UI changes

The Endpoints subtab does not render per-endpoint cost figures — only method/provider/url/file:line. There is nothing to prefix there. The summary `"Est. $X/mo spend"` (line 642) and suggestion `"est. savings"` (line 272) already follow the convention; leave them as-is.

No `~` prefix, no badges, no tooltips beyond what exists. Minimal visual change.

### 2. Code comments — explain the static-by-design choice

#### 2a. `src/intelligence/cost-utils.ts`

Header comment on `LOCAL_PRICING` (~3 lines):

> Static fallback pricing for providers without fingerprints. Intentionally not synced from the backend — extension cost numbers are heuristics, not authoritative figures. Use runtime telemetry (dashboard) for real cost.

#### 2b. `src/simulator/engine.ts`

Header comment on `FREQUENCY_CLASS_MULTIPLIERS` (~3 lines):

> Relative scaling multipliers applied on top of user-configured call volume. These differ from the api-side analysis-service constants by design — the API computes absolute calls/day from runtime telemetry; the simulator applies relative scaling to user inputs.

### 3. `CLAUDE.md` — two-layer model section

New short section under "Architecture Notes" (~10 lines):

> ### Cost numbers: heuristic vs authoritative
>
> Two layers compute cost numbers and they are intentionally not reconciled:
>
> - **Authoritative** (API + runtime middleware): fingerprint-based pricing + real telemetry. Source of truth, surfaced on the dashboard.
> - **Heuristic** (extension static scan): `LOCAL_PRICING` table + `FREQUENCY_CLASS_MULTIPLIERS`. Estimates for risk surfacing and scale projection; never expected to match the API exactly.
>
> Do not refactor the extension to use API constants or sync `LOCAL_PRICING`. See `cost-utils.ts` and `simulator/engine.ts` header comments.

### 4. Issue closure comments

**#92 closure comment:**

> Closed as design-resolved by Wave 7 (PR <#>). The extension's `LOCAL_PRICING` fallback is intentionally static — extension cost figures are heuristics for risk surfacing, not authoritative numbers. Authoritative cost comes from runtime telemetry on the dashboard. See `src/intelligence/cost-utils.ts` header comment and CLAUDE.md "Cost numbers: heuristic vs authoritative."

**#93 closure comment:**

> Closed as design-resolved by Wave 7 (PR <#>). Extension simulator multipliers (relative) and api-side analysis-service constants (absolute calls/day) serve different purposes and are not reconciled. The simulator projects scale relative to user-configured volume; the API computes absolute load from real telemetry. See `src/simulator/engine.ts` header comment and CLAUDE.md "Cost numbers: heuristic vs authoritative."

## Architecture (file-level summary)

```
src/
  intelligence/cost-utils.ts            # + header comment on LOCAL_PRICING
  simulator/engine.ts                   # + header comment on FREQUENCY_CLASS_MULTIPLIERS
webview/src/components/
  EstimateDisclaimer.tsx                # NEW — shared component, exports EstimateDisclaimer + ESTIMATE_DISCLAIMER
  ResultsPage.tsx                       # remove local copy, import shared component; copy refined
  SimulatePage.tsx                      # render <EstimateDisclaimer /> at top of scroll container
CLAUDE.md                               # + "Cost numbers: heuristic vs authoritative" section
```

One new file (a 30-line shared component). No new tests. No new dependencies.

## Testing

The wave introduces no behavioral changes, so no new automated tests are required.

Manual verification:

1. Run a workspace scan in the Extension Development Host.
2. Open the sidebar.
3. Findings / Endpoints subtabs: confirm the updated `EstimateDisclaimer` banner is at the top and the copy mentions the dashboard.
4. Switch to the Simulate tab: confirm the same disclaimer banner is at the top of the scroll container.
5. D1 benchmark gate must continue to pass (no scanner / detector behavior changed; baseline.json untouched).

## Risk + rollback

Risk is cosmetic only — copy refinement, one shared component, two import sites. Rollback is a revert of one commit.

There's no behavioral change to pricing, simulation, or the scanner. No data shape change. No IPC change. No test impact.

## Out of scope (filed as follow-ups if discovered during implementation)

- Sidebar scan cost using `callsPerDay=1` (already noted in wave7-brainstorm-progress.md). If the labeling work reveals this is more confusing than expected, file a separate issue — do not expand this wave.
- Removing the duplicated `shouldSubmitRemote` / `canonicalizeEndpointUrl` between `scan-results.ts` and `scan-publishing-handler.ts:311` (noted in `memory/wave6_status.md`). Independent housekeeping.
