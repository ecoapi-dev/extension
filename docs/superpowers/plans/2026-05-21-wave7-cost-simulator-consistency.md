# Wave 7 — Cost/Simulator Consistency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close [#92](https://github.com/recost-dev/extension/issues/92) and [#93](https://github.com/recost-dev/extension/issues/93) as design-resolved by labeling extension cost numbers as static-analysis estimates and pointing users at the dashboard for authoritative figures. Zero behavioral change.

**Architecture:** Three buckets of work: (1) UI — extract the existing `EstimateDisclaimer` into a shared component, refine its copy, render it on the Simulate tab. (2) Code comments — header comments on `LOCAL_PRICING` and `FREQUENCY_CLASS_MULTIPLIERS` explaining the two-layer model. (3) Docs — short CLAUDE.md section + issue closure comments.

**Tech Stack:** React 18 webview (esbuild), TypeScript strict mode, existing CSS-in-JS inline-style pattern.

**Spec:** `docs/superpowers/specs/2026-05-21-wave7-cost-simulator-consistency-design.md`

---

## File Structure

**New:**
- `webview/src/components/EstimateDisclaimer.tsx` — exports `ESTIMATE_DISCLAIMER` (string constant) and `EstimateDisclaimer` (React component). ~30 lines. Single responsibility: render the static-analysis disclaimer banner.

**Modified:**
- `webview/src/components/ResultsPage.tsx` — delete the local `ESTIMATE_DISCLAIMER` constant (line 12) and `EstimateDisclaimer` function (lines 14-29), import from the new module. No render-site change (still rendered at line 684).
- `webview/src/components/SimulatePage.tsx` — import the shared component, render it at the top of the scroll container around line 396.
- `src/intelligence/cost-utils.ts` — add a 3-line header comment immediately above `LOCAL_PRICING` (line 6).
- `src/simulator/engine.ts` — add a 3-line header comment immediately above `FREQUENCY_CLASS_MULTIPLIERS` (line 17). The existing line 12-15 comment becomes the body of the new comment block.
- `CLAUDE.md` — add a new "Cost numbers: heuristic vs authoritative" subsection under "Architecture Notes".

**Branch:** `wave7/cost-simulator-labeling` (branched from `main`).

---

## Task 1: Branch + worktree setup

**Files:** None (git state only).

- [ ] **Step 1: Confirm you are on main and up to date**

Run:
```bash
git status
git pull --ff-only
```
Expected: `On branch main`, `Your branch is up to date with 'origin/main'`. No uncommitted tracked changes. (The untracked `docs/superpowers/wave7-brainstorm-progress.md` is fine to leave alone.)

- [ ] **Step 2: Create and check out the wave branch**

Run:
```bash
git checkout -b wave7/cost-simulator-labeling
```
Expected: `Switched to a new branch 'wave7/cost-simulator-labeling'`.

---

## Task 2: Create the shared `EstimateDisclaimer` module

**Files:**
- Create: `webview/src/components/EstimateDisclaimer.tsx`

- [ ] **Step 1: Create the file**

Write `webview/src/components/EstimateDisclaimer.tsx` with this exact content:

```tsx
export const ESTIMATE_DISCLAIMER =
  "Static-analysis estimates based on code patterns. The ReCost dashboard shows runtime-measured costs from production.";

export function EstimateDisclaimer() {
  return (
    <div
      style={{
        padding: "8px 12px",
        borderBottom: "1px solid var(--vscode-panel-border)",
        background:
          "color-mix(in srgb, var(--vscode-editorInfo-foreground, var(--vscode-textLink-foreground)) 8%, var(--vscode-editor-background))",
        color: "var(--vscode-descriptionForeground)",
        fontSize: "11px",
        lineHeight: 1.4,
      }}
    >
      {ESTIMATE_DISCLAIMER}
    </div>
  );
}
```

(Style values are copy-pasted verbatim from the existing `ResultsPage.tsx:14-29` so visual output is identical.)

- [ ] **Step 2: Confirm TypeScript compiles**

Run:
```bash
npm run build:webview
```
Expected: build succeeds (no type errors). New file is bundled.

- [ ] **Step 3: Commit**

```bash
git add webview/src/components/EstimateDisclaimer.tsx
git commit -m "feat(wave7): extract EstimateDisclaimer into shared component"
```

---

## Task 3: Update `ResultsPage.tsx` to import shared component

**Files:**
- Modify: `webview/src/components/ResultsPage.tsx:12-29`

- [ ] **Step 1: Read the current top-of-file imports**

Run:
```bash
sed -n '1,15p' webview/src/components/ResultsPage.tsx
```
Expected output starts with `import` lines and shows the existing `const ESTIMATE_DISCLAIMER` at line 12.

- [ ] **Step 2: Remove the local definition and add the import**

Edit `webview/src/components/ResultsPage.tsx`:

Delete lines 12-29 (the existing `ESTIMATE_DISCLAIMER` constant + `EstimateDisclaimer` function). Add this import alongside other webview-component imports near the top of the file (find the block of `import` statements that reference relative paths like `./Markdown` and add it there):

```tsx
import { EstimateDisclaimer } from "./EstimateDisclaimer";
```

Result: no other change in this file. The render site at the original line 684 (`<EstimateDisclaimer />`) keeps working unchanged because the imported component has the same name.

- [ ] **Step 3: Confirm build still works**

Run:
```bash
npm run build:webview
```
Expected: build succeeds. No "ESTIMATE_DISCLAIMER is not defined" or similar.

- [ ] **Step 4: Grep to confirm no orphan references**

Run:
```bash
grep -n "ESTIMATE_DISCLAIMER\|EstimateDisclaimer" webview/src/components/ResultsPage.tsx
```
Expected: exactly two matches — the import line and the `<EstimateDisclaimer />` render site.

- [ ] **Step 5: Commit**

```bash
git add webview/src/components/ResultsPage.tsx
git commit -m "refactor(wave7): import EstimateDisclaimer from shared module"
```

---

## Task 4: Render `EstimateDisclaimer` at top of Simulate tab

**Files:**
- Modify: `webview/src/components/SimulatePage.tsx` (add import + one render line near line 396)

- [ ] **Step 1: Read the current SimulatePage render root**

Run:
```bash
sed -n '386,400p' webview/src/components/SimulatePage.tsx
```
Expected: shows `return (`, the outer wrapper `<div>`, then `<div className="eco-scroll-invisible" style={{ flex: 1, overflowY: "auto", padding: "10px 12px" }}>` followed by `{/* Mode toggle */}`.

- [ ] **Step 2: Add the import**

Edit `webview/src/components/SimulatePage.tsx`:

Find the existing import block at the top of the file. Add this line alongside the other relative-path imports:

```tsx
import { EstimateDisclaimer } from "./EstimateDisclaimer";
```

- [ ] **Step 3: Render the disclaimer inside the scroll container**

In the same file, find the `<div className="eco-scroll-invisible"` (around line 396). Change:

```tsx
      <div className="eco-scroll-invisible" style={{ flex: 1, overflowY: "auto", padding: "10px 12px" }}>

        {/* Mode toggle */}
```

to:

```tsx
      <div className="eco-scroll-invisible" style={{ flex: 1, overflowY: "auto", padding: "10px 12px" }}>
        <div style={{ margin: "-10px -12px 10px" }}>
          <EstimateDisclaimer />
        </div>

        {/* Mode toggle */}
```

(The wrapping `<div>` with negative margins counteracts the parent's `padding: "10px 12px"` so the disclaimer banner spans the full width of the panel, matching how it renders in `ResultsPage.tsx`.)

- [ ] **Step 4: Build and confirm no errors**

Run:
```bash
npm run build:webview
```
Expected: succeeds.

- [ ] **Step 5: Commit**

```bash
git add webview/src/components/SimulatePage.tsx
git commit -m "feat(wave7): render EstimateDisclaimer at top of Simulate tab"
```

---

## Task 5: Header comment on `LOCAL_PRICING`

**Files:**
- Modify: `src/intelligence/cost-utils.ts:1-6`

- [ ] **Step 1: Read current top of file**

Run:
```bash
sed -n '1,10p' src/intelligence/cost-utils.ts
```
Expected: shows existing license / header (if any) followed by `const LOCAL_PRICING: Record<string, number> = {`.

- [ ] **Step 2: Add comment immediately above `LOCAL_PRICING`**

Insert these three lines on the line directly preceding `const LOCAL_PRICING`:

```ts
// Static fallback pricing for providers without fingerprints. Intentionally not
// synced from the backend — extension cost numbers are heuristics, not authoritative.
// Use runtime telemetry on the ReCost dashboard for real cost.
```

Do not touch any other lines in the file. Do not change the pricing values.

- [ ] **Step 3: Type-check**

Run:
```bash
npm run build:ext
```
Expected: build succeeds.

- [ ] **Step 4: Commit**

```bash
git add src/intelligence/cost-utils.ts
git commit -m "docs(wave7): document LOCAL_PRICING is static by design"
```

---

## Task 6: Header comment on `FREQUENCY_CLASS_MULTIPLIERS`

**Files:**
- Modify: `src/simulator/engine.ts:12-22`

- [ ] **Step 1: Read current header**

Run:
```bash
sed -n '10,25p' src/simulator/engine.ts
```
Expected: shows existing comment lines 12-15 ("Default call-volume multipliers..." etc.) followed by `const FREQUENCY_CLASS_MULTIPLIERS = {` and the seven entries.

- [ ] **Step 2: Replace existing comment block with the expanded one**

Replace lines 12-15 (the existing `/* ... */` or `//` block immediately above `FREQUENCY_CLASS_MULTIPLIERS`) with:

```ts
// Relative scaling multipliers applied on top of user-configured call volume.
// These differ from the api-side analysis-service constants by design — the
// API computes absolute calls/day from runtime telemetry; the simulator applies
// relative scaling to user inputs. Both are correct for their context; do not
// reconcile. See CLAUDE.md "Cost numbers: heuristic vs authoritative."
```

Leave the `FREQUENCY_CLASS_MULTIPLIERS` body unchanged.

- [ ] **Step 3: Type-check**

Run:
```bash
npm run build:ext
```
Expected: build succeeds.

- [ ] **Step 4: Commit**

```bash
git add src/simulator/engine.ts
git commit -m "docs(wave7): document FREQUENCY_CLASS_MULTIPLIERS diverges from API by design"
```

---

## Task 7: CLAUDE.md "Cost numbers" section

**Files:**
- Modify: `CLAUDE.md` (add subsection under "Architecture Notes")

- [ ] **Step 1: Locate the insertion point**

Run:
```bash
grep -n "^### \|^## Architecture Notes\|^## VSCode Settings" CLAUDE.md
```
Expected: shows the line number of `## Architecture Notes`, every `###` subsection below it (the existing AST Parsing Engine, Local-Only Data Flow, Auth / API Key System, Cost Estimation, Cost Simulator, Sidebar UI sections), and `## VSCode Settings` (which marks the end of Architecture Notes).

- [ ] **Step 2: Add the new subsection**

Insert this block immediately before the `## VSCode Settings` line so it sits at the end of the "Architecture Notes" group:

```markdown
### Cost numbers: heuristic vs authoritative

Two layers compute cost numbers and they are intentionally not reconciled:

- **Authoritative** (API + runtime middleware): fingerprint-based pricing + real telemetry. Source of truth, surfaced on the ReCost dashboard.
- **Heuristic** (extension static scan): `LOCAL_PRICING` in `src/intelligence/cost-utils.ts` + `FREQUENCY_CLASS_MULTIPLIERS` in `src/simulator/engine.ts`. Estimates for risk surfacing and scale projection inside the editor; never expected to match the API exactly.

Do not refactor the extension to consume API constants or sync `LOCAL_PRICING`. The webview's `EstimateDisclaimer` banner labels the numbers as estimates and points users at the dashboard for real cost.

```

(Include the blank line at the end so it doesn't run into `## VSCode Settings`.)

- [ ] **Step 3: Confirm Markdown structure**

Run:
```bash
grep -A 0 "^### Cost numbers" CLAUDE.md
```
Expected: exactly one match for the new header.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(wave7): add 'Cost numbers: heuristic vs authoritative' section"
```

---

## Task 8: Full build verification

**Files:** none — just runs the build script.

- [ ] **Step 1: Run the full build**

Run:
```bash
npm run build
```
Expected: dashboard + webview + extension all build cleanly. No TypeScript errors. No esbuild warnings about missing imports.

- [ ] **Step 2: Run the test suite**

Run:
```bash
npm test
```
Expected: all existing tests pass. (No new tests were added; this confirms nothing regressed.)

- [ ] **Step 3: Run the D1 benchmark gate locally (optional but recommended)**

Run:
```bash
npm run benchmark
```
Expected: all five metrics match `benchmark/baseline.json` within the tolerance (no precision/recall change). If `npm run benchmark` is not a defined script, run the benchmark per `benchmark/README.md`.

- [ ] **Step 4: Manual EDH verification**

Press F5 in VS Code (or run `bash scripts/start-extension.sh`) to launch the Extension Development Host. In the dev host:

1. Open a workspace with at least one API call (the `extension-benchmark` repo works).
2. Run a scan.
3. Open the ReCost sidebar.
4. On the Findings tab, confirm the disclaimer banner at the top reads the new copy: "Static-analysis estimates based on code patterns. The ReCost dashboard shows runtime-measured costs from production."
5. Switch to the Endpoints subtab; same banner visible.
6. Switch to the Simulate tab; banner is now visible at the top of that tab too (full-width, same styling).
7. Switch to the Chat tab; banner is NOT shown (Chat is a different tree).

If any step fails, fix and re-verify before moving on.

---

## Task 9: Open PR, close #92 and #93

**Files:** none — git/gh actions.

- [ ] **Step 1: Push the branch**

Run:
```bash
git push -u origin wave7/cost-simulator-labeling
```
Expected: branch published.

- [ ] **Step 2: Open the PR**

Run:
```bash
gh pr create --title "wave7: cost/simulator consistency via labeling, not reconciliation" --body "$(cat <<'EOF'
## Summary

Closes #92 and #93 as design-resolved. Extension cost numbers are static-analysis heuristics; the API + runtime telemetry are authoritative. This PR labels the extension numbers as estimates and points users at the dashboard — it does not reconcile constants.

- Extract `EstimateDisclaimer` into a shared component; refine copy to name the dashboard explicitly.
- Render the disclaimer on the Simulate tab (previously only Results).
- Header comments on `LOCAL_PRICING` and `FREQUENCY_CLASS_MULTIPLIERS` explaining the two-layer model.
- New `CLAUDE.md` subsection: "Cost numbers: heuristic vs authoritative".

Zero behavioral change. No new tests required (no new code paths). D1 baseline untouched.

Spec: `docs/superpowers/specs/2026-05-21-wave7-cost-simulator-consistency-design.md`
Plan: `docs/superpowers/plans/2026-05-21-wave7-cost-simulator-consistency.md`

## Test plan

- [ ] `npm run build` succeeds
- [ ] `npm test` passes
- [ ] D1 benchmark gate passes (no baseline change)
- [ ] EDH: disclaimer copy updated on Findings + Endpoints tabs
- [ ] EDH: disclaimer now visible on Simulate tab
- [ ] EDH: disclaimer NOT shown on Chat tab

Closes #92
Closes #93

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```
Expected: gh prints the PR URL.

- [ ] **Step 3: After PR is merged, post the issue-closure comments**

If `Closes #92 / Closes #93` in the PR body auto-closed the issues, post the explanatory comment after the auto-close. If they did not auto-close, close them manually with the comment.

For #92:
```bash
gh issue comment 92 --body "Closed as design-resolved by Wave 7 (#<PR>). The extension's \`LOCAL_PRICING\` fallback is intentionally static — extension cost figures are heuristics for risk surfacing, not authoritative numbers. Authoritative cost comes from runtime telemetry on the dashboard. See \`src/intelligence/cost-utils.ts\` header comment and CLAUDE.md \"Cost numbers: heuristic vs authoritative.\""
```

For #93:
```bash
gh issue comment 93 --body "Closed as design-resolved by Wave 7 (#<PR>). Extension simulator multipliers (relative) and api-side analysis-service constants (absolute calls/day) serve different purposes and are not reconciled. The simulator projects scale relative to user-configured volume; the API computes absolute load from real telemetry. See \`src/simulator/engine.ts\` header comment and CLAUDE.md \"Cost numbers: heuristic vs authoritative.\""
```

Replace `<PR>` with the merged PR number in each command before running.

---

## Self-review checklist (run before handing the plan to an executor)

- **Spec coverage:** Section 1 (UI labeling) → Tasks 2-4; Section 2 (code comments) → Tasks 5-6; Section 3 (CLAUDE.md) → Task 7; Section 4 (issue closure) → Task 9 step 3. ✓
- **Placeholder scan:** No "TBD", no "implement later". `<PR>` token in Task 9 step 3 is explicitly described as "replace with the merged PR number". ✓
- **Type consistency:** `EstimateDisclaimer` named identically across all tasks. `ESTIMATE_DISCLAIMER` constant only referenced by name in Task 2 (the file that exports it); no other task touches the constant. ✓
- **Build commands consistent with `package.json`:** `npm run build`, `npm run build:webview`, `npm run build:ext`, `npm test`, `npm run benchmark` all match scripts documented in CLAUDE.md. ✓
