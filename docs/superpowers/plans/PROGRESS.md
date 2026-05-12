# Foundation Roadmap — Progress Tracker

Tracks execution of the three foundation plans for the parser-accuracy roadmap (issues #80, #82, #76). Order per `docs/accuracy/README.md`: B1 → B3 → A4 → D1 (D1 is a separate later plan).

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

## Activity Log

> Append `YYYY-MM-DD HH:MM — <one-line update>`. Newest at top.

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
