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

Three locations get a consistent affordance signaling the number is a static-analysis estimate.

#### 1a. Sidebar — Endpoints subtab (`webview/src/components/ResultsPage.tsx`)

- Per-endpoint monthly cost figures get a `~` prefix (e.g. `~$0.04 / mo`).
- A single footer line below the endpoint list:
  > Cost figures are static-analysis estimates. The dashboard shows runtime-measured costs.

#### 1b. Sidebar — Findings subtab (`webview/src/components/ResultsPage.tsx`)

- Per-suggestion estimated savings get the same `~` prefix.
- No separate footer (the Endpoints footer is enough — Findings is in the same tab).

#### 1c. Sidebar — Simulate tab (`webview/src/components/SimulatePage.tsx`)

- Header subtitle (existing or new) reads:
  > Projection based on static-analysis estimates. Compare against runtime numbers on the dashboard for real cost.

No tooltips, no badges, no icons. Just the `~` prefix where a number appears and the footer / subtitle line. Minimal visual change.

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
  intelligence/cost-utils.ts        # + header comment on LOCAL_PRICING
  simulator/engine.ts               # + header comment on FREQUENCY_CLASS_MULTIPLIERS
webview/src/components/
  ResultsPage.tsx                   # + ~ prefix on cost / savings figures, + footer line
  SimulatePage.tsx                  # + header subtitle line
CLAUDE.md                           # + "Cost numbers: heuristic vs authoritative" section
```

No new files. No new tests. No new dependencies.

## Testing

The wave introduces no behavioral changes, so no new automated tests are required.

Manual verification:

1. Run a workspace scan in the Extension Development Host.
2. Open the sidebar.
3. Endpoints subtab: confirm each monthly cost figure starts with `~` and the footer line is present below the list.
4. Findings subtab: confirm each estimated-savings figure starts with `~`.
5. Simulate tab: confirm the header subtitle line is present.
6. D1 benchmark gate must continue to pass (no scanner / detector behavior changed; baseline.json untouched).

## Risk + rollback

Risk is cosmetic only — copy and a `~` prefix. Rollback is a revert of one commit.

The only non-obvious risk: the `~` prefix might collide with existing formatting in `format.ts` if a cost is already prefixed. Audit `formatCost()` and `formatCostRange()` (`dashboard/src/lib/format.ts`) and the webview's local cost formatter before applying — these utilities may already produce ranges (`$0.02–$0.07`) and a leading `~` should sit outside the range, not inside.

## Out of scope (filed as follow-ups if discovered during implementation)

- Sidebar scan cost using `callsPerDay=1` (already noted in wave7-brainstorm-progress.md). If the labeling work reveals this is more confusing than expected, file a separate issue — do not expand this wave.
- Removing the duplicated `shouldSubmitRemote` / `canonicalizeEndpointUrl` between `scan-results.ts` and `scan-publishing-handler.ts:311` (noted in `memory/wave6_status.md`). Independent housekeeping.
