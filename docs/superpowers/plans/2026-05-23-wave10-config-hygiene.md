# Wave 10 — Config Hygiene Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close #97 (hard-coded ReCost URLs) and #98 (1ms `local-${Date.now()}` scanId collision) in one bundled PR via two small new pure modules — `src/config.ts` and `src/scan-id.ts` — and mechanical migration of every call site.

**Architecture:** `src/config.ts` exports `RECOST_API_BASE_URL` and `RECOST_DASHBOARD_BASE_URL` constants that read `process.env.RECOST_API_BASE_URL` / `process.env.RECOST_DASHBOARD_BASE_URL` once at module load, falling back to production defaults. `src/scan-id.ts` exports `newLocalScanId()` returning `local-${Date.now()}-${randomHex(8)}` using `crypto.randomUUID()`. Both modules are pure, zero-dependency, and replace 5 URL literals + 7 scanId construction sites. Production behavior is unchanged (defaults preserve current literals; new scanId format passes any existing `local-` prefix check — confirmed none exist).

**Tech Stack:** TypeScript (strict mode), Node `crypto.randomUUID()`, `process.env`, `node:assert/strict` for tests, `tsc -p tsconfig.scanner-tests.json` test compile.

---

## Note on rebase

This plan was written against `main` HEAD, which has 7 `local-${Date.now()}` sites. The open Wave 8 PR (#123) adds an 8th site inside its new 429-branch in `src/webview/scan-publishing-handler.ts`. If Wave 8 merges before Wave 10:
- Rebase Wave 10 onto `main`.
- The grep gate in Task 5 (`grep -rn 'local-\${Date.now()}' src/` returns zero) will catch the 8th site; replace it with `newLocalScanId()` in a follow-up commit before opening the PR.

---

## File Structure

| File | Responsibility |
|------|----------------|
| `src/config.ts` (new) | Centralize ReCost-owned base URLs. Two exported constants with env-var override. Pure, no runtime branching. |
| `src/scan-id.ts` (new) | Produce collision-resistant local scan IDs. One exported function. Pure (delegates to `crypto`). |
| `src/api-client.ts` | Use `RECOST_API_BASE_URL` for `BASE_URL`. |
| `src/extension.ts` | Use `RECOST_API_BASE_URL` for `PRICING_BACKEND_URL`. Use `RECOST_DASHBOARD_BASE_URL` for `GET_KEY_URL`. |
| `src/chat/providers/eco.ts` | Use `RECOST_API_BASE_URL` for ReCost chat provider `baseUrl`. |
| `src/webview-provider.ts` | Use `RECOST_DASHBOARD_BASE_URL` in dashboard URL template literals (2 sites). |
| `src/cli/scan.ts` | Use `newLocalScanId()`. |
| `src/webview/chat-handler.ts` | Use `newLocalScanId()` as the fallback when `lastEndpoints[0]?.scanId` is undefined. |
| `src/webview/scan-publishing-handler.ts` | Use `newLocalScanId()` at 5 sites (665, 677, 687, 702, 800 on main; one more from Wave 8 if rebased). |
| `src/test/config.test.ts` (new) | Default + env-override + whitespace-fallback coverage. Spawns sub-process to test load-time resolution. |
| `src/test/scan-id.test.ts` (new) | Format regex + 1000-call uniqueness + non-decreasing timestamp coverage. |
| `package.json` | Register both new tests in `scripts.test:scanner`. |

---

## Task 1: Create `src/config.ts` with default + env override

**Files:**
- Create: `src/config.ts`
- Create: `src/test/config.test.ts`
- Modify: `package.json` (add `config.test.js` to `scripts.test:scanner`)

- [ ] **Step 1: Create the failing default-behavior test**

Create `src/test/config.test.ts`:

```ts
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as path from "node:path";

// Resolve the compiled config.js relative to this test file's compiled output.
// Tests compile to dist-test/test/config.test.js; config.js compiles to dist-test/config.js.
const CONFIG_PATH = path.resolve(__dirname, "..", "config.js");

function runConfigInSubprocess(env: Record<string, string | undefined>): {
  api: string;
  dashboard: string;
} {
  const script = `
    const c = require(${JSON.stringify(CONFIG_PATH)});
    process.stdout.write(JSON.stringify({
      api: c.RECOST_API_BASE_URL,
      dashboard: c.RECOST_DASHBOARD_BASE_URL,
    }));
  `;
  const child = spawnSync(process.execPath, ["-e", script], {
    env: { ...process.env, ...env, RECOST_API_BASE_URL: env.RECOST_API_BASE_URL ?? "", RECOST_DASHBOARD_BASE_URL: env.RECOST_DASHBOARD_BASE_URL ?? "" },
    encoding: "utf8",
  });
  if (child.status !== 0) {
    throw new Error(`config subprocess exited ${child.status}: ${child.stderr}`);
  }
  return JSON.parse(child.stdout);
}

async function runTests() {
  // 1. Defaults apply when env vars are unset (passed as empty strings -> trimmed to falsy -> fall back)
  {
    const result = runConfigInSubprocess({});
    assert.equal(result.api, "https://api.recost.dev");
    assert.equal(result.dashboard, "https://recost.dev");
  }

  // 2. Env override applies cleanly
  {
    const result = runConfigInSubprocess({
      RECOST_API_BASE_URL: "https://staging.api.recost.dev",
      RECOST_DASHBOARD_BASE_URL: "https://staging.recost.dev",
    });
    assert.equal(result.api, "https://staging.api.recost.dev");
    assert.equal(result.dashboard, "https://staging.recost.dev");
  }

  // 3. Whitespace-only env vars fall back to defaults
  {
    const result = runConfigInSubprocess({
      RECOST_API_BASE_URL: "   ",
      RECOST_DASHBOARD_BASE_URL: "\t\n",
    });
    assert.equal(result.api, "https://api.recost.dev");
    assert.equal(result.dashboard, "https://recost.dev");
  }

  console.log("PASS config");
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

- [ ] **Step 2: Register the new test in `package.json`**

In `package.json`, find the `"test:scanner"` script (a single very long command string). Append ` && node dist-test/test/config.test.js` to the end of the command string (immediately before the closing `"`). Do not reorder existing entries.

- [ ] **Step 3: Run the test to verify it fails**

Run:
```bash
npm run test:scanner 2>&1 | tail -20
```

Expected: `config` fails (probably with `Cannot find module '.../dist-test/config.js'` because `src/config.ts` doesn't exist yet). This proves the test is wired and ready.

- [ ] **Step 4: Create `src/config.ts`**

Create `src/config.ts`:

```ts
const PROD_API_BASE_URL = "https://api.recost.dev";
const PROD_DASHBOARD_BASE_URL = "https://recost.dev";

export const RECOST_API_BASE_URL =
  process.env.RECOST_API_BASE_URL?.trim() || PROD_API_BASE_URL;

export const RECOST_DASHBOARD_BASE_URL =
  process.env.RECOST_DASHBOARD_BASE_URL?.trim() || PROD_DASHBOARD_BASE_URL;
```

- [ ] **Step 5: Run the test to verify it passes**

Run:
```bash
npm run test:scanner 2>&1 | tail -10
```

Expected: `PASS config` appears; all other tests still pass.

- [ ] **Step 6: Commit**

```bash
git add src/config.ts src/test/config.test.ts package.json
git commit -m "feat(wave10): centralize ReCost base URLs with env-var override (#97)"
```

---

## Task 2: Migrate 5 URL call sites to `src/config.ts`

**Files:**
- Modify: `src/api-client.ts:3`
- Modify: `src/extension.ts:17-18`
- Modify: `src/chat/providers/eco.ts:7`
- Modify: `src/webview-provider.ts:731-732`

- [ ] **Step 1: Migrate `src/api-client.ts`**

Open `src/api-client.ts`. Replace the top import block (line 1) + the `BASE_URL` declaration (line 3) so the file starts with:

```ts
import type { ApiCallInput, EndpointRecord, Suggestion, ScanSummary } from "./analysis/types";
import { RECOST_API_BASE_URL } from "./config";

const BASE_URL = RECOST_API_BASE_URL;
```

The body of `apiFetchWith` (which uses `${BASE_URL}${path}`) is unchanged.

- [ ] **Step 2: Migrate `src/extension.ts`**

Open `src/extension.ts`. Find lines 17-18:
```ts
const GET_KEY_URL = "https://recost.dev/dashboard/account";
const PRICING_BACKEND_URL = "https://api.recost.dev";
```

Replace with:
```ts
const GET_KEY_URL = `${RECOST_DASHBOARD_BASE_URL}/dashboard/account`;
const PRICING_BACKEND_URL = RECOST_API_BASE_URL;
```

And add to the import block at the top (immediately after the `import * as vscode from "vscode";` line):
```ts
import { RECOST_API_BASE_URL, RECOST_DASHBOARD_BASE_URL } from "./config";
```

- [ ] **Step 3: Migrate `src/chat/providers/eco.ts`**

Open `src/chat/providers/eco.ts`. At the top of the file (above the existing exports), add:
```ts
import { RECOST_API_BASE_URL } from "../../config";
```

Then find the line `baseUrl: "https://api.recost.dev",` (around line 7) and replace with:
```ts
  baseUrl: RECOST_API_BASE_URL,
```

(Indentation matches the surrounding object literal — two spaces.)

- [ ] **Step 4: Migrate `src/webview-provider.ts`**

Open `src/webview-provider.ts`. Find the existing import block at the top and add:
```ts
import { RECOST_DASHBOARD_BASE_URL } from "./config";
```

Then find the two consecutive dashboard URL template literals (lines 731-732):
```ts
        ? `https://recost.dev/dashboard/projects/${targetProjectId}`
        : "https://recost.dev/dashboard/projects";
```

Replace with:
```ts
        ? `${RECOST_DASHBOARD_BASE_URL}/dashboard/projects/${targetProjectId}`
        : `${RECOST_DASHBOARD_BASE_URL}/dashboard/projects`;
```

Note: the second arm changes from a plain string to a template literal because we're interpolating the constant.

- [ ] **Step 5: Verify the build**

Run:
```bash
npm run build:ext 2>&1 | tail -5
```

Expected: `Extension built successfully (dev mode).` No TypeScript errors.

- [ ] **Step 6: Verify the grep gate**

Run:
```bash
grep -rn "api\.recost\.dev\|recost\.dev/dashboard" src/ --exclude-dir=test
```

Expected: zero hits, OR only `src/config.ts` (production defaults). If any other production file shows up, that site was missed — go back and migrate it.

- [ ] **Step 7: Run the full test suite**

Run:
```bash
npm run test:scanner 2>&1 | tail -10
```

Expected: all tests pass.

- [ ] **Step 8: Commit**

```bash
git add src/api-client.ts src/extension.ts src/chat/providers/eco.ts src/webview-provider.ts
git commit -m "refactor(wave10): use RECOST_*_BASE_URL constants at all call sites (#97)"
```

---

## Task 3: Create `src/scan-id.ts`

**Files:**
- Create: `src/scan-id.ts`
- Create: `src/test/scan-id.test.ts`
- Modify: `package.json` (add `scan-id.test.js` to `scripts.test:scanner`)

- [ ] **Step 1: Create the failing test**

Create `src/test/scan-id.test.ts`:

```ts
import assert from "node:assert/strict";
import { newLocalScanId } from "../scan-id";

const FORMAT = /^local-\d+-[0-9a-f]{8}$/;

async function runTests() {
  // 1. Format: matches local-<digits>-<8 hex chars>
  {
    const id = newLocalScanId();
    assert.match(id, FORMAT, `expected ${id} to match ${FORMAT}`);
  }

  // 2. Uniqueness: 1000 sequential calls produce 1000 distinct IDs
  {
    const ids = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      ids.add(newLocalScanId());
    }
    assert.equal(ids.size, 1000, `expected 1000 unique IDs, got ${ids.size}`);
  }

  // 3. Timestamp prefix is non-decreasing across 100 calls
  {
    let prev = 0;
    for (let i = 0; i < 100; i++) {
      const id = newLocalScanId();
      const ts = Number(id.split("-")[1]);
      assert.ok(ts >= prev, `timestamp regressed: ${ts} < ${prev}`);
      prev = ts;
    }
  }

  console.log("PASS scan-id");
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

- [ ] **Step 2: Register the new test in `package.json`**

Append ` && node dist-test/test/scan-id.test.js` to the end of the `test:scanner` command string (after the `config.test.js` entry added in Task 1).

- [ ] **Step 3: Run the test to verify it fails**

Run:
```bash
npm run test:scanner 2>&1 | tail -10
```

Expected: `scan-id` fails because `../scan-id` cannot be resolved.

- [ ] **Step 4: Create `src/scan-id.ts`**

Create `src/scan-id.ts`:

```ts
import { randomUUID } from "crypto";

export function newLocalScanId(): string {
  const suffix = randomUUID().replace(/-/g, "").slice(0, 8);
  return `local-${Date.now()}-${suffix}`;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run:
```bash
npm run test:scanner 2>&1 | tail -10
```

Expected: `PASS scan-id` appears; all other tests still pass.

- [ ] **Step 6: Commit**

```bash
git add src/scan-id.ts src/test/scan-id.test.ts package.json
git commit -m "feat(wave10): collision-resistant newLocalScanId() helper (#98)"
```

---

## Task 4: Migrate 7 scanId call sites to `newLocalScanId()`

**Files:**
- Modify: `src/cli/scan.ts:229`
- Modify: `src/webview/chat-handler.ts:414`
- Modify: `src/webview/scan-publishing-handler.ts:665, 677, 687, 702, 800`

- [ ] **Step 1: Migrate `src/cli/scan.ts`**

Open `src/cli/scan.ts`. Add to the imports near the top:
```ts
import { newLocalScanId } from "../scan-id";
```

Find line 229:
```ts
  let scanId = `local-${Date.now()}`;
```

Replace with:
```ts
  let scanId = newLocalScanId();
```

- [ ] **Step 2: Migrate `src/webview/chat-handler.ts`**

Open `src/webview/chat-handler.ts`. Add to the imports:
```ts
import { newLocalScanId } from "../scan-id";
```

Find line 414:
```ts
    const scanId = lastEndpoints[0]?.scanId ?? providerProjectId ?? `local-${Date.now()}`;
```

Replace with:
```ts
    const scanId = lastEndpoints[0]?.scanId ?? providerProjectId ?? newLocalScanId();
```

- [ ] **Step 3: Migrate `src/webview/scan-publishing-handler.ts`**

Open `src/webview/scan-publishing-handler.ts`. Add to the imports:
```ts
import { newLocalScanId } from "../scan-id";
```

Find each `` `local-${Date.now()}` `` occurrence and replace with `newLocalScanId()`. There are 5 sites on main:

Line 665 (inside an object literal):
```ts
            scanId: `local-${Date.now()}`,
```
becomes:
```ts
            scanId: newLocalScanId(),
```

Lines 677, 687, 702, 800 (each inside a `publishLocalOnlyResults(...)` call):
```ts
        publishLocalOnlyResults(manualProjectId ?? this.ctx.getProjectId() ?? "local", `local-${Date.now()}`);
```
each becomes:
```ts
        publishLocalOnlyResults(manualProjectId ?? this.ctx.getProjectId() ?? "local", newLocalScanId());
```

(Indentation varies by site — preserve whatever is there.)

If after Wave 8 has merged you find a 6th site in this file (in the 429 branch), apply the same replacement there too.

- [ ] **Step 4: Verify the grep gate**

Run:
```bash
grep -rn 'local-\${Date.now()}' src/
```

Expected: zero hits. If any remain, migrate them.

- [ ] **Step 5: Verify the build**

Run:
```bash
npm run build:ext 2>&1 | tail -5
```

Expected: `Extension built successfully (dev mode).` No TypeScript errors.

- [ ] **Step 6: Run the full test suite**

Run:
```bash
npm run test:scanner 2>&1 | tail -10
```

Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/cli/scan.ts src/webview/chat-handler.ts src/webview/scan-publishing-handler.ts
git commit -m "refactor(wave10): use newLocalScanId() at all local-scanId call sites (#98)"
```

---

## Task 5: Final verification + PR

- [ ] **Step 1: Full test suite + build**

Run:
```bash
npm run test:scanner 2>&1 | tail -10 && npm run build 2>&1 | tail -5
```

Expected: every test ends in `PASS`, including `PASS config` and `PASS scan-id`. Build clean.

- [ ] **Step 2: Confirm grep gates one more time**

Run both:
```bash
grep -rn "api\.recost\.dev\|recost\.dev/dashboard" src/ --exclude-dir=test
grep -rn 'local-\${Date.now()}' src/
```

Expected: zero hits outside `src/config.ts` for the URL grep; zero hits at all for the scanId grep. If anything turns up, fix it before opening the PR.

- [ ] **Step 3: Manual EDH gate (30 seconds)**

Press F5 in VSCode to launch the Extension Development Host. In the EDH:
1. Confirm the status bar shows "ReCost: Not Configured" or "ReCost: <email>" as it did before this change.
2. If no key configured, click "Get a key" in the info notification and confirm it opens `https://recost.dev/dashboard/account` in the browser (the URL bar should show the literal production domain).
3. With a key configured, open the dashboard from the sidebar and confirm the URL resolves correctly.

If any of these visually differ from production behavior, something is wrong — investigate before merging.

- [ ] **Step 4: Push the branch**

```bash
git push -u origin wave10/config-hygiene
```

- [ ] **Step 5: Open the PR**

```bash
gh pr create --title "wave10: config hygiene (#97, #98)" --body "$(cat <<'EOF'
Closes #97
Closes #98

## Summary
- **#97** — Centralized two ReCost-owned base URLs (`https://api.recost.dev`, `https://recost.dev`) into a new `src/config.ts` module with env-var overrides (`RECOST_API_BASE_URL`, `RECOST_DASHBOARD_BASE_URL`). Migrated 5 call sites across `api-client.ts`, `extension.ts`, `chat/providers/eco.ts`, `webview-provider.ts`.
- **#98** — Replaced `local-${Date.now()}` with a new `newLocalScanId()` helper in `src/scan-id.ts` that produces `local-<ts>-<8 hex>`. Migrated 7 call sites across `cli/scan.ts`, `webview/chat-handler.ts`, `webview/scan-publishing-handler.ts` (+1 more if Wave 8 has merged).

Production behavior is unchanged: env defaults preserve the existing URL literals, and the new scanId format passes any prefix check (confirmed none exist).

## Test plan
- [x] `npm run test:scanner` — existing suite + new `config` test (3 cases, sub-process load-time resolution) + new `scan-id` test (format regex, 1000-call uniqueness, monotonic timestamp) all pass.
- [x] `npm run build` — dashboard + webview + extension build clean.
- [x] Grep gate — `api.recost.dev` / `recost.dev/dashboard` only in `src/config.ts`; `local-${Date.now()}` returns zero hits.
- [ ] D1 benchmark Δ +0.00pp sanity (no scanner change expected).
- [ ] EDH manual gate — confirm status bar + "Get a key" link + dashboard link all resolve to production URLs.

Plan: `docs/superpowers/plans/2026-05-23-wave10-config-hygiene.md`. Design spec: `docs/superpowers/specs/2026-05-23-wave10-config-hygiene-design.md`.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Return the PR URL.

---

## Self-review notes

- **Spec coverage:** Section A (#97 URLs) → Tasks 1 + 2. Section B (#98 scanId) → Tasks 3 + 4. Verification gates → Task 5.
- **Tests covered:** Spec requires (a) defaults/override/whitespace for `config.ts` (Task 1 cases 1/2/3), (b) format + uniqueness + monotonic for `scan-id.ts` (Task 3 cases 1/2/3). Both covered.
- **Type consistency:** `RECOST_API_BASE_URL`, `RECOST_DASHBOARD_BASE_URL`, `newLocalScanId()` names match across spec, plan, and call sites.
- **Risk:** Task 2 Step 4 changes the dashboard URL template from a plain string to a template literal — TypeScript accepts both as `string`, so no callers break. Task 4's 5 sites in `scan-publishing-handler.ts` assume current line numbers (665/677/687/702/800) — the grep gate at Step 4 catches misses if line numbers have drifted.
- **Rebase scenario:** If Wave 8 merges first, Task 4 Step 3's note flags the 6th site to migrate (the 429 branch). The grep gate enforces this.
