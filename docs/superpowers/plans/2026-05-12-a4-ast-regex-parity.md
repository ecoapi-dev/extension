# A4 — AST ↔ Regex Parity Audit + CI Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Catch silent disagreement between the AST scanner (`src/ast/`) and the regex pattern scanners (`src/scanner/patterns/`). For any call both can see, they must agree on `(provider, method, line)`. Divergences are either bugs (fix) or intentional design (document in `PARITY.md`). The parity test runs in CI on every PR.

**Architecture:** A new test runner walks a fixture corpus. For each fixture file it runs **the AST path only** and **the regex path only**, normalizes both result sets to `{provider, method, line, kind}` tuples, and computes the symmetric difference. The diff is compared against a YAML allowlist of intentional divergences in `docs/accuracy/PARITY.md`. Anything outside the allowlist fails the test.

We do **not** run `core-scanner.scanFiles()` directly because that path applies AST coverage masking (`astCoveredLines.has(lineNum)`) and regex falls through only on lines AST didn't catch — that masks the parity question we're trying to answer. The test calls each path in isolation.

**Tech Stack:** TypeScript (strict), web-tree-sitter, Node `assert/strict` test runner. No new dependencies.

**Reference:** GitHub issue [#76](https://github.com/recost-dev/extension/issues/76); design note at `docs/accuracy/detection.md` § A4.

**Depends on:** B1 (spans) makes the line-equality check robust against multi-line calls — without spans, AST reports the call's first line and regex reports whatever line the regex match started on. Land B1 first if possible. The parity runner here uses `line` only and works without B1, but follow-up precision will benefit.

---

## Execution Model

This plan is executed via **`superpowers:subagent-driven-development`**. The main session is the controller; it dispatches one **implementer subagent** per task, then runs **spec compliance** and **code quality** reviewer subagents on the result before moving on. Subagents follow `superpowers:test-driven-development` automatically.

A4 has the largest parallelization surface of the three foundation plans because the fixture files are mechanically independent. Those are dispatched as a wide parallel batch via `superpowers:dispatching-parallel-agents`. The triage step in Task 5, however, is **inherently serial** — each fix changes the diagnostic output of the next iteration — and is called out separately below.

### Parallel Safety Rules

These rules are non-negotiable. If a rule conflicts with a task as written, **that task runs serially** instead of being parallelized.

1. **One implementer per file.** No two parallel agents may write to the same file in the same batch. The "Files" block at the top of every task is the authoritative declaration; the controller checks for overlap before dispatching and refuses to start the batch on conflict.
2. **Worktree isolation.** Every parallel agent runs in its own git worktree via `superpowers:using-git-worktrees`. Worktrees are cut from the **same base SHA** at batch start. After all agents in the batch return DONE, the controller merges each branch into the working branch in **declared task order** (not return order), runs `npm test` after each merge, and only proceeds when the full suite is green.
3. **Foundation tasks never run in parallel.** Task 1 (the runner library + the empty `PARITY.md` allowlist) **must land first** — every fixture relies on the runner existing as the consumer. Task 4 (the test-entry wiring) **must land last in the build-out phase** — it's the pin that fails the suite if any fixture is broken.
4. **Each agent leaves the build green in its own worktree.** A fixture file alone does not run any test; the implementer's success criterion is "file exists and matches the snippet exactly". The full parity test only runs after Task 4.
5. **No cross-task type changes inside a parallel batch.** No fixture should require modifications to `parity.ts`, the registry, or any production code. If a parallel fixture agent thinks the runner needs a tweak, it must escalate (`NEEDS_CONTEXT`) — Task 5 is where parity bugs get fixed, not Task 2 or 3.
6. **Reviewer subagents run after merge into the working branch**, not against the worktree.
7. **Triage and bug-hunting tasks are always serial.** **Task 5 is the canonical case.** Each fix changes which divergences remain. The controller dispatches **one** implementer at a time, re-runs the parity test between iterations, and only progresses to the next divergence when the previous is resolved (either fixed or allowlisted). **Never split Task 5 across parallel agents.**
8. **Triage commits go directly to the working branch.** No worktree per fix — the iterative loop needs to see the cumulative state. The implementer for each Task 5 fix is short-lived (one fix, one commit, return).

### Batch Plan

| Batch | Tasks | Mode | Pre-condition |
|---|---|---|---|
| **F1** | Task 1 | Foundation (serial) | none |
| **A** | Task 2 fixtures (4 files) + Task 3 fixtures (3 files) | Parallel (7 agents) | F1 merged + green |
| **F2** | Task 4 | Foundation (serial) | A merged + green |
| **T** | Task 5 (iterative triage) | Serial, **multiple short implementer dispatches** | F2 merged. The first F2 run is **expected to fail**; each iteration of T fixes one divergence (or annotates it) and re-runs the parity test. T exits when the test is green. |
| **V** | Task 6 | Serial (verification) | T green |

Total: 1 large parallel-agent dispatch (7-way) across the 6 tasks; Task 5 itself is iterative-serial. Estimated wall-time savings on Batch A alone are substantial — fixture creation is the longest mechanical step.

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `src/test/fixtures/parity/openai-basic.ts` | **Create** | Direct OpenAI SDK call. AST + regex (via `openai-compatible.ts`) should both detect. |
| `src/test/fixtures/parity/anthropic-basic.ts` | **Create** | Direct Anthropic SDK call. |
| `src/test/fixtures/parity/fetch-known-host.ts` | **Create** | Raw `fetch("https://api.openai.com/...")` — both paths should attribute to `openai`. |
| `src/test/fixtures/parity/stripe-basic.ts` | **Create** | `stripe.paymentIntents.create(...)`. |
| `src/test/fixtures/parity/wrapped-call.ts` | **Create** | Wrapped helper — AST-only (regex can't see through). Listed in `PARITY.md`. |
| `src/test/fixtures/parity/object-literal-only.ts` | **Create** | Pricing-table-style data file with method-chain string keys. Should produce **zero** matches from either path (regression guard, ties to A6). |
| `src/test/fixtures/parity/python-requests.py` | **Create** | Python `requests.get("https://api.openai.com/...")`. |
| `src/test/parity.ts` | **Create** | Pure parity-runner library: `runParity(fixtureDir, allowlist)` → `{ divergences, errors }`. |
| `src/test/parity.test.ts` | **Create** | Test entry point that calls `runParity` against the fixture dir + the `PARITY.md` allowlist; asserts no unannotated divergences. |
| `docs/accuracy/PARITY.md` | **Create** | Documented intentional divergences (AST-only / regex-only categories) — both human-readable and machine-readable (fenced YAML block). |
| `package.json` | Modify | Wire `parity.test.js` into `test:scanner`. |

---

## Task 1: Skeleton — runner library + empty allowlist

**Batch:** F1 — Foundation, serial. No predecessors. Must land before any fixture work begins, because every fixture reads as input to this runner.

**Files:**
- Create: `src/test/parity.ts`
- Create: `docs/accuracy/PARITY.md`

- [ ] **Step 1: Write the parity runner**

Create `src/test/parity.ts`:

```typescript
import * as path from "path";
import * as fs from "fs";
import { setWasmDir, getLanguageForExtension } from "../ast/parser-loader";
import { scanSourceWithAst, type AstCallMatch } from "../ast/ast-scanner";
import { matchLine } from "../scanner/patterns";

setWasmDir(path.join(__dirname, "..", "..", "assets", "parsers"));

export interface ParityRecord {
  provider: string;
  method: string;
  line: number;
  source: "ast" | "regex";
}

export interface FixtureDivergence {
  file: string;
  ast: ParityRecord[];      // matches AST found that regex missed
  regex: ParityRecord[];    // matches regex found that AST missed
  disagreed: Array<{ line: number; ast: ParityRecord; regex: ParityRecord }>;
}

export interface AllowlistEntry {
  file: string;             // relative path under fixtures/parity/
  reason: string;           // human-readable rationale
  astOnly?: boolean;        // expected: AST detects, regex does not
  regexOnly?: boolean;      // expected: regex detects, AST does not
}

function normalizeAst(matches: AstCallMatch[]): ParityRecord[] {
  return matches
    .filter((m) => m.provider) // unattributed AST matches don't participate in parity
    .map((m) => ({
      provider: m.provider!,
      method: (m.method ?? "CALL").toUpperCase(),
      line: m.line,
      source: "ast" as const,
    }));
}

function normalizeRegex(source: string): ParityRecord[] {
  const out: ParityRecord[] = [];
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const matches = matchLine(lines[i]);
    for (const m of matches) {
      // The regex layer's "library" maps loosely to provider for known hosts,
      // but for generic-http it's "generic-http" — those don't participate.
      if (m.library === "generic-http") continue;
      out.push({
        provider: m.library,
        method: m.method.toUpperCase(),
        line: i + 1,
        source: "regex",
      });
    }
  }
  return out;
}

function key(r: ParityRecord): string {
  return `${r.provider}|${r.method}|${r.line}`;
}

export async function compareForFixture(
  filePath: string,
  source: string
): Promise<FixtureDivergence> {
  const ext = path.extname(filePath);
  const lang = getLanguageForExtension(ext);
  const astResult = lang
    ? await scanSourceWithAst(source, lang, filePath)
    : { matches: [], classRegistry: new Map(), middlewareQueue: [] };

  const astRecords = normalizeAst(astResult.matches);
  const regexRecords = normalizeRegex(source);

  const astByKey = new Map(astRecords.map((r) => [key(r), r]));
  const regexByKey = new Map(regexRecords.map((r) => [key(r), r]));

  const astOnly: ParityRecord[] = [];
  const regexOnly: ParityRecord[] = [];
  const disagreed: Array<{ line: number; ast: ParityRecord; regex: ParityRecord }> = [];

  for (const [k, r] of astByKey) {
    if (!regexByKey.has(k)) {
      // Could be a same-line, different (provider/method) disagreement —
      // pair with anything regex emitted on the same line first.
      const sameLineRegex = regexRecords.find((x) => x.line === r.line);
      if (sameLineRegex) disagreed.push({ line: r.line, ast: r, regex: sameLineRegex });
      else astOnly.push(r);
    }
  }
  for (const [k, r] of regexByKey) {
    if (!astByKey.has(k)) {
      const sameLineAst = astRecords.find((x) => x.line === r.line);
      if (!sameLineAst) regexOnly.push(r);
      // (the disagreed-on-same-line case is already pushed above, no need to dup)
    }
  }

  return { file: filePath, ast: astOnly, regex: regexOnly, disagreed };
}

export async function runParity(
  fixtureDir: string,
  allowlist: AllowlistEntry[]
): Promise<{ allDivergences: FixtureDivergence[]; unannotated: FixtureDivergence[] }> {
  const files = fs.readdirSync(fixtureDir).map((f) => path.join(fixtureDir, f));
  const allDivergences: FixtureDivergence[] = [];
  const unannotated: FixtureDivergence[] = [];

  for (const filePath of files) {
    const source = fs.readFileSync(filePath, "utf8");
    const div = await compareForFixture(filePath, source);
    if (div.ast.length === 0 && div.regex.length === 0 && div.disagreed.length === 0) continue;
    allDivergences.push(div);

    const relName = path.relative(fixtureDir, filePath);
    const entry = allowlist.find((e) => e.file === relName);
    if (!entry) { unannotated.push(div); continue; }
    if (div.disagreed.length > 0) { unannotated.push(div); continue; } // disagreement on same line is never allowed
    if (div.ast.length > 0 && !entry.astOnly) { unannotated.push(div); continue; }
    if (div.regex.length > 0 && !entry.regexOnly) { unannotated.push(div); continue; }
  }

  return { allDivergences, unannotated };
}

/**
 * Parse the YAML block out of `docs/accuracy/PARITY.md`.
 * The file has a single ```yaml fenced block whose contents are an array of
 * AllowlistEntry. Minimal hand-rolled parser — no YAML dep.
 */
export function parseAllowlist(markdown: string): AllowlistEntry[] {
  const yamlMatch = markdown.match(/```yaml\n([\s\S]*?)```/);
  if (!yamlMatch) return [];
  const body = yamlMatch[1];
  const entries: AllowlistEntry[] = [];
  let current: Partial<AllowlistEntry> | null = null;
  for (const rawLine of body.split("\n")) {
    const line = rawLine.trimEnd();
    if (line.startsWith("- file:")) {
      if (current?.file) entries.push(current as AllowlistEntry);
      current = { file: line.slice("- file:".length).trim() };
    } else if (current && line.trim().startsWith("reason:")) {
      current.reason = line.split("reason:")[1].trim();
    } else if (current && line.trim().startsWith("astOnly:")) {
      current.astOnly = line.includes("true");
    } else if (current && line.trim().startsWith("regexOnly:")) {
      current.regexOnly = line.includes("true");
    }
  }
  if (current?.file) entries.push(current as AllowlistEntry);
  return entries;
}
```

- [ ] **Step 2: Create the empty allowlist doc**

Create `docs/accuracy/PARITY.md`:

```markdown
# AST ↔ Regex Parity — Documented Divergences

Tracked under [issue #76](https://github.com/recost-dev/extension/issues/76). The
parity test in `src/test/parity.test.ts` runs both detection paths against
`src/test/fixtures/parity/`, normalises results to `(provider, method, line)`
tuples, and fails on any divergence not listed below.

## How to use this list

- Adding a fixture: place it under `src/test/fixtures/parity/`. If both paths
  are expected to detect the same calls, no entry is needed.
- A divergence the test surfaces is either a bug (fix it) or a documented
  intentional difference (add an entry below). The first option is preferred.
- Entries are parsed by `parseAllowlist()` in `src/test/parity.ts` from the
  fenced YAML block. Keep that block as the single source of truth.

## Allowlist

```yaml
- file: wrapped-call.ts
  reason: AST follows wrapper functions back to the SDK call; regex sees only the wrapper invocation by name.
  astOnly: true
```
```

- [ ] **Step 3: Commit**

```bash
git add src/test/parity.ts docs/accuracy/PARITY.md
git commit -m "feat(parity): runner library + empty allowlist scaffolding (issue #76)"
```

---

## Task 2: Create the basic agreement fixtures

**Batch:** A — parallel. **This task is split across 4 implementer subagents, one per fixture file.** Each agent receives only the snippet + path for its file. No fixture imports another. The controller's parallel dispatch issues four `Agent` calls in a single message (file paths and snippet strings extracted from steps 1-4 below). The single shared "commit" step is replaced: each agent commits its single file independently with the message `test(parity): <file> fixture (issue #76)`.

**Files (per parallel agent):**
- Agent 2a: `src/test/fixtures/parity/openai-basic.ts`
- Agent 2b: `src/test/fixtures/parity/anthropic-basic.ts`
- Agent 2c: `src/test/fixtures/parity/stripe-basic.ts`
- Agent 2d: `src/test/fixtures/parity/fetch-known-host.ts`

- [ ] **Step 1: openai-basic**

Create `src/test/fixtures/parity/openai-basic.ts`:

```typescript
import OpenAI from "openai";
const client = new OpenAI();
async function ask() {
  return client.chat.completions.create({
    model: "gpt-4o",
    messages: [{ role: "user", content: "hi" }],
  });
}
ask();
```

- [ ] **Step 2: anthropic-basic**

Create `src/test/fixtures/parity/anthropic-basic.ts`:

```typescript
import Anthropic from "@anthropic-ai/sdk";
const client = new Anthropic();
async function ask() {
  return client.messages.create({
    model: "claude-3-5-haiku-latest",
    max_tokens: 1024,
    messages: [],
  });
}
ask();
```

- [ ] **Step 3: stripe-basic**

Create `src/test/fixtures/parity/stripe-basic.ts`:

```typescript
import Stripe from "stripe";
const stripe = new Stripe("sk_test", { apiVersion: "2024-04-10" });
async function charge() {
  return stripe.paymentIntents.create({ amount: 1000, currency: "usd" });
}
charge();
```

- [ ] **Step 4: fetch-known-host**

Create `src/test/fixtures/parity/fetch-known-host.ts`:

```typescript
async function callOpenAi() {
  return fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: "Bearer sk-x" },
    body: JSON.stringify({ model: "gpt-4o", messages: [] }),
  });
}
callOpenAi();
```

- [ ] **Step 5: Commit (per-agent in parallel mode; single commit if running serially)**

Parallel mode: each agent commits its single file:

```bash
git add src/test/fixtures/parity/<file>.ts
git commit -m "test(parity): <file> fixture (issue #76)"
```

Serial fallback (if rule #1 conflict forces serial execution):

```bash
git add src/test/fixtures/parity/openai-basic.ts src/test/fixtures/parity/anthropic-basic.ts src/test/fixtures/parity/stripe-basic.ts src/test/fixtures/parity/fetch-known-host.ts
git commit -m "test(parity): basic agreement fixtures (issue #76)"
```

---

## Task 3: Create the documented-divergence fixtures

**Batch:** A — parallel with Task 2. **Split across 3 implementer subagents, one per fixture file.** Same pattern as Task 2: each agent commits its single file independently.

**Files (per parallel agent):**
- Agent 3a: `src/test/fixtures/parity/wrapped-call.ts`
- Agent 3b: `src/test/fixtures/parity/object-literal-only.ts`
- Agent 3c: `src/test/fixtures/parity/python-requests.py`

- [ ] **Step 1: wrapped-call (AST-only)**

Create `src/test/fixtures/parity/wrapped-call.ts`:

```typescript
import OpenAI from "openai";
const ai = new OpenAI();
function complete(prompt: string) {
  return ai.chat.completions.create({
    model: "gpt-4o",
    messages: [{ role: "user", content: prompt }],
  });
}
async function answerQuestion(q: string) {
  return complete(q);
}
answerQuestion("hi");
```

> AST resolves `complete()` back to the SDK call. Regex only sees `complete(q)` and has no provider for it. Documented `astOnly: true` in `PARITY.md` (Task 1).

- [ ] **Step 2: object-literal-only (zero matches expected)**

Create `src/test/fixtures/parity/object-literal-only.ts`:

```typescript
// Pure data — no executable API calls. Both paths should produce zero matches.
// This guards the A6 (object-literal false positive) fix once it lands.
export const METHOD_PRICING = {
  openai: {
    "chat.completions.create": { costModel: "per_token" },
    "embeddings.create": { costModel: "per_token" },
  },
  anthropic: {
    "messages.create": { costModel: "per_token" },
  },
};
```

> No allowlist entry needed. If either path produces a match here, the parity test fails — and that is the right outcome. (Today, the AST visitor *may* match these as object keys, depending on tree-sitter behavior. If it does, this fixture surfaces the bug and ties to A6 #78.)

- [ ] **Step 3: python-requests**

Create `src/test/fixtures/parity/python-requests.py`:

```python
import requests

def fetch_completion():
    return requests.post(
        "https://api.openai.com/v1/chat/completions",
        json={"model": "gpt-4o", "messages": []},
    )

fetch_completion()
```

> AST + regex should both detect; both should attribute to `openai` via host lookup.

- [ ] **Step 4: Commit (per-agent in parallel mode; single commit if running serially)**

Parallel mode: each agent commits its single file with `test(parity): <file> fixture (issue #76)`.

Serial fallback:

```bash
git add src/test/fixtures/parity/wrapped-call.ts src/test/fixtures/parity/object-literal-only.ts src/test/fixtures/parity/python-requests.py
git commit -m "test(parity): documented-divergence and zero-match fixtures (issue #76)"
```

---

## Task 4: Wire the test entry point

**Batch:** F2 — Foundation, serial. Depends on Batch A merged + green (the test entry references the fixture directory). The first run of the parity test from this task is **expected to fail with one or more unannotated divergences** — that is the input to Task 5 triage.

**Files:**
- Create: `src/test/parity.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Write the test entry**

Create `src/test/parity.test.ts`:

```typescript
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { runParity, parseAllowlist } from "./parity";

const FIXTURE_DIR = path.join(__dirname, "fixtures", "parity");
const PARITY_MD = path.join(__dirname, "..", "..", "docs", "accuracy", "PARITY.md");

(async () => {
  const allowlist = parseAllowlist(fs.readFileSync(PARITY_MD, "utf8"));
  const { allDivergences, unannotated } = await runParity(FIXTURE_DIR, allowlist);

  if (unannotated.length > 0) {
    console.error("UNANNOTATED PARITY DIVERGENCES:");
    for (const div of unannotated) {
      console.error(`  ${path.relative(FIXTURE_DIR, div.file)}`);
      for (const r of div.ast) {
        console.error(`    AST-only: ${r.provider} ${r.method} L${r.line}`);
      }
      for (const r of div.regex) {
        console.error(`    regex-only: ${r.provider} ${r.method} L${r.line}`);
      }
      for (const d of div.disagreed) {
        console.error(`    disagreement L${d.line}: AST=${d.ast.provider} ${d.ast.method} vs regex=${d.regex.provider} ${d.regex.method}`);
      }
    }
    console.error("\nFix the bug, or add an entry to docs/accuracy/PARITY.md.");
    process.exit(1);
  }

  console.log(`PASS parity (${allDivergences.length} documented divergences, 0 unannotated)`);
})().catch((err) => { console.error(err); process.exit(1); });
```

- [ ] **Step 2: Wire into the npm script**

Edit `package.json` `test:scanner` script — append `&& node dist-test/test/parity.test.js` before the closing `"`.

- [ ] **Step 3: Build the test**

Run: `npx tsc -p tsconfig.scanner-tests.json`
Expected: clean.

- [ ] **Step 4: Run the test for the first time**

Run: `node dist-test/test/parity.test.js`
Expected: **likely fails** with one or more unannotated divergences. That is the point of this audit — it tells us where AST and regex disagree today.

> **Do not "fix" the test by adding everything to the allowlist.** Each surfaced divergence in the next task is either a bug (fix it) or genuinely intentional (add to allowlist with a real reason). Be honest.

- [ ] **Step 5: Commit, even if the test currently fails**

```bash
git add src/test/parity.test.ts package.json
git commit -m "test(parity): wire parity-test entry into test:scanner (issue #76)"
```

> The test will be red on this commit by design. Subsequent commits in Task 5 categorize and resolve.

---

## Task 5: Triage and resolve each divergence

**Batch:** T — **Iterative serial.** Multiple short implementer dispatches, one per divergence, with a parity-test re-run between each. **Never parallelize.** Reasoning: each fix changes which divergences remain in the diagnostic output, so concurrent fixes would race on stale diagnostic state and likely conflict on the same matcher file.

**Controller loop:**
1. Run `node dist-test/test/parity.test.js` and read its output.
2. Pick the first unannotated divergence.
3. Categorize it (per Step 1 below) and dispatch a focused implementer subagent with: the divergence text, the categorization, and the constraint "fix only this one divergence; do not modify the runner or other fixtures."
4. After the subagent returns DONE, the controller re-runs the parity test.
5. If the divergence is gone and no new ones appeared, run reviewers, commit. Otherwise, escalate (the fix had a side effect or the categorization was wrong) and re-dispatch with corrected context.
6. Repeat from step 1 until the parity test passes.

**Files (per iteration — varies):**
- For category 1 / 3 / 5 fixes: `src/scanner/patterns/*.ts` and/or `src/ast/call-visitor.ts` and/or `src/ast/ast-scanner.ts`
- For category 2 / 4 (allowlist): `docs/accuracy/PARITY.md`

- [ ] **Step 1: Run the test, capture the divergence list**

Run: `node dist-test/test/parity.test.js 2>&1 | tee /tmp/parity-divergences.txt`
Read `/tmp/parity-divergences.txt`. Categorize each divergence into exactly one of:

1. **AST-only — bug**: regex *should* have caught it. Open a fix in the regex matcher under `src/scanner/patterns/`.
2. **AST-only — intentional**: AST follows wrappers/imports/types that regex structurally cannot. Add to `PARITY.md` allowlist with `astOnly: true` and a *specific* reason.
3. **Regex-only — bug**: AST should have caught it. Open a fix in `src/ast/call-visitor.ts` or the relevant `ast-scanner.ts` emit site.
4. **Regex-only — intentional**: regex catches something AST cannot (e.g. languages without tree-sitter coverage). Add to `PARITY.md` with `regexOnly: true`.
5. **Same-line disagreement**: never intentional. AST and regex report different `(provider, method)` for the same call site. Always a bug — fix the path that's wrong.

- [ ] **Step 2: Apply fixes one at a time, commit between each**

For each non-allowlist resolution:
1. Make the fix.
2. Run `npx tsc -p tsconfig.scanner-tests.json && node dist-test/test/parity.test.js`.
3. Confirm the divergence is gone.
4. Commit with a message like `fix(parity): regex now detects X for Y (issue #76)`.

For each allowlist resolution:
1. Add an entry to the YAML block in `docs/accuracy/PARITY.md` with a concrete `reason:` (not "intentional" — say *why*).
2. Re-run the test.
3. Commit with `docs(parity): document <case> divergence (issue #76)`.

- [ ] **Step 3: Final run — must be green**

Run: `node dist-test/test/parity.test.js`
Expected: `PASS parity (N documented divergences, 0 unannotated)`.

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: all PASS, including parity.

---

## Task 6: Acceptance verification

**Batch:** V — Serial. Final verification before PR.

- [ ] **Step 1: Walk the acceptance criteria from `docs/accuracy/detection.md` § A4**

Confirm each is met:

- [ ] Parity test runs in CI on every PR. (`test:scanner` in `package.json`; CI runs `npm test`.)
- [ ] Every divergence the test produces is either fixed or annotated in `PARITY.md`. (Task 5.)
- [ ] Same `line` reported by both paths for every JS/TS/Python file where both detect a call. (Enforced by the runner — same-line disagreement always fails.)

- [ ] **Step 2: Update the roadmap**

Edit `docs/accuracy/detection.md` § A4 — strike through "Investigation steps" and append: `✅ Landed: 2026-05-12, see <PR>. Allowlist lives in docs/accuracy/PARITY.md.`

- [ ] **Step 3: Confirm CI picks it up**

Check `.github/workflows/` (or whatever CI config the repo uses) for the test invocation. The runner uses `npm test` → `test:scanner`, which now includes parity. If a workflow file pins specific scripts, add `parity.test.js` there too.

Run: `ls .github/workflows/ 2>/dev/null || echo "no workflows dir"`. If a workflows directory exists, read each YAML and confirm `npm test` is invoked. If not, no extra change needed.

- [ ] **Step 4: Commit and ship**

```bash
git add docs/accuracy/detection.md
git commit -m "docs(accuracy): mark A4 (AST↔regex parity) shipped (issue #76)"
```

Then create the PR per repo convention.

---

## Self-Review Notes

- **Spec coverage**: every acceptance criterion in `docs/accuracy/detection.md` § A4 maps to a task above (Task 6).
- **Placeholder scan**: zero TBDs. Task 5 is intentionally open-ended because we *don't know* what the divergences are until we run the test — but the workflow per divergence is fully specified (categorize → fix or document → commit).
- **Type consistency**: `ParityRecord` and `AllowlistEntry` are the only new types and live in `src/test/parity.ts`. The runner uses the public `scanSourceWithAst` and `matchLine` exports unchanged.
- **Why isolate the paths**: `core-scanner.scanFiles()` masks regex output on AST-covered lines, which would silently hide most parity gaps. The runner deliberately calls each path on the raw source, even though the production scanner doesn't.
- **Limitation (documented)**: the runner only checks `(provider, method, line)`. Once B1 lands, follow-up work could compare full spans. Captured as a future improvement, not a blocker for A4.
- **Why `generic-http` is filtered**: regex-side detection without a host map produces `library: "generic-http"`, which doesn't have a provider. AST emits `provider: undefined` for the same case (filtered out by `normalizeAst`). Filtering keeps the comparison apples-to-apples.
