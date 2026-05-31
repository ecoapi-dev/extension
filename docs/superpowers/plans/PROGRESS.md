# Extension — Progress Tracker

Two trackers in one file:
1. **Foundation Roadmap** — original parser-accuracy plans (B1, B3, A4, D1). Historical; all complete.
2. **Wave Roadmap** — the 10-wave structure that organizes all remaining open work (post-foundation). This is the active tracker for new sessions.

**Update protocol:** check the box (`- [x]`) when a task is **merged into the working branch and reviewed (spec + code quality)**. Update the **Status** column of the batch table when every task in that batch is checked. Append a one-line entry to the **Activity Log** at the bottom for each batch transition or notable decision.

## Status Legend

| Symbol | Meaning |
|---|---|
| ⬜ | Not started |
| 🟡 | In progress (at least one task started, batch not complete) |
| 🟢 | Complete and merged |
| 🔴 | Blocked — see Activity Log for the reason |
| ⏭️ | Skipped or deferred — see Activity Log |

## Overall Status

| Plan | Issue | Status | Plan File |
|---|---|---|---|
| **B1** Span-based source locations | [#80](https://github.com/recost-dev/extension/issues/80) | 🟡 (code complete; manual EDH check pending on T10) | [2026-05-12-b1-span-based-source-locations.md](2026-05-12-b1-span-based-source-locations.md) |
| **B3** Stable endpoint IDs | [#82](https://github.com/recost-dev/extension/issues/82) | 🟡 (code complete; T7 awaits manual EDH check) | [2026-05-12-b3-stable-endpoint-ids.md](2026-05-12-b3-stable-endpoint-ids.md) |
| **A4** AST↔regex parity | [#76](https://github.com/recost-dev/extension/issues/76) | ✅ | [2026-05-12-a4-ast-regex-parity.md](2026-05-12-a4-ast-regex-parity.md) |

---

## B1 — Span-Based Source Locations (#80)

### Batches

| Batch | Mode | Tasks | Status |
|---|---|---|---|
| F1 | Foundation, serial | T1 | 🟢 |
| F2 | Foundation, serial | T2 | 🟢 |
| A  | Parallel (3 agents) | T3, T5, T6 | 🟢 |
| F3 | Foundation, serial | T4 | 🟢 |
| F4 | Foundation, serial | T7 | 🟢 |
| B  | Parallel (2 agents) | T8, T9 | 🟢 |
| C  | Serial (manual UI) | T10 | 🟡 |
| V  | Serial (verification) | T11 | 🟡 |

### Tasks

- [x] **T1** (F1) Define the `SourceSpan` type — `src/scanner/source-span.ts`
- [x] **T2** (F2) Test the regex-side span helper — `src/test/source-span.test.ts`
- [x] **T3** (A) Add `span` to `CallInfo` (AST visitor) — `src/ast/call-visitor.ts`
- [x] **T4** (F3) Add `span` to `AstCallMatch`, propagate through `ast-scanner.ts`
- [x] **T5** (A) Add optional `span` to regex match types — `src/scanner/patterns/types.ts`
- [x] **T6** (A) Add `span` to `ApiCallInput` and `EndpointCallSite` — `src/analysis/types.ts`
- [x] **T7** (F4) Compute spans in `core-scanner.ts` for both paths
- [x] **T8** (B) Add `span` to `ApiCallNode` + pipe through `intelligence/builder.ts`
- [x] **T9** (B) Pipe `span` into `EndpointCallSite` in `scan-results.ts`
- [~] **T10** (C) Reveal-by-span in IPC + webview (code landed `69ca79d`; **manual EDH verification pending**)
- [~] **T11** (V) Acceptance verification + roadmap doc update (3 of 4 acceptance criteria automated-verified `371fd8e`; criterion #3 awaits manual EDH check)

---

## B3 — Stable Endpoint IDs (#82)

### Batches

| Batch | Mode | Tasks | Status |
|---|---|---|---|
| A  | Parallel (2 agents) | T1, T2 | 🟢 |
| F1 | Foundation, serial | T3 | 🟢 |
| F2 | Foundation, serial | T4 | 🟢 |
| B  | Parallel (2 agents) | T5, T6 | 🟢 |
| C  | Serial (manual UI) | T7 | 🟡 (code complete; manual EDH check pending) |
| D  | Serial | T8 | 🟢 |
| V  | Serial (verification) | T9 | 🟢 (automated-verified; #5 awaits manual EDH per T7) |

### Tasks

- [x] **T1** (A) URL template masker — `src/scanner/url-template.ts` + test
- [x] **T2** (A) Enclosing-function-name extractor — `src/ast/enclosing-function.ts` + test
- [x] **T3** (F1) `computeEndpointId` — `src/scanner/endpoint-id.ts` + test (reuses `normalizeRepoPath` from `intelligence/path-utils`)
- [x] **T4** (F2) Emit `enclosingFunction` from AST scanner; add to `ApiCallInput` (9 emit sites updated, 5 test fixture files patched)
- [x] **T5** (B) Use `computeEndpointId` in `intelligence/builder.ts` (with `_L<line>` collision fallback)
- [x] **T6** (B) Use `computeEndpointId` in `scan-results.ts` (Set-based collision check)
- [~] **T7** (C) Migrate persisted state in `webview-provider.ts` — code landed; scope expanded to cover the parallel synthetic-ID minter at the second emit site spotted by T6 review. **Manual EDH verification pending** — F5 dev host, save a simulator scenario, edit an unrelated file, re-scan, confirm scenario still loads.
- [x] **T8** (D) Stability test against a real refactor — extends `endpoint-id.test.ts` (13 cases total)
- [x] **T9** (V) Acceptance verification + roadmap doc update (`docs/accuracy/traceability.md` § B3 marked Landed)

---

## A4 — AST↔Regex Parity (#76)

### Batches

| Batch | Mode | Tasks | Status |
|---|---|---|---|
| F1 | Foundation, serial | T1 | ✅ |
| A  | Parallel (7 agents) | T2 (×4 fixtures), T3 (×3 fixtures) | ✅ |
| F2 | Foundation, serial | T4 | ✅ |
| T  | Iterative serial (triage) | T5 | ✅ |
| V  | Serial (verification) | T6 | ✅ |

### Tasks

- [x] **T1** (F1) Runner library + empty allowlist — `src/test/parity.ts` + `docs/accuracy/PARITY.md` (`c18c8c8`)
- [x] **T2** (A) Basic agreement fixtures — 4 files
  - [x] T2a `openai-basic.ts`
  - [x] T2b `anthropic-basic.ts`
  - [x] T2c `stripe-basic.ts`
  - [x] T2d `fetch-known-host.ts`
- [x] **T3** (A) Documented-divergence fixtures — 3 files
  - [x] T3a `wrapped-call.ts`
  - [x] T3b `object-literal-only.ts`
  - [x] T3c `python-requests.py`
- [x] **T4** (F2) Test entry point + npm wiring — `src/test/parity.test.ts` + `package.json` (`36a3601`)
- [x] **T5** (T) Triage and resolve each divergence — single batched fix (host attribution + multi-line fallback drop) collapsed both surfaced divergences (`91fc235`); two structural multi-line cases documented in `PARITY.md` (`e6f2062`).
  - Divergence backlog (final):
    - fetch-known-host.ts L2 disagreement → root-caused to generic-http hardcoding `provider: "generic-http"` + wrong-method GET fallback for multi-line options. Fix in `generic-http.ts` (host lookup + tighter no-options pattern). Remaining AST-only allowlisted (multi-line method on subsequent line).
    - python-requests.py L4 AST-only → multi-line `requests.post(` with URL on the next line; regex is line-based by design. Allowlisted with structural reason.
- [x] **T6** (V) Acceptance verification + roadmap doc update — all 3 criteria in `docs/accuracy/detection.md` § A4 now `[x]`.

---

## Cross-Plan Notes

- **B1 ships first** because B3's enclosing-function detection benefits from spans (not strictly required, but it's how the test fixtures get easier to write).
- **B3 ships before A4** because stable IDs make the parity test's same-call-different-line assertions meaningful in the future.
- **D1 (benchmark corpus) is the next plan after these three.** Track separately when written.

---

# Wave Roadmap — Progress Tracker

Post-foundation work organized into 10 waves + 2 standalones, tracked via `wave/*` + `area/*` GitHub labels. **Execution order is severity-weighted** (platform issues outrank accuracy): Wave 9 → 6 → 7 → 8 → 10 → standalones → accuracy waves (5 → 3 → 1 → 2 → 4).

**As of 2026-05-29:** all platform waves (6–10) are SHIPPED, plus accuracy Waves 3, 5, and 1. Remaining open work: accuracy waves **2 → 4** + Wave 3 follow-ups #127/#128 + standalones #45/#52.

## Overall Wave Status

| Wave | Topic | Issues | Status | Notes |
|---|---|---|---|---|
| **9** | Local-mode IPC architecture | #91, #99 | 🟢 | Closed docs-only via PR #120. Decision: extension does not host WS server; SDKs move to NDJSON file transport. |
| **6** | Scan submission fidelity | #95, #96 | 🟢 | Both halves shipped: `recost-dev/api#40` (span persistence) + `extension#121` (unknown-provider retention). |
| **7** | Cost/simulator consistency | #92, #93 | 🟢 | Shipped via PR [#122](https://github.com/recost-dev/extension/pull/122). Labels extension numbers as estimates; doesn't reconcile constants. |
| **8** | Status/error UX | #46, #94, #100 | 🟢 | Shipped via PR [#123](https://github.com/recost-dev/extension/pull/123). |
| **10** | Config hygiene | #97, #98 | 🟢 | Shipped via PR [#124](https://github.com/recost-dev/extension/pull/124). |
| — | Standalone #45 | #45 | ⬜ | Opt-in Project ID persistence — independent feature. |
| — | Standalone #52 | #52 | ⬜ | Dashboard theming — can defer indefinitely. |
| **5** | Housekeeping (accuracy) | #118, #119 | 🟢 | Both closed 2026-05-27 (benchmark runner sort + D1 CI gate verified). |
| **3** | Resolver follow-ups (accuracy) | #114, #115, #116 | 🟢 | Shipped via PR [#126](https://github.com/recost-dev/extension/pull/126). Follow-ups #127 (detection threading) + #128 (dashboard badge) landed on `feat/wave3-followups`. |
| **1** | Findings quality (accuracy) | #84, #85, #112 | 🟢 | All closed 2026-05-28 (C2 dedupe, C3 confidence, CACHE/BATCH_GUARD tightening). |
| **2** | Traceability (accuracy) | #81, #113 | 🟡 | B2 dual locations (#81) code-complete on `claude/recent-pr-explanation-C7Xcw`. #113 corpus fixtures blocked (extension-benchmark repo). |
| **4** | Recall recovery (accuracy) | #117 | ⬜ | Risky — depended on Wave 3 (#116), now unblocked. |

## Wave 9 — Local-mode IPC architecture (CLOSED)

| Issue | Status |
|---|---|
| #91 — Extension local WS server doesn't exist (CRITICAL) | 🟢 Closed by PR #120 (docs-only) |
| #99 — Local-mode WS protocol has no version field | 🟢 Closed by PR #120 (subsumed) |

**Decision:** Extension does not build a WS server. SDKs (`recost-dev/middleware-node#37`, `recost-dev/middleware-python#38`) switching local-mode default to NDJSON file at `~/.recost/local-telemetry/${projectId}.jsonl` with top-level `protocolVersion: "1.0"`.

## Wave 6 — Scan submission fidelity (SHIPPED)

| Issue | Status |
|---|---|
| #95 — span field dropped at API submission | 🟢 Closed by `recost-dev/api#40` |
| #96 — silent filtering of unknown-provider calls | 🟢 Closed by `extension#121` |

**Latent bug surfaced (not yet filed):** `detectEndpointProvider(url)` in `src/scanner/endpoint-classification.ts:59` returns hostname-as-fallback instead of `undefined`, making `provider ?? detectEndpointProvider(url) ?? "unknown"` patterns have dead `?? "unknown"` branches everywhere. See `memory/wave6_status.md`.

## Wave 7 — Cost/simulator consistency (SHIPPED)

| Issue | Status |
|---|---|
| #92 — pricing sync may not flow into local cost estimation | 🟢 Closed by PR #122 |
| #93 — frequency-class multipliers diverge | 🟢 Closed by PR #122 |

**Framing:** Two layers compute cost — authoritative (API + telemetry) and heuristic (extension static scan). Reconciliation was rejected; PR added labeling + code comments + CLAUDE.md section saying these are intentionally divergent.

## Wave 8 — Status/error UX (SHIPPED)

| Issue | Status |
|---|---|
| #46 — valid-key indicator finicky | 🟢 Closed by PR #123 |
| #94 — `validateRcApiKey()` treats 404 as "valid in dev mode" (HIGH) | 🟢 Closed by PR #123 |
| #100 — 429 not surfaced distinctly in extension UI | 🟢 Closed by PR #123 |

## Wave 10 — Config hygiene (SHIPPED)

| Issue | Status |
|---|---|
| #97 — hard-coded base URLs scattered | 🟢 Closed by PR #124 |
| #98 — `local-${Date.now()}` scanId 1ms collision | 🟢 Closed by PR #124 |

## Wave 3 — Resolver follow-ups (SHIPPED)

| Issue | Status |
|---|---|
| #114 — A3 default-import context threading in `resolveExportedMatches` | 🟢 Closed by PR #126 |
| #115 — A5 factory-with-arguments in `extractFactoryCallAssignments` | 🟢 Closed by PR #126 |
| #116 — narrow `images.generate` to `inlineParallelCapable` flag | 🟢 Closed by PR #126 |

**Build:** subagent-driven across two file-disjoint parallel worktree tracks (resolver #114/#115 · detector #116), per-track spec + code-quality review, final whole-impl review (READY TO MERGE). Gates: full `test:scanner` green (4 new tests), `build:ext` clean, benchmark Δ +0.00pp on all 5 metrics.

**Spec/Plan:** `docs/superpowers/specs/2026-05-27-wave3-resolver-followups-design.md` · `docs/superpowers/plans/2026-05-27-wave3-resolver-followups.md`

**Post-merge follow-ups:** #127 (thread `inlineParallelCapable` through regex pattern path + dedup + intelligence graph), #128 (dashboard endpoint badge — restores indicator DALL·E lost when reclassified off `batchCapable`).

## Accuracy waves (deprioritized vs platform)

| Wave | Issues |
|---|---|
| 5 Housekeeping | #118 sort findingMetricsByType, #119 verify D1 CI gate |
| 3 Resolver follow-ups | #114 A3 default-import, #115 A5 factory-with-args, #116 narrow images.generate batchCapable |
| 1 Findings quality | #84 C2 dedupe, #85 C3 confidence everywhere, #112 tighten CACHE_GUARD/BATCH_GUARD |
| 2 Traceability | #81 B2 dual locations, #113 barrel+factory corpus fixtures |
| 4 Recall recovery | #117 — depends on Wave 3 #116 |

## Standalones (no wave)

- **#45** — Extension opt-in Project ID persistence
- **#52** — Web dashboard theming (defer indefinitely)

## How to pick up next session

1. Run `gh issue list --state open --limit 50` to confirm the wave labels haven't shifted.
2. Check this file's "Overall Wave Status" table — first ⬜ wave by execution order is next.
3. Read the relevant issues with `gh issue view <N>`.
4. Invoke `superpowers:brainstorming` if the wave needs a fresh spec; otherwise `superpowers:executing-plans` if a plan already exists.
5. Update the Status column here when status changes (⬜ → 🟡 → 🟢) and append to the Activity Log.

## Activity Log

> Append `YYYY-MM-DD HH:MM — <one-line update>`. Newest at top.

- 2026-05-30 — **Wave 2 / B2 (#81) code-complete.** `CallTrace { callSite, resolvedSite, hops }` threaded `AstCallMatch.trace` → `ApiCallInput.callTrace` → `EndpointCallSite.callTrace` + `ApiCallNode.callTrace` (new shared type `src/scanner/call-trace.ts` + `directTrace()` degenerate fallback). Cross-file resolver populates the trace for propagated/middleware/factory matches (relative-path resolved); direct calls get `hops=0` via `directTrace` at the three `scan-results.ts` call-site sites. Webview Endpoints view (`ResultsPage.tsx`) now offers the user's call site by default + a "↳ underlying call" link when `hops > 0` (resolved SDK site); `webview/src/types.ts` mirrors `CallTrace`. AC-4 satisfied by B3 design (computeEndpointId excludes positions) + `endpoint-id.test.ts` regression; hash deliberately not re-keyed on resolvedSite.file (would collapse callers / risk benchmark). Subagent-driven (8 impl tasks, per-commit spec/scope verification; Task 4's out-of-scope `isHighConfidenceEndpointUrl` change caught + reverted). Gates: `npm run build` clean, `npm run test:scanner` exit 0 (7 new B2 cases green). **Pending:** manual EDH (dual click targets); CI benchmark (Δ expected +0.00pp — additive metadata, fixtures not accessible locally); #113 corpus fixtures (blocked — extension-benchmark repo). Plan: `docs/superpowers/plans/2026-05-30-wave2-b2-dual-locations.md`.
- 2026-05-29 — **Wave 3 follow-ups #127 + #128 landed** on `feat/wave3-followups`. #127 (`a1972bf`): threaded `inlineParallelCapable` through the regex pattern path (`openai-compatible.ts` emit, registry-only), the regex-only `local-waste-detector.ts` (new inline-parallel finding with the n/count suggestion, distinct `inline_parallel` id), the pattern dedup key (`utils.ts`), and the intelligence graph (`ApiCallNode` + `builder.ts`). #128 (`e9d7d7e`): `EndpointRecord` in both UI type files + `Endpoints.tsx` inline-parallel chip + `scan-results.ts` population at all 3 endpoint-construction sites — restores the indicator DALL·E lost when #116 reclassified `images.generate` off `batchCapable`. Gates: full `test:scanner` green (3 new tests), `build` (webview+ext) clean, benchmark Δ +0.00pp on all 5 metrics. **Caveat:** the web dashboard reads endpoints from the API, whose schema has no `inline_parallel` column — dashboard chip needs an api-repo migration to light up; VS Code webview badge works now. Next: accuracy Wave 2 (#113 → #81).
- 2026-05-29 — **Tracker reconciliation.** Waves 5 (#118/#119, closed 05-27) and 1 (#84/#85/#112, closed 05-28) marked 🟢 — both had merged but were never reflected here. Remaining accuracy work is now Wave 2 → 4.
- 2026-05-28 — **Wave 1 (findings quality) code-complete** on `claude/superpowers-plugins-skills-1Yaij` (plan `docs/superpowers/plans/2026-05-28-wave1-findings-quality.md`). #112: comment-stripped guard window stops the `CACHE_GUARD`/`BATCH_GUARD` literal-word leak (URL-safe `//` lookbehind). #85: detectors carry a structural `riskScore`; single `deriveSeverity()` (hybrid floor+amplifier, not pure confidence×cost) + `computeCostImpact()` applied at all 5 `Suggestion`-construction sites; `costImpactUsd` internal-only; confidence filter in the sidebar. #84: `collapseSuggestions()` dedupes by `type::file::endpoint|line-bucket`, unions `sources`, max confidence, AI-preferred description; `mergeAiSuggestions` collapses instead of dropping; "detected by N sources" badge. Subagent-driven (impl + spec + code-quality review per unit). Gates: full `test:scanner` green, full benchmark Δ +0.00pp on all 5 metrics. **Pending:** (1) manual EDH check of the two UI bits; (2) follow-ups — pre-existing `scope === "internal"` guard divergence between the two `buildAggressiveSuggestions` copies (scan-results.ts lacks it), and dead `SourceBadge` + duplicated badge inline-style in `ResultsPage.tsx` (extract a shared secondary-badge).
- 2026-05-27 — **Wave 3 shipped (PR #126)** — #114/#115/#116 closed. Subagent-driven across 2 parallel worktree tracks; gates green (test:scanner, build:ext, benchmark Δ +0.00pp). Follow-ups filed: #127 (detection threading) + #128 (dashboard badge). **Tracker reconciliation:** also corrected stale statuses — Waves 7 (PR #122), 8 (PR #123), and 10 (PR #124) had merged earlier but were never marked 🟢 here. All platform waves (6–10) now confirmed shipped; remaining work is accuracy waves 5→1→2→4 + standalones.
- 2026-05-21 — **Wave 7 PR opened (#122).** Closes #92 + #93 as design-resolved via labeling, not reconciliation. 7 commits on `wave7/cost-simulator-labeling` (worktree `../extension-wave7`): shared `EstimateDisclaimer` component, render on Simulate tab, code comments on `LOCAL_PRICING` + `FREQUENCY_CLASS_MULTIPLIERS`, CLAUDE.md "Cost numbers: heuristic vs authoritative" section. All gates green (build, 4/4 tests, D1 Δ +0.00pp). Spec + plan committed to main. Wave 8 (#46/#94/#100) is next per severity order.
- 2026-05-15 — **Wave 9 closed docs-only via PR #120**, **Wave 6 shipped** (api#40 + extension#121). Both detailed in `memory/wave9_local_mode_resolution.md` and `memory/wave6_status.md`.
- 2026-05-13 to 2026-05-15 — **C1 calibration shipped** across PRs #106 (per-detector measurement) → #108 (cache tightening) → #109 (batch tightening) → #110 (A3/A5 resolver recall) → #111 (rate_limit + residual batch). Finding precision 9.09% → 100%, recall held. Closes #83.
- 2026-05-13 — **A6/A2/A7 detection fixes merged** (#102, #103, #104), corpus bumped (#105), **A1 multi-hop wrappers** opened (#107). See `memory/detection_fixes_shipped_2026_05_13.md`.
- 2026-05-12 05:30 — A4 **shipped**. F1 (`c18c8c8` runner + empty allowlist), Batch A (`11c65e4` all 7 fixtures landed via parallel controller-driven writes; serial-fallback commit form chosen over per-agent worktrees because each fixture is a single verbatim Write and the worktree overhead would have dominated wall-time), F2 (`36a3601` test entry + npm wiring + fixture-dir source-tree resolution fix — plan's `__dirname/fixtures/parity` resolved to dist-test/test/fixtures, fixed to `../../src/test/fixtures/parity` since tsc excludes fixtures from compilation). First parity run surfaced 2 divergences. Triage (`91fc235`): both shared a root cause — `generic-http.ts` hardcoded `provider: "generic-http"` even with known hosts, and the fetch fallback regex emitted GET for multi-line option objects. Fix: reuse `lookupHost()` for host-based provider attribution + tighten fallback regex to require closing paren on the same line. After fix, both divergences collapsed to AST-only-multi-line cases (`e6f2062` allowlisted with structural reasons). V criteria all met; CI invocation confirmed (`.github/workflows/test.yml` → `npm test` → `test:scanner` → `parity.test.js`).
- 2026-05-12 04:30 — B3 **code complete** across all 9 tasks. Batch A (T1 url-template `fba4295`, T2 enclosing-function `a81fd02`) ran via parallel worktrees with controller merge in declared order; T2 follow-up `a8f2be2` added destructure-binding clarifier comment + nested-function test per code-quality review. F1 (T3 `694dc30` + follow-up `d6b0feb` switched to `normalizeRepoPath` from `intelligence/path-utils`, removing a divergent local re-implementation flagged by code-quality review). F2 (T4 `4799fcc` emit at 9 AST scanner sites + 5 fixture updates; follow-up `b9e54be` documented the asymmetric `enclosingFunction` field and the 7d override semantics). Batch B (T5 builder `7cea7b8`, T6 scan-results `2e6b3a8`) again via parallel worktrees; T6 reviewer spotted a second `local-${scanId}` minter in `webview-provider.ts` and an O(n²) collision-check spread — both addressed (`e8a8fee` Set-based collision check, then folded the second emit site into T7's commit `0c7c707`). T7 (C) added `pruneSavedScenariosAgainst` invoked on both local-only and remote-enriched scan completion paths; `6b8828b` added a zero-endpoint guard preventing silent destruction of saved scenarios on empty/misconfigured scans. T8 (D) appended 2 end-to-end stability tests (`977e4f4`). T9 (V) automated 4 of 5 acceptance criteria across `url-template.test.ts`, `enclosing-function.test.ts`, `endpoint-id.test.ts` (13 cases); criterion #5 (saved scenarios survive non-structural changes) is code-complete but **awaits manual EDH verification per T7 Step 4** — F5 the dev host, save a simulator scenario, edit an unrelated file, re-scan, confirm the scenario still loads.
- 2026-05-12 03:50 — B1 **code complete**. T10 (`69ca79d`) extended `openFile` IPC with `span?` field; `webview-provider.ts` handler builds `vscode.Range` from span when present (falls back to line cursor); `ResultsPage.tsx` sends `site?.span`; webview-side `SourceSpan` mirror added to `webview/src/types.ts` for typecheck. T11 (`371fd8e`) updated `docs/accuracy/traceability.md` § B1 — 3/4 acceptance criteria automated-verified (span field present, multi-line endLine>startLine, line back-compat). **Criterion #3 (full-call selection on click) requires manual EDH verification** — F5 the dev host, run a scan on a workspace with a multi-line `await openai.chat.completions.create({...})`, click that endpoint, confirm the selection covers from `await` through the closing `)`.
- 2026-05-12 03:25 — B1 batch B complete: `ApiCallNode` gains required-nullable `span: SourceSpan | null` and `intelligence/builder.ts` populates it via `call.span ?? null` (T8, `9003f4d`); `scan-results.ts` propagates `span: call.span` at all 3 callSites construction sites (T9, `afc8f1b`). Both worktree-isolated dispatches landed directly on the working branch (same as Batch A); files disjoint, declared order preserved (T8 → T9).
- 2026-05-12 03:15 — B1 batch F4 complete: `core-scanner.ts` now threads `span` through both scan paths (T7, `282f1b8`). AST path forwards `match.span` from `AstCallMatch`; regex path computes a line-wide span (col 0 → `line.length`) — true call-tight regex spans require a `matchLine` API change that's out of scope per plan.
- 2026-05-12 03:10 — B1 batch F3 complete: `AstCallMatch.span` now required and populated at all 10 emit sites in `ast-scanner.ts` (T4, `c346867`). Five test fixtures fixed up to satisfy the new required field: `python-waste-detector.test.ts` (`901e5ae`) and `ast-{batch,cache,concurrency,cross-file-resolver}-detector.test.ts` (`6cbc4a7`, which also added pre-existing missing `confidence: 1` to the four detector helpers). All five test files now build clean and pass. Span-related tsc is fully clean.
- 2026-05-12 02:50 — B1 batch A complete: span field threaded through `CallInfo` (T3, merge of `worktree-agent-adbafd374ffba4dac`), regex match types (T5, `1db3d79`), and `ApiCallInput`/`EndpointCallSite` (T6, `94fc288`). T5 and T6 committed directly onto the working branch instead of in isolated worktrees — files are disjoint so order is preserved. Reviewer scope reduced to per-task tsc + targeted test runs.
- 2026-05-12 02:50 — **Baseline state note:** `origin/main` has 38 pre-existing tsc errors (`compression.test.ts`, `export.test.ts`, `ast-{batch,cache,concurrency,cross-file-resolver}.test.ts`, `recost-mock-calls.ts` missing SDK types, `webview-provider.ts` Promise<CompressedCluster[]> mismatch). These predate the foundation plans and are fixed by the unmerged `audit-fixes-2026-05-11` branch (notably commit `329720d fix(callers): await compressClusters …`). Because `npm test` short-circuits at tsc, the plan's "full suite green between merges" gate is replaced with per-task targeted verification until those fixes land in main. Zero new tsc errors introduced by this batch.
- 2026-05-12 02:35 — B1 batch F2 complete: SourceSpan helper tests landed (`881b918`, 3/3 cases pass). Spec + code-quality review passed with zero issues.
- 2026-05-12 02:30 — B1 batch F1 complete: SourceSpan type + helpers landed on `foundation-parser-accuracy` (commits `bdfe45d`, `7e3187f`). Spec + code-quality review passed; reviewer's Important note on exclusive-end semantics addressed inline.
- 2026-05-12 — Plans drafted, parallel batches and safety rules baked in, progress tracker initialized.
