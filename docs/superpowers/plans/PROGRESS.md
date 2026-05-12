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
| **B1** Span-based source locations | [#80](https://github.com/recost-dev/extension/issues/80) | 🟡 | [2026-05-12-b1-span-based-source-locations.md](2026-05-12-b1-span-based-source-locations.md) |
| **B3** Stable endpoint IDs | [#82](https://github.com/recost-dev/extension/issues/82) | ⬜ | [2026-05-12-b3-stable-endpoint-ids.md](2026-05-12-b3-stable-endpoint-ids.md) |
| **A4** AST↔regex parity | [#76](https://github.com/recost-dev/extension/issues/76) | ⬜ | [2026-05-12-a4-ast-regex-parity.md](2026-05-12-a4-ast-regex-parity.md) |

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
| C  | Serial (manual UI) | T10 | ⬜ |
| V  | Serial (verification) | T11 | ⬜ |

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
- [ ] **T10** (C) Reveal-by-span in IPC + webview (manual EDH verification)
- [ ] **T11** (V) Acceptance verification + roadmap doc update

---

## B3 — Stable Endpoint IDs (#82)

### Batches

| Batch | Mode | Tasks | Status |
|---|---|---|---|
| A  | Parallel (2 agents) | T1, T2 | ⬜ |
| F1 | Foundation, serial | T3 | ⬜ |
| F2 | Foundation, serial | T4 | ⬜ |
| B  | Parallel (2 agents) | T5, T6 | ⬜ |
| C  | Serial (manual UI) | T7 | ⬜ |
| D  | Serial | T8 | ⬜ |
| V  | Serial (verification) | T9 | ⬜ |

### Tasks

- [ ] **T1** (A) URL template masker — `src/scanner/url-template.ts` + test
- [ ] **T2** (A) Enclosing-function-name extractor — `src/ast/enclosing-function.ts` + test
- [ ] **T3** (F1) `computeEndpointId` — `src/scanner/endpoint-id.ts` + test
- [ ] **T4** (F2) Emit `enclosingFunction` from AST scanner; add to `ApiCallInput`
- [ ] **T5** (B) Use `computeEndpointId` in `intelligence/builder.ts`
- [ ] **T6** (B) Use `computeEndpointId` in `scan-results.ts`
- [ ] **T7** (C) Migrate persisted state in `webview-provider.ts` (manual EDH verification)
- [ ] **T8** (D) Stability test against a real refactor — extends `endpoint-id.test.ts`
- [ ] **T9** (V) Acceptance verification + roadmap doc update

---

## A4 — AST↔Regex Parity (#76)

### Batches

| Batch | Mode | Tasks | Status |
|---|---|---|---|
| F1 | Foundation, serial | T1 | ⬜ |
| A  | Parallel (7 agents) | T2 (×4 fixtures), T3 (×3 fixtures) | ⬜ |
| F2 | Foundation, serial | T4 | ⬜ |
| T  | Iterative serial (triage) | T5 | ⬜ |
| V  | Serial (verification) | T6 | ⬜ |

### Tasks

- [ ] **T1** (F1) Runner library + empty allowlist — `src/test/parity.ts` + `docs/accuracy/PARITY.md`
- [ ] **T2** (A) Basic agreement fixtures — 4 files, one parallel agent per file
  - [ ] T2a `openai-basic.ts`
  - [ ] T2b `anthropic-basic.ts`
  - [ ] T2c `stripe-basic.ts`
  - [ ] T2d `fetch-known-host.ts`
- [ ] **T3** (A) Documented-divergence fixtures — 3 files, one parallel agent per file
  - [ ] T3a `wrapped-call.ts`
  - [ ] T3b `object-literal-only.ts`
  - [ ] T3c `python-requests.py`
- [ ] **T4** (F2) Test entry point + npm wiring — `src/test/parity.test.ts`
- [ ] **T5** (T) Triage and resolve each divergence (iterative — divergence list filled in below as discovered)
  - Divergence backlog (filled at runtime):
    - _none yet — populated after first run of T4_
- [ ] **T6** (V) Acceptance verification + roadmap doc update

---

## Cross-Plan Notes

- **B1 ships first** because B3's enclosing-function detection benefits from spans (not strictly required, but it's how the test fixtures get easier to write).
- **B3 ships before A4** because stable IDs make the parity test's same-call-different-line assertions meaningful in the future.
- **D1 (benchmark corpus) is the next plan after these three.** Track separately when written.

## Activity Log

> Append `YYYY-MM-DD HH:MM — <one-line update>`. Newest at top.

- 2026-05-12 03:25 — B1 batch B complete: `ApiCallNode` gains required-nullable `span: SourceSpan | null` and `intelligence/builder.ts` populates it via `call.span ?? null` (T8, `9003f4d`); `scan-results.ts` propagates `span: call.span` at all 3 callSites construction sites (T9, `afc8f1b`). Both worktree-isolated dispatches landed directly on the working branch (same as Batch A); files disjoint, declared order preserved (T8 → T9).
- 2026-05-12 03:15 — B1 batch F4 complete: `core-scanner.ts` now threads `span` through both scan paths (T7, `282f1b8`). AST path forwards `match.span` from `AstCallMatch`; regex path computes a line-wide span (col 0 → `line.length`) — true call-tight regex spans require a `matchLine` API change that's out of scope per plan.
- 2026-05-12 03:10 — B1 batch F3 complete: `AstCallMatch.span` now required and populated at all 10 emit sites in `ast-scanner.ts` (T4, `c346867`). Five test fixtures fixed up to satisfy the new required field: `python-waste-detector.test.ts` (`901e5ae`) and `ast-{batch,cache,concurrency,cross-file-resolver}-detector.test.ts` (`6cbc4a7`, which also added pre-existing missing `confidence: 1` to the four detector helpers). All five test files now build clean and pass. Span-related tsc is fully clean.
- 2026-05-12 02:50 — B1 batch A complete: span field threaded through `CallInfo` (T3, merge of `worktree-agent-adbafd374ffba4dac`), regex match types (T5, `1db3d79`), and `ApiCallInput`/`EndpointCallSite` (T6, `94fc288`). T5 and T6 committed directly onto the working branch instead of in isolated worktrees — files are disjoint so order is preserved. Reviewer scope reduced to per-task tsc + targeted test runs.
- 2026-05-12 02:50 — **Baseline state note:** `origin/main` has 38 pre-existing tsc errors (`compression.test.ts`, `export.test.ts`, `ast-{batch,cache,concurrency,cross-file-resolver}.test.ts`, `recost-mock-calls.ts` missing SDK types, `webview-provider.ts` Promise<CompressedCluster[]> mismatch). These predate the foundation plans and are fixed by the unmerged `audit-fixes-2026-05-11` branch (notably commit `329720d fix(callers): await compressClusters …`). Because `npm test` short-circuits at tsc, the plan's "full suite green between merges" gate is replaced with per-task targeted verification until those fixes land in main. Zero new tsc errors introduced by this batch.
- 2026-05-12 02:35 — B1 batch F2 complete: SourceSpan helper tests landed (`881b918`, 3/3 cases pass). Spec + code-quality review passed with zero issues.
- 2026-05-12 02:30 — B1 batch F1 complete: SourceSpan type + helpers landed on `foundation-parser-accuracy` (commits `bdfe45d`, `7e3187f`). Spec + code-quality review passed; reviewer's Important note on exclusive-end semantics addressed inline.
- 2026-05-12 — Plans drafted, parallel batches and safety rules baked in, progress tracker initialized.
