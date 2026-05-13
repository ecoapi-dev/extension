# A6 + A2 + A7 Detection Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Three issues ship as three sequential PRs — see "Ship gates" section.

**Goal:** Ship three detection fixes (A6, A2, A7) sequentially, each measured against the D1 baseline. Improve scanner precision (currently 29.9%) and recall (currently 42.6%) with per-fix deltas visible in the gate.

**Architecture:** Three independent fixes ship as three small PRs to `main`, in order. Each PR closes one GitHub issue, bumps `benchmark/baseline.json` if measurements changed, and runs the D1 gate as part of CI. Subagent-driven-development per task: implementer subagent → spec compliance reviewer → code quality reviewer.

**Tech Stack:** TypeScript, web-tree-sitter WASM (existing), `node:assert/strict` tests, GitHub Actions.

**Spec reference:** `docs/accuracy/detection.md` (sections A6, A2, A7).

**D1 gate:** `benchmark/runner.ts` + `benchmark/baseline.json` + `.github/workflows/benchmark.yml` (all on main). Every PR runs the gate. PRs that drop any metric > 1pp fail CI.

---

## Current measured baseline (from `benchmark/baseline.json`, 2026-05-13)

| Metric | Value |
|---|---|
| Detection precision | 29.9% |
| Detection recall | 42.6% |
| Provider attribution accuracy | 79.6% |
| Finding precision | 7.1% |
| Finding recall | 33.3% |

- **A6 attacks precision** (29.9% → expected meaningful improvement). False positives from object-literal string keys + the filename-based workaround masking real calls.
- **A2 attacks recall** (42.6% → expected meaningful improvement). Template-literal URLs in `fetch`/`axios` currently produce `provider: "unknown"` and are dropped pre-submission.
- **A7 attacks provider attribution + downstream cost** (79.6% → expected modest improvement on the corpus; bigger improvement in cost numbers, which are out of D1 scope). Raw `fetch("https://api.elevenlabs.io/...")` resolves provider but not method, falls through to stub cost.

---

## Sequencing rationale

1. **A6 first.** Smallest scope (one AST predicate + workaround removal). Shrinks the FP denominator before later fixes. Lowest risk — purely a filter, no new traversal logic. If A6 misfires, the baseline regression is immediately visible.
2. **A2 second.** Depends on understanding what `generic-http.ts` actually produces against the corpus *after* A6's filename-based excludes are gone. Constant-folding is the harder change; we want a clean baseline before tackling it.
3. **A7 third.** Depends on A2's output. The URLs A2 newly surfaces (previously dropped as `unknown`) are exactly the raw-`fetch` calls A7's URL-path matcher needs. Shipping A2 before A7 means A7's improvement is measurable against the corpus.

Each PR is small (one fix, scoped tests, baseline bump). No bundling. Reviewers can attribute deltas to specific fixes.

## Branch + ship strategy

| Phase | Branch | PR target | Closes |
|---|---|---|---|
| A6 | `claude/a6-object-literal-fps` | main | #78 |
| A2 | `claude/a2-const-url-folding` | main | #74 |
| A7 | `claude/a7-url-path-method-fallback` | main | #79 |

Each branch is created from `main` **after** the previous phase's PR has been merged. The controller (you) dispatches the next phase only when:
- Previous PR is merged into main
- D1 gate is green on the merged commit
- Baseline numbers committed (if changed)

No worktrees needed — phases are sequential. The implementer agent works directly on the branch.

---

## Phase A6 — Filter object-literal false positives (issue #78)

**Goal:** AST scanner stops emitting matches for method-chain strings that appear as object-literal keys (or other non-call positions). Remove the filename-based workaround in `file-discovery.ts:48-59`.

**Files (verified to exist on main, 2026-05-13):**
- `src/ast/call-visitor.ts` — has `collectCalls()` that emits real `call_expression` nodes only (lines 88-130). The actual FP source needs to be discovered in Task A6.0.
- `src/scanner/file-discovery.ts:48-60` — has 12 filename-based ignore patterns (`**/pricing.ts`, `**/pricing.js`, `**/pricing.tsx`, `**/costs.ts`, `**/costs.js`, `**/rates.ts`, `**/rates.js`, `**/api-config.ts`, `**/api-config.js`, `**/provider-config.ts`, `**/provider-config.js`, `**/api-pricing.ts`, `**/api-pricing.js`)
- `.recostignore` — currently empty
- Existing fixture for `stripe-sample` in `extension-benchmark` was explicitly designed to exercise A6 (config files with method-chain keys)

### Task A6.0: Investigate where the FPs actually originate

The issue body for #78 says "In `call-visitor.ts`, walk parent nodes before emitting a match." But `collectCalls()` already only emits for `call_expression` nodes — by definition real calls. The FPs must come from:
- Regex patterns in `src/scanner/patterns/*` that match call-like strings inside object literals, OR
- A code path inside `ast-scanner.ts` that consumes call info and emits findings for adjacent string literals, OR
- A real but unexpected AST shape in tree-sitter (e.g. some object property syntaxes parse as `call_expression`)

**Files:** none modified. Read-only investigation.

- [ ] **Step 1: Create a failing-test fixture**

Create `src/test/fixtures/a6/pricing-config.ts`:

```ts
// Data-only file. NO call should be detected here.
export const METHOD_PRICING = {
  openai: {
    "chat.completions.create": { costModel: "per_token", inputPricePer1M: 0.15 },
    "embeddings.create": { costModel: "per_token", inputPricePer1M: 0.02 },
  },
  stripe: {
    "charges.create": { costModel: "per_transaction", fixedFee: 0.30 },
  },
};
```

Create `src/test/fixtures/a6/service.ts`:

```ts
import OpenAI from "openai";
const client = new OpenAI();

export async function ask(prompt: string): Promise<string> {
  const r = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
  });
  return r.choices[0]?.message.content ?? "";
}
```

The expected behavior: scan `src/test/fixtures/a6/` produces ONE detection (from `service.ts:5`), NOT three (the data file should be silent).

- [ ] **Step 2: Run the live scanner against the fixture and observe**

```bash
npm run build:ext
node dist/cli/scan.js src/test/fixtures/a6 --format json
```

Read the JSON output. Confirm how many endpoints are emitted and from which files. **This is the test that fails today.** Capture the actual output as the baseline of the bug.

- [ ] **Step 3: Trace which code emitted each FP**

For each spurious detection from `pricing-config.ts`:
- Note its `methodSignature`, `library` (i.e. which pattern/SDK), `callSites[0].file:line`
- Use that to identify which scanner emitted it: AST-side (look in `ast-scanner.ts` around the methodChain match) or regex-side (find the matching pattern in `src/scanner/patterns/<sdk>.ts`)
- Document the source in a comment block (the spec-reviewer will check this)

This investigation determines whether the fix lives in `call-visitor.ts` (per issue text) OR in one of the regex patterns. **Both are valid.** The acceptance criterion is no FPs from the data file, not a specific code path.

If the issue's `call-visitor.ts` claim is wrong, file a follow-up note in the PR description but proceed with whichever fix actually works.

### Task A6.1: Add the parent-walk predicate (TDD)

**Files:**
- Modify: `src/ast/call-visitor.ts` (if FPs are AST-side) OR `src/scanner/patterns/<sdk>.ts` (if regex-side) — depends on Task A6.0 findings
- Modify: `src/scanner/file-discovery.ts` — remove lines 48-60 workarounds
- Create: `src/test/fixtures/a6/pricing-config.ts` (already created in A6.0)
- Create: `src/test/fixtures/a6/service.ts` (already created in A6.0)
- Create: `src/test/a6-object-literal-fps.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/test/a6-object-literal-fps.test.ts`:

```ts
import assert from "node:assert/strict";
import * as path from "node:path";
import { scanWorkspace } from "../scanner/workspace-scanner";
import { realFilesystemAdapter } from "../cli/filesystem-adapter";

async function run(name: string, fn: () => void | Promise<void>): Promise<void> {
  try { await fn(); console.log(`PASS ${name}`); }
  catch (err) { console.error(`FAIL ${name}`); throw err; }
}

(async () => {
  const fixtureDir = path.resolve(__dirname, "fixtures", "a6");

  await run("data file with method-chain string keys produces zero detections", async () => {
    const result = await scanWorkspace(realFilesystemAdapter(fixtureDir), {
      includeGlobs: ["pricing-config.ts"],
      excludeGlobs: [],
    });
    const fromDataFile = result.endpoints.filter(
      (e) => e.callSites.some((cs) => cs.file.endsWith("pricing-config.ts"))
    );
    assert.equal(fromDataFile.length, 0, `expected 0 detections from pricing-config.ts, got ${fromDataFile.length}: ${JSON.stringify(fromDataFile.map(e => ({ method: e.methodSignature, line: e.callSites[0]?.line })))}`);
  });

  await run("real service.ts call is still detected", async () => {
    const result = await scanWorkspace(realFilesystemAdapter(fixtureDir), {
      includeGlobs: ["service.ts"],
      excludeGlobs: [],
    });
    const openaiCalls = result.endpoints.filter((e) => e.provider === "openai");
    assert.ok(openaiCalls.length >= 1, `expected at least 1 openai detection in service.ts, got ${openaiCalls.length}`);
    const hasChatComplete = openaiCalls.some(
      (e) => e.methodSignature?.includes("chat.completions.create") || e.method?.includes("chat.completions.create")
    );
    assert.ok(hasChatComplete, "expected chat.completions.create method on detection");
  });

  await run("filename-based workaround patterns are removed", () => {
    const fdSource = require("node:fs").readFileSync(
      path.resolve(__dirname, "..", "scanner", "file-discovery.ts"),
      "utf8"
    );
    const bannedPatterns = ["pricing.ts", "costs.ts", "rates.ts", "api-config.ts", "provider-config.ts", "api-pricing.ts"];
    for (const p of bannedPatterns) {
      assert.ok(
        !fdSource.includes(`"**/${p}"`),
        `file-discovery.ts still contains filename-based workaround for ${p}`
      );
    }
  });
})().catch((err) => { console.error(err); process.exit(1); });
```

NOTE: the exact import paths may need adjusting based on actual API of `scanWorkspace`/`realFilesystemAdapter`. Verify the signatures before running — the scanner CLI uses these so the shape is real. If the API differs, adjust the test wrapper but keep the assertions intact.

- [ ] **Step 2: Wire test into `package.json` test script**

Append to the `test:scanner` script:

```
&& node dist-test/src/test/a6-object-literal-fps.test.js
```

(Verify the compiled path with `tsc -p tsconfig.scanner-tests.json && ls dist-test/src/test/`.)

- [ ] **Step 3: Run test, watch it fail**

```bash
npm test 2>&1 | grep -E "(PASS|FAIL).*a6"
```

Expected: at least the "zero detections from pricing-config.ts" test fails because the scanner currently emits something. **Capture the actual count** to confirm the bug reproduces.

- [ ] **Step 4: Apply the fix based on Task A6.0's findings**

**If AST-side (most likely per issue text):** Add a parent-walk predicate in `collectCalls()`. After `if (node.type === "call_expression" || node.type === "call")`, before recursing, verify the call_expression is NOT a child of an object literal. But — `call_expression` nodes by AST definition are already in call positions; they cannot syntactically appear as object keys. So the more likely root cause is that the tree-sitter parser is generating a `call_expression` node for something unusual (e.g. a tagged template, a call inside a value of an object literal — which IS a real call and should be detected).

If AST-side and the cause is REAL call expressions inside object literal *values* (e.g. `{ foo: bar() }`), that's NOT a false positive — those are real calls. The fix is different and may need a re-read of the issue.

**If regex-side:** Tighten the regex to require a trailing `(` or other call-context marker. E.g., for openai-compatible.ts's `OPENAI_ACTION_REGEX`, the existing regex already requires `\s*\(`. Check provider patterns that might not. Add a negative-lookbehind or check for surrounding quote characters.

**Implementation sketch for AST parent-walk (canonical approach from spec):**

```ts
function isInsideCallExpressionContext(node: SyntaxNode): boolean {
  // The node IS already a call_expression. Walk up parents:
  // - If we hit a value position inside object/array/variable: still legitimate
  //   (the call result is being assigned/stored — real call).
  // - This function only returns FALSE if the call_expression has been somehow
  //   emitted from a string-key position, which shouldn't happen syntactically.
  // The expected fix is to find WHERE in the scanner we accept a string-literal
  // chain match and add the filter there.
  let parent = node.parent;
  while (parent) {
    if (parent.type === "pair" || parent.type === "object" || parent.type === "array") {
      return true; // legitimate — call result is a value
    }
    if (parent.type === "call_expression" || parent.type === "call") {
      return true;
    }
    parent = parent.parent;
  }
  return true;
}
```

**Reality check:** The implementer will discover in A6.0 whether the issue's "parent walk in call-visitor.ts" claim is accurate. Whatever the actual mechanism, the test in Step 1 is the source of truth. Make the test pass without breaking the existing test suite.

- [ ] **Step 5: Remove the filename-based workaround**

Edit `src/scanner/file-discovery.ts`. Find the `DEFAULT_IGNORE_PATTERNS` array (around line 38-65). Remove these 12 entries:

```
"**/pricing.ts",
"**/pricing.js",
"**/pricing.tsx",
"**/costs.ts",
"**/costs.js",
"**/rates.ts",
"**/rates.js",
"**/api-config.ts",
"**/api-config.js",
"**/provider-config.ts",
"**/provider-config.js",
"**/api-pricing.ts",
"**/api-pricing.js",
```

Leave the other entries (`node_modules`, `dist`, etc.) intact.

- [ ] **Step 6: Check `.recostignore` and `api/src/config/pricing.ts`**

```bash
cat .recostignore
ls api/src/config/pricing.ts 2>/dev/null
```

`.recostignore` is empty as of 2026-05-13 (per repo state) — nothing to remove. `api/src/config/pricing.ts` may not exist in this repo (it's in a sibling `api/` repo). If it doesn't exist, skip the second part. If it does and contains exclusion of a pricing file, remove it.

- [ ] **Step 7: Run all tests + smoke benchmark**

```bash
npm test 2>&1 | grep -E "(PASS|FAIL)" | tail -30
npm run benchmark:smoke
```

Expected: all PASS lines (including the new a6 tests). Smoke benchmark still passes — it doesn't exercise pricing.ts files, so the workaround removal shouldn't affect it.

- [ ] **Step 8: Run the full benchmark to measure precision delta**

```bash
# Requires extension-benchmark cloned at ../extension-benchmark
cd /home/andresl/Projects/recost
[ -d extension-benchmark ] || git clone https://github.com/recost-dev/extension-benchmark.git
cd extension
npm run benchmark 2>&1 | tee /tmp/a6-benchmark-output.log
```

The output shows: current metrics vs baseline. Detection precision should be **higher** (fewer FPs). Recall might tick up slightly (if removing the filename workaround surfaces previously-hidden real calls in pricing-like filenames in the corpus). Record both numbers.

If precision DROPS or recall drops more than 1pp, the fix is wrong. Stop, debug.

- [ ] **Step 9: Bump baseline (only if metrics legitimately improved)**

```bash
npm run benchmark -- --update-baseline
git diff benchmark/baseline.json
```

Verify the new numbers are realistic — improvements not catastrophic shifts.

- [ ] **Step 10: Commit**

```bash
git checkout -b claude/a6-object-literal-fps
git add src/test/fixtures/a6/ src/test/a6-object-literal-fps.test.ts package.json
git add src/scanner/file-discovery.ts
# Also stage the AST or pattern file you modified:
git add <changed-scanner-file>
git add benchmark/baseline.json
git commit -m "fix(detection): A6 — drop object-literal false positives + filename workaround (closes #78)"
```

- [ ] **Step 11: Push and open PR**

```bash
git push -u origin claude/a6-object-literal-fps
gh pr create --title "A6: drop object-literal false positives + remove filename workaround (closes #78)" --body "$(cat <<'EOF'
## Summary

- Adds a fixture demonstrating method-chain string keys in an object literal (`src/test/fixtures/a6/pricing-config.ts`) — should produce zero detections.
- Fixes the actual emit site (see commit message / file change for whether it's AST or regex path).
- Removes the 12 filename-based workarounds in `src/scanner/file-discovery.ts:48-60` that were masking real calls in any file matching `pricing.{ts,js,tsx}`, `costs.{ts,js}`, `rates.{ts,js}`, `api-config.{ts,js}`, `provider-config.{ts,js}`, `api-pricing.{ts,js}`.
- Updates `benchmark/baseline.json` to reflect the measured improvement.

## D1 measurement (vs prior baseline)

| Metric | Prior | This PR | Δ (pp) |
|---|---|---|---|
| Detection precision | 29.9% | XX.XX% | +X.XX |
| Detection recall | 42.6% | XX.XX% | +X.XX |
| Provider attribution | 79.6% | XX.XX% | ±X.XX |
| Finding precision | 7.1% | XX.XX% | ±X.XX |
| Finding recall | 33.3% | XX.XX% | ±X.XX |

(Fill in the real numbers from `npm run benchmark` output.)

## Test plan

- [ ] CI `benchmark` workflow passes (no metric drops > 1pp from new baseline)
- [ ] CI `test:scanner` passes
- [ ] Manual: scan against a repo with a pricing-style config file produces zero false positives

Closes #78.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

### Phase A6 ship gate

**STOP after PR opens.** Wait for review and merge. Do NOT dispatch Phase A2 until:
1. PR is merged to main
2. CI `benchmark` workflow is green on the post-merge `main`
3. New baseline numbers are committed and visible on main

Once those three are confirmed, dispatch Phase A2.

---

## Phase A2 — Dynamic URL constant-folding for raw fetch/axios (issue #74)

**Goal:** `fetch(\`${BASE_URL}/v1/chat/completions\`)` where `const BASE_URL = "https://api.openai.com"` resolves to `provider: "openai"` instead of `unknown`.

**Scope decision:** Same-file `const STRING = "..."` substitution only. No cross-file resolution (out of v1). No `process.env.X || "default"` (out of v1; add as follow-up issue if recall is still poor after A2 ships).

**Files (verified on main, 2026-05-13):**
- `src/scanner/patterns/generic-http.ts` — has the fetch/axios/got/ky/requests regex patterns. Lines 41-66 already handle `fetch(VAR)` with `normalizeDynamic` (treats VAR as opaque dynamic). The fix replaces "treat as dynamic" with "resolve to constant if it's a same-file const".
- `src/scanner/patterns/utils.ts` — has `normalizeDynamic`. New helper goes here or in a new `constant-fold.ts`.

### Task A2.1: Build the same-file const resolver (TDD)

**Files:**
- Create: `src/scanner/constant-fold.ts`
- Create: `src/test/a2-const-fold.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/test/a2-const-fold.test.ts`:

```ts
import assert from "node:assert/strict";
import { foldStringConstants } from "../scanner/constant-fold";

async function run(name: string, fn: () => void | Promise<void>): Promise<void> {
  try { await fn(); console.log(`PASS ${name}`); }
  catch (err) { console.error(`FAIL ${name}`); throw err; }
}

(async () => {
  await run("resolves a simple const string", () => {
    const src = `const BASE = "https://api.openai.com";\nfetch(\`\${BASE}/v1/chat\`);`;
    const folded = foldStringConstants("`${BASE}/v1/chat`", src);
    assert.equal(folded, "https://api.openai.com/v1/chat");
  });

  await run("resolves with let or var", () => {
    const src = `let BASE = "https://api.x.ai";\nfetch(\`\${BASE}/path\`);`;
    const folded = foldStringConstants("`${BASE}/path`", src);
    assert.equal(folded, "https://api.x.ai/path");
  });

  await run("returns null for runtime-dependent interpolation", () => {
    const src = `fetch(\`/users/\${req.params.id}\`);`;
    const folded = foldStringConstants("`/users/${req.params.id}`", src);
    assert.equal(folded, null);
  });

  await run("returns null when const is shadowed", () => {
    // Multiple BASE definitions; we don't try to resolve scope correctly,
    // we just bail out.
    const src = `const BASE = "https://a.com"; const BASE = "https://b.com";\nfetch(\`\${BASE}/x\`);`;
    const folded = foldStringConstants("`${BASE}/x`", src);
    assert.equal(folded, null);
  });

  await run("resolves identifier-only fetch arg", () => {
    const src = `const URL = "https://api.openai.com/v1/chat";\nfetch(URL);`;
    const folded = foldStringConstants("URL", src);
    assert.equal(folded, "https://api.openai.com/v1/chat");
  });

  await run("resolves multiple interpolations", () => {
    const src = `const HOST = "https://api.openai.com";\nconst VER = "v1";\nfetch(\`\${HOST}/\${VER}/chat\`);`;
    const folded = foldStringConstants("`${HOST}/${VER}/chat`", src);
    assert.equal(folded, "https://api.openai.com/v1/chat");
  });

  await run("returns null when one interpolation is non-const", () => {
    const src = `const HOST = "https://api.openai.com";\nfetch(\`\${HOST}/\${req.path}\`);`;
    const folded = foldStringConstants("`${HOST}/${req.path}`", src);
    assert.equal(folded, null);
  });
})().catch((err) => { console.error(err); process.exit(1); });
```

- [ ] **Step 2: Implement `src/scanner/constant-fold.ts`**

```ts
/**
 * Resolve a same-file string template-literal or identifier expression to its
 * concrete string value, given the full file source.
 *
 * Scope (v1):
 *  - `const X = "literal"` (also `let X = "literal"`, `var X = "literal"`) at module level
 *  - Template literals with only static + same-file const interpolations
 *  - Bare identifier references to such consts
 *
 * Returns null when:
 *  - The expression depends on runtime values (function calls, member access, etc.)
 *  - A referenced identifier has multiple definitions in the file (we don't model scope)
 *  - A referenced identifier is not a string-literal binding
 */

const STRING_BINDING_RE = /^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::\s*[^=]+)?=\s*(['"`])([^\r\n'"`]*?)\2\s*;?\s*$/gm;

/**
 * Build a map of identifier → string-literal-value for module-level bindings
 * in `fileSource`. Identifiers with conflicting definitions are excluded from
 * the map.
 */
function buildConstMap(fileSource: string): Map<string, string> {
  const seen = new Map<string, string>();
  const ambiguous = new Set<string>();
  STRING_BINDING_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = STRING_BINDING_RE.exec(fileSource)) !== null) {
    const name = m[1];
    const value = m[3];
    if (seen.has(name) && seen.get(name) !== value) {
      ambiguous.add(name);
    } else if (!seen.has(name)) {
      seen.set(name, value);
    }
  }
  for (const name of ambiguous) seen.delete(name);
  return seen;
}

/**
 * Fold a single expression to its string value, or return null if it can't be
 * statically resolved with same-file consts.
 *
 * The expression is the raw source text of the URL argument as it appeared in
 * the fetch/axios/etc. call — could be a template literal, a quoted string,
 * or a bare identifier.
 */
export function foldStringConstants(expression: string, fileSource: string): string | null {
  const trimmed = expression.trim();

  // Already a plain string literal — strip quotes
  if (/^["'`]([^"'`]*)["'`]$/.test(trimmed)) {
    return trimmed.slice(1, -1);
  }

  const consts = buildConstMap(fileSource);

  // Bare identifier (e.g. fetch(URL))
  if (/^[A-Za-z_$][\w$]*$/.test(trimmed)) {
    return consts.get(trimmed) ?? null;
  }

  // Template literal — fold each ${...} segment
  if (trimmed.startsWith("`") && trimmed.endsWith("`")) {
    const inner = trimmed.slice(1, -1);
    const parts: string[] = [];
    let i = 0;
    while (i < inner.length) {
      if (inner[i] === "$" && inner[i + 1] === "{") {
        const end = inner.indexOf("}", i + 2);
        if (end === -1) return null;
        const exprInside = inner.slice(i + 2, end).trim();
        if (!/^[A-Za-z_$][\w$]*$/.test(exprInside)) return null; // not a bare identifier
        const value = consts.get(exprInside);
        if (value === undefined) return null;
        parts.push(value);
        i = end + 1;
      } else {
        // accumulate static segment until next ${ or end
        const nextDollar = inner.indexOf("${", i);
        const segEnd = nextDollar === -1 ? inner.length : nextDollar;
        parts.push(inner.slice(i, segEnd));
        i = segEnd;
      }
    }
    return parts.join("");
  }

  return null;
}
```

- [ ] **Step 3: Wire the new test into `package.json`**

Append:

```
&& node dist-test/src/test/a2-const-fold.test.js
```

- [ ] **Step 4: Run and verify all 7 tests pass**

```bash
npm test 2>&1 | grep -E "(PASS|FAIL).*a2"
```

Expected: 7 PASS lines.

- [ ] **Step 5: Commit the helper**

```bash
git checkout -b claude/a2-const-url-folding
git add src/scanner/constant-fold.ts src/test/a2-const-fold.test.ts package.json
git commit -m "feat(scanner): same-file string const folder (helper for A2)"
```

### Task A2.2: Wire the folder into `generic-http.ts`

**Files:**
- Modify: `src/scanner/patterns/generic-http.ts`
- Create: `src/test/fixtures/a2/dynamic-fetch.ts`
- Modify: `src/test/a2-const-fold.test.ts` (extend with integration cases)

- [ ] **Step 1: Create the integration fixture**

Create `src/test/fixtures/a2/dynamic-fetch.ts`:

```ts
const OPENAI_BASE = "https://api.openai.com";
const ANTHROPIC_BASE = "https://api.anthropic.com";

export async function chat(prompt: string) {
  const r = await fetch(`${OPENAI_BASE}/v1/chat/completions`, {
    method: "POST",
    body: JSON.stringify({ model: "gpt-4o-mini", messages: [{ role: "user", content: prompt }] }),
  });
  return r.json();
}

export async function complete(prompt: string) {
  const r = await fetch(`${ANTHROPIC_BASE}/v1/messages`, {
    method: "POST",
    body: JSON.stringify({ model: "claude-3-5-haiku-20241022", messages: [{ role: "user", content: prompt }] }),
  });
  return r.json();
}
```

Pre-A2, both `fetch` calls produce `provider: "unknown"` because the URL is a template literal. Post-A2, they should produce `provider: "openai"` and `provider: "anthropic"` respectively.

- [ ] **Step 2: Add the integration test cases**

Append to `src/test/a2-const-fold.test.ts` (before the final `process.exit`):

```ts
  await run("integration: dynamic-fetch.ts fixture resolves provider correctly", async () => {
    const path = await import("node:path");
    const { scanWorkspace } = await import("../scanner/workspace-scanner");
    const { realFilesystemAdapter } = await import("../cli/filesystem-adapter");

    const fixtureDir = path.resolve(__dirname, "fixtures", "a2");
    const result = await scanWorkspace(realFilesystemAdapter(fixtureDir), {
      includeGlobs: ["dynamic-fetch.ts"],
      excludeGlobs: [],
    });

    const providers = new Set(result.endpoints.map(e => e.provider));
    assert.ok(providers.has("openai"), `expected openai in providers; got ${[...providers].join(",")}`);
    assert.ok(providers.has("anthropic"), `expected anthropic in providers; got ${[...providers].join(",")}`);
  });
```

- [ ] **Step 3: Modify `generic-http.ts` to fold dynamic URLs**

In `src/scanner/patterns/generic-http.ts`:

1. Add an import for the folder at the top:

```ts
import { foldStringConstants } from "../constant-fold";
```

2. Find the `matchLine` function (or wherever the regex matches are processed) and locate the path where a captured URL is treated as dynamic. The current behavior is: when the matched URL is a template literal or bare identifier, `normalizeDynamic` is called and the URL/host extraction yields `unknown`.

The exact wiring depends on the file's structure. The fix:

```ts
// Pseudocode for the fix location — find the actual call site:
// BEFORE the matchLine returns a match with provider:"unknown" for a dynamic URL,
// try folding it first. The matcher has access only to one line — we need the
// full file source for folding. So foldStringConstants must be called from a
// higher layer (workspace-scanner or core-scanner).
```

**Architecture decision:** `LineMatcher` operates on a single line. Constant folding needs the full file source. So the fold happens in `core-scanner.ts` or `workspace-scanner.ts`, AFTER `LineMatcher` has produced a match with a template-literal URL.

Find the call site of `genericHttpMatcher.matchLine` (or its variant) in `src/scanner/core-scanner.ts`. After the match is produced, if `match.url` starts with `` ` `` or is a bare identifier and `match.provider === "unknown"`, call `foldStringConstants(match.url, fileSource)` and re-run the host classification (`parseHost` + `lookupHost` in `generic-http.ts` exports — make them callable from outside if they aren't already).

If `foldStringConstants` returns a string, replace `match.url` with that, re-classify, and emit the updated match.

If it returns null, leave as `unknown` (unchanged from today).

**Concrete code:** the implementer must read `core-scanner.ts` to find the right place. The fix is one new helper call inserted into the post-match pipeline.

- [ ] **Step 4: Run integration test**

```bash
npm test 2>&1 | grep -E "(PASS|FAIL).*a2"
```

All 8 PASS (7 unit + 1 integration).

- [ ] **Step 5: Run smoke + full benchmark, observe recall delta**

```bash
npm run benchmark:smoke
npm run benchmark 2>&1 | tee /tmp/a2-benchmark-output.log
```

Expected: detection recall ticks up. Precision should be stable or up (the new detections were previously dropped as `unknown`, so they don't add to FP count). If precision drops > 1pp, the fold is matching things it shouldn't — investigate.

- [ ] **Step 6: Bump baseline if metrics improved**

```bash
npm run benchmark -- --update-baseline
git diff benchmark/baseline.json
```

- [ ] **Step 7: Commit and push**

```bash
git add src/scanner/patterns/generic-http.ts src/scanner/core-scanner.ts src/test/fixtures/a2/ src/test/a2-const-fold.test.ts benchmark/baseline.json
git commit -m "fix(detection): A2 — fold same-file string consts for fetch/axios URLs (closes #74)"
git push -u origin claude/a2-const-url-folding
```

- [ ] **Step 8: Open PR**

```bash
gh pr create --title "A2: same-file const folding for dynamic fetch URLs (closes #74)" --body "$(cat <<'EOF'
## Summary

- Adds `src/scanner/constant-fold.ts` — folds template literals + bare identifiers to their concrete string values when bound to module-level string consts in the same file.
- Wires the folder into `core-scanner.ts` so that `fetch(\`\${BASE}/path\`)` is now recognized as the underlying provider when `BASE` is a local const.
- Adds fixture `src/test/fixtures/a2/dynamic-fetch.ts` exercising openai + anthropic patterns.
- Updates `benchmark/baseline.json` with the recall improvement.

## Scope (v1)

- Same-file `const`/`let`/`var X = "literal"` substitution only
- No cross-file resolution (deferred)
- No `process.env.X || "default"` (deferred)

If a referenced identifier has multiple definitions, we bail out (return null) rather than guess scope.

## D1 measurement

| Metric | Prior | This PR | Δ (pp) |
|---|---|---|---|
| Detection precision | XX.XX% | XX.XX% | ±X.XX |
| Detection recall | XX.XX% | XX.XX% | +X.XX |
| Provider attribution | XX.XX% | XX.XX% | ±X.XX |
| Finding precision | XX.XX% | XX.XX% | ±X.XX |
| Finding recall | XX.XX% | XX.XX% | ±X.XX |

## Test plan

- [ ] CI `benchmark` passes (no metric drops > 1pp from new baseline)
- [ ] CI `test:scanner` passes
- [ ] Manual: scan a repo using `\`\${BASE}/path\`` pattern with a same-file const — provider is attributed correctly

Closes #74.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

### Phase A2 ship gate

**STOP after PR opens.** Wait for review + merge + green CI on main. Then dispatch Phase A7.

---

## Phase A7 — URL-path → method fallback for raw fetch (issue #79)

**Goal:** Raw `fetch("https://api.elevenlabs.io/v1/text-to-speech/...")` resolves to `provider: "elevenlabs"` AND a real `methodSignature` (via URL-path match), enabling the fingerprint registry to look up a real cost.

**Files (verified on main, 2026-05-13):**
- `src/scanner/fingerprints/elevenlabs.json` — has `methods` array with SDK-style `pattern: "textToSpeech.convert"` keys. The new URL-path entries go alongside.
- `src/scanner/fingerprints/registry.ts` — has `lookupMethod` + `lookupHost`. May need a new `lookupByUrlPath` or extension of `lookupMethod`.
- `src/intelligence/cost-utils.ts` lines 47-78 — `estimateLocalMonthlyCost` is the consumer. After A2 + A7, when `methodSignature` is undefined but `provider` is set and URL is known, this should pick up a cost from the URL-path table instead of falling through to `LOCAL_PRICING[provider]`.

### Task A7.1: Extend the fingerprint schema with URL-path entries (TDD)

**Files:**
- Modify: `src/scanner/fingerprints/elevenlabs.json` — add 3-5 URL-path entries + a `_default`
- Modify: `src/scanner/fingerprints/types.ts` — schema may need an `urlPathKey` or accept URL-path patterns in `pattern` directly
- Create: `src/test/a7-url-path-fallback.test.ts`

- [ ] **Step 1: Inspect current fingerprint shape**

```bash
cat src/scanner/fingerprints/types.ts | head -50
cat src/scanner/fingerprints/elevenlabs.json | head -30
```

Confirm the `pattern` field's role — SDK chain only, or can it accept URL paths? Two design options:

**Option A (preferred):** Add a new optional `urlPathKey` field to fingerprint methods. `lookupMethod` keeps using `pattern` for SDK calls; a new `lookupByUrlPath(provider, url)` walks the `urlPathKey` entries and matches against `url.pathname`.

**Option B:** Allow `pattern` to start with `v1/...` and interpret it as a URL path. Simpler but mixes two semantics into one field — more brittle.

**Pick Option A.** Add `urlPathKey?: string` to the type.

- [ ] **Step 2: Write the failing test**

Create `src/test/a7-url-path-fallback.test.ts`:

```ts
import assert from "node:assert/strict";
import { lookupMethod, lookupByUrlPath } from "../scanner/fingerprints/registry";

async function run(name: string, fn: () => void | Promise<void>): Promise<void> {
  try { await fn(); console.log(`PASS ${name}`); }
  catch (err) { console.error(`FAIL ${name}`); throw err; }
}

(async () => {
  await run("lookupByUrlPath resolves elevenlabs text-to-speech URL", () => {
    const fp = lookupByUrlPath("elevenlabs", "https://api.elevenlabs.io/v1/text-to-speech/voice-id-abc/stream");
    assert.ok(fp, "expected a fingerprint match");
    assert.equal(fp!.costModel, "per_request");
  });

  await run("lookupByUrlPath returns _default for unrecognized elevenlabs path", () => {
    const fp = lookupByUrlPath("elevenlabs", "https://api.elevenlabs.io/v1/unknown/path");
    assert.ok(fp, "expected default fingerprint");
  });

  await run("lookupByUrlPath returns null for unknown provider", () => {
    const fp = lookupByUrlPath("nonexistent-provider", "https://x.example.com/path");
    assert.equal(fp, null);
  });

  await run("lookupMethod (SDK path) still works after refactor", () => {
    const fp = lookupMethod("elevenlabs", "textToSpeech.convert");
    assert.ok(fp);
    assert.equal(fp!.costModel, "per_request");
  });
})().catch((err) => { console.error(err); process.exit(1); });
```

- [ ] **Step 3: Extend `elevenlabs.json` with URL-path entries**

Edit `src/scanner/fingerprints/elevenlabs.json`. After the existing SDK-pattern methods, add:

```json
,
{
  "urlPathKey": "v1/text-to-speech",
  "httpMethod": "POST",
  "endpoint": "https://api.elevenlabs.io/v1/text-to-speech/{voice_id}",
  "costModel": "per_request",
  "perRequestCostUsd": 0.0003,
  "description": "Raw-fetch TTS path"
},
{
  "urlPathKey": "v1/speech-to-text",
  "httpMethod": "POST",
  "endpoint": "https://api.elevenlabs.io/v1/speech-to-text",
  "costModel": "per_request",
  "perRequestCostUsd": 0.00006,
  "description": "Raw-fetch STT path"
},
{
  "urlPathKey": "v1/voices",
  "httpMethod": "GET",
  "endpoint": "https://api.elevenlabs.io/v1/voices",
  "costModel": "free",
  "description": "Raw-fetch list voices"
},
{
  "urlPathKey": "_default",
  "httpMethod": "POST",
  "endpoint": "https://api.elevenlabs.io/v1",
  "costModel": "per_request",
  "perRequestCostUsd": 0.0001,
  "description": "Unrecognized ElevenLabs path — conservative fallback"
}
```

- [ ] **Step 4: Add `urlPathKey?` to the fingerprint type**

In `src/scanner/fingerprints/types.ts`, find the method interface (likely `FingerprintMethod` or similar). Add:

```ts
/** Optional — URL-path substring used for raw-fetch matching (A7). Mutually exclusive with `pattern`. */
urlPathKey?: string;
```

Update any zod/runtime validator to accept the new field. If the validator requires `pattern`, change it to require ONE of `pattern` or `urlPathKey`.

- [ ] **Step 5: Implement `lookupByUrlPath` in `registry.ts`**

In `src/scanner/fingerprints/registry.ts`, after the existing `lookupMethod` export, add:

```ts
/**
 * Find a fingerprint method by matching the request URL's path against
 * `urlPathKey` entries. Falls back to the `_default` entry if no specific
 * match. Returns null if the provider is unknown or has no URL-path entries.
 *
 * A7 (issue #79): raw-fetch calls have a provider attributed via host match
 * but no SDK method chain. Match by URL path instead.
 */
export function lookupByUrlPath(provider: string, url: string): FingerprintMethod | null {
  const fp = providerFingerprints.get(provider);
  if (!fp) return null;
  const urlPathMethods = fp.methods.filter(m => m.urlPathKey);
  if (urlPathMethods.length === 0) return null;

  let parsed: URL;
  try { parsed = new URL(url); }
  catch { return null; }
  const pathAndQuery = parsed.pathname + (parsed.search ?? "");

  // Match the most specific (longest) urlPathKey first
  const sorted = [...urlPathMethods].sort((a, b) => (b.urlPathKey!.length - a.urlPathKey!.length));
  for (const m of sorted) {
    if (m.urlPathKey === "_default") continue;
    if (pathAndQuery.includes(m.urlPathKey!)) return m;
  }
  return urlPathMethods.find(m => m.urlPathKey === "_default") ?? null;
}
```

(Replace `providerFingerprints.get(provider)` with whatever the actual lookup is in this file — read the existing `lookupMethod` to copy the pattern.)

- [ ] **Step 6: Wire into `cost-utils.ts`**

In `src/intelligence/cost-utils.ts`, modify `estimateLocalMonthlyCost`:

```ts
import { lookupMethod, lookupByUrlPath } from "../scanner/fingerprints/registry";

export function estimateLocalMonthlyCost(
  provider: string,
  callsPerDay: number,
  methodSignature?: string,
  /** A7: URL for the call, used when methodSignature is undefined */
  url?: string,
): number | null {
  if (!provider || provider === "unknown") return null;
  if (!Number.isFinite(callsPerDay) || callsPerDay < 0) return null;

  let fingerprint = methodSignature ? lookupMethod(provider, methodSignature) : null;

  // A7: fall back to URL-path lookup when SDK chain didn't resolve
  if (!fingerprint && url) {
    fingerprint = lookupByUrlPath(provider, url);
  }

  if (fingerprint) {
    if (fingerprint.costModel === "free") return 0;
    if (fingerprint.costModel === "per_token") {
      const inputTokens = 500;
      const outputTokens = 200;
      const inputCost = (inputTokens / 1_000_000) * (fingerprint.inputPricePer1M ?? 0);
      const outputCost = (outputTokens / 1_000_000) * (fingerprint.outputPricePer1M ?? 0);
      return Math.round((inputCost + outputCost) * callsPerDay * 30 * 100) / 100;
    }
    if (fingerprint.costModel === "per_transaction") {
      const txValue = 50;
      const fee = (fingerprint.fixedFee ?? 0) + txValue * (fingerprint.percentageFee ?? 0);
      return Math.round(fee * callsPerDay * 30 * 100) / 100;
    }
    if (fingerprint.costModel === "per_request") {
      return Math.round((fingerprint.fixedFee ?? fingerprint.perRequestCostUsd ?? DEFAULT_PER_CALL_COST) * callsPerDay * 30 * 100) / 100;
    }
    return null;
  }

  const perCall = LOCAL_PRICING[provider];
  if (perCall === undefined) return null;
  return Math.round(callsPerDay * perCall * 30 * 100) / 100;
}
```

Update all callers of `estimateLocalMonthlyCost` to pass `url` when available. Search:

```bash
grep -rn "estimateLocalMonthlyCost(" src/ webview/src/
```

For each caller, if the call-site context has a URL, pass it. If not, leave as is (the parameter is optional).

- [ ] **Step 7: Wire `methodSignature` onto the scan result**

In `scan-results.ts` / wherever the scan emits endpoint records with `methodSignature`: when `methodSignature` is undefined and a URL is known + provider matches `lookupByUrlPath`, set `methodSignature` to a synthetic value like the matched `urlPathKey`. This makes the rest of the pipeline (intelligence layer, simulator) consume URL-path-derived costs the same way they consume SDK-derived ones.

If `scan-results.ts` doesn't exist on main (per earlier investigation), find the actual emission site — likely `core-scanner.ts` or `endpoint-classification.ts`.

- [ ] **Step 8: Run tests**

```bash
npm test 2>&1 | grep -E "(PASS|FAIL).*a7"
```

4 PASS lines.

- [ ] **Step 9: Run benchmark**

```bash
npm run benchmark 2>&1 | tee /tmp/a7-benchmark-output.log
```

Expected effect on D1 metrics: provider-attribution accuracy should tick up slightly (raw-fetch calls now get a method signature instead of `unknown`). Detection precision stays stable. Cost-related metrics are out of D1 scope but the scan-result `costModel` will change for these endpoints — verify by inspecting one raw-`fetch` endpoint in the output JSON.

- [ ] **Step 10: Bump baseline if metrics moved**

```bash
npm run benchmark -- --update-baseline
git diff benchmark/baseline.json
```

- [ ] **Step 11: Commit, push, open PR**

```bash
git checkout -b claude/a7-url-path-method-fallback
git add src/scanner/fingerprints/ src/intelligence/cost-utils.ts src/test/a7-url-path-fallback.test.ts benchmark/baseline.json
# Plus any scan-result file you modified:
git add <changed-scan-results-file>
git commit -m "feat(detection): A7 — URL-path method fallback for raw fetch (closes #79)"
git push -u origin claude/a7-url-path-method-fallback
gh pr create --title "A7: URL-path method fallback for raw fetch (closes #79)" --body "$(cat <<'EOF'
## Summary

- Adds `urlPathKey` optional field to fingerprint methods (`src/scanner/fingerprints/types.ts`).
- Adds `lookupByUrlPath(provider, url)` to the fingerprint registry — matches longest URL-path key, falls back to `_default`.
- Extends `elevenlabs.json` with 4 URL-path entries (text-to-speech, speech-to-text, voices, _default).
- Updates `cost-utils.ts` `estimateLocalMonthlyCost` to take an optional `url` and try URL-path lookup when `methodSignature` is undefined.
- Wires the synthetic methodSignature back into the scan result so downstream consumers (intelligence layer, simulator) get the right cost.
- Updates `benchmark/baseline.json` for the provider-attribution and (out-of-D1-scope) cost improvements.

## D1 measurement

| Metric | Prior | This PR | Δ (pp) |
|---|---|---|---|
| Detection precision | XX.XX% | XX.XX% | ±X.XX |
| Detection recall | XX.XX% | XX.XX% | ±X.XX |
| Provider attribution | XX.XX% | XX.XX% | +X.XX |
| Finding precision | XX.XX% | XX.XX% | ±X.XX |
| Finding recall | XX.XX% | XX.XX% | ±X.XX |

## Follow-ups

- Apply the same URL-path entries to other commonly raw-fetched providers (OpenAI, Anthropic, Cohere, Stripe REST). Track separately.
- The `_default` `perRequestCostUsd` of $0.0001 is conservative; revisit per provider.

## Test plan

- [ ] CI `benchmark` passes (no metric drops > 1pp from new baseline)
- [ ] CI `test:scanner` passes
- [ ] Manual: scan a repo with `fetch("https://api.elevenlabs.io/v1/text-to-speech/...")` — endpoint resolves to elevenlabs with a non-stub cost

Closes #79.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-review

**Spec coverage:**

| Issue | Acceptance criterion | Covered by |
|---|---|---|
| #78 (A6) | pricing.ts fixture with method-chain string keys produces zero findings | Task A6.0 step 1, A6.1 step 1 |
| #78 (A6) | Real call in service.ts to the same method still detected | A6.1 step 1 second test case |
| #78 (A6) | All filename-based workaround patterns removed | A6.1 step 5 + step 1 third test |
| #78 (A6) | Existing fingerprint registry tests pass | A6.1 step 7 |
| #78 (A6) | Benchmark precision improves measurably | A6.1 step 8 |
| #74 (A2) | `fetch(\`${BASE}/path\`)` with same-file const BASE resolves to static URL | A2.1 step 2 first test + A2.2 integration test |
| #74 (A2) | Provider attribution succeeds when folded URL matches a known host | A2.2 step 1 fixture + integration test |
| #74 (A2) | Template literals with non-constant interpolations remain unknown | A2.1 step 2 fourth + seventh test cases |
| #74 (A2) | No regression on plain string URL detection | A2.2 step 5 benchmark must not drop recall on existing fixtures |
| #79 (A7) | Raw fetch to elevenlabs resolves to non-stub cost | A7.1 step 2 first test + step 9 benchmark inspection |
| #79 (A7) | Provider not in URL-path table still falls back gracefully | A7.1 step 2 third test |
| #79 (A7) | Fingerprint JSON schema accepts URL-path keys alongside SDK keys | A7.1 step 4 |

**No placeholders:** Every code block contains real code. Where the implementer must read existing files to find the exact insertion point (`core-scanner.ts` site for A2.2, scan-result emission for A7 step 7), that's called out explicitly with a `grep` command to locate it.

**Type consistency:** `foldStringConstants` returns `string | null` in both definition (A2.1 step 2) and consumers. `lookupByUrlPath` returns `FingerprintMethod | null` in both definition (A7.1 step 5) and consumers. The new `urlPathKey?: string` field added in A7.1 step 4 is used in A7.1 step 5.

**Implementation risks:**

1. **A6.0 may surface that the issue's "call-visitor.ts" claim is wrong.** The investigation step (A6.0) is explicit about this — implementer follows the actual emit site, not the issue's guess. PR description should record the actual fix location.
2. **A2.2 wiring location is not pre-determined.** The fold must happen at the level where file source is available (`core-scanner.ts` or `workspace-scanner.ts`), not inside `LineMatcher`. The plan calls this out and instructs the implementer to `grep` for the call site.
3. **A7's `scan-results.ts` doesn't exist on main** (confirmed by `grep` failure). The implementer must find the actual emission site — likely in `core-scanner.ts` or `endpoint-classification.ts`. Step 7 captures this.
4. **Baseline updates require justification.** Per `benchmark/README.md`, "Commit the new baseline in the same PR as the code change. Explain why in the PR description." Each PR's body has a D1 measurement table for this purpose.

**Sequencing safeguards:**

- A6's PR must merge with green CI before A2 begins. If A6 inadvertently breaks something the CI gate misses, A2 working on top would compound the issue.
- A2 must merge before A7 — A7's test relies on URLs being properly classified, which A2 provides for `fetch(\`${...}\`)` cases.
- Each PR includes a baseline bump if metrics moved. The next PR's baseline is whatever main currently has.

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-13-a6-a2-a7-detection-fixes.md`. Two execution options:

**1. Subagent-Driven (recommended)** — Three sequential implementer dispatches (A6, then A2 after A6 merges, then A7 after A2 merges). Each implementer is followed by spec compliance + code quality reviewers. The controller stops at each ship gate to wait for PR merge + green CI.

**2. Inline Execution** — Execute tasks in this session using `superpowers:executing-plans`. Three batched ship gates with checkpoints between.

Which approach?
