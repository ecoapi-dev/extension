# Wave 10 — Config Hygiene Design

**Date:** 2026-05-23
**Closes:** #97, #98
**Wave label:** `wave/10-config-hygiene`
**Area:** `area/extension-ux`
**PR shape:** one bundled PR

## Goal

Two small hygiene defects ship together because both are scattered string-literal cleanups in the same surface area:

1. **#97** — `https://api.recost.dev` and `https://recost.dev/dashboard/...` appear as raw literals in five call sites across four files. Staging/regional deployments require multi-file edits; new contributors propagate the pattern.
2. **#98** — Local-only `scanId` is generated as `local-${Date.now()}`, which has a 1-millisecond collision window. Any caller that keys by `scanId` silently overwrites the previous local scan when two scans land in the same millisecond. Practically rare in human use; possible via CLI automation or rapid double-clicks.

## Non-goals

- Third-party provider URLs (`api.openai.com`, `api.anthropic.com`, `api.x.ai`, `api.cohere.com`, `api.mistral.ai`) in `src/chat/providers/*.ts` stay literal — not ReCost-owned, no override use case.
- Fingerprint JSON `endpoint` strings in `src/scanner/fingerprints/*.json` stay literal — these describe pricing tables for real third-party endpoints; rewriting them would corrupt the pricing data.
- VSCode setting UI for the URL override is out of scope. Staging-deploy ergonomics is a developer concern, not an end-user concern; env vars are the right surface.
- Cross-process scanId uniqueness (CLI + extension running concurrently against the same project) is achieved by the entropy in the new format but is not a tested invariant.

## Architecture

Two new modules in `src/`, both pure, both zero-dependency:

- `src/config.ts` — exports `RECOST_API_BASE_URL` and `RECOST_DASHBOARD_BASE_URL` constants. Reads `process.env.RECOST_API_BASE_URL` / `process.env.RECOST_DASHBOARD_BASE_URL` once at module load, falling back to production defaults.
- `src/scan-id.ts` — exports `newLocalScanId(): string` returning `local-${Date.now()}-${randomHex(8)}` using `crypto.randomUUID()`.

Single bundled PR on branch `wave10/config-hygiene` closing #97 + #98. No new dependencies, no IPC surface changes, no scanner/detector impact. Production behavior unchanged: defaults preserve the current literals.

---

## Section A — #97: centralize ReCost URLs

### `src/config.ts`

```ts
const PROD_API_BASE_URL = "https://api.recost.dev";
const PROD_DASHBOARD_BASE_URL = "https://recost.dev";

export const RECOST_API_BASE_URL =
  process.env.RECOST_API_BASE_URL?.trim() || PROD_API_BASE_URL;

export const RECOST_DASHBOARD_BASE_URL =
  process.env.RECOST_DASHBOARD_BASE_URL?.trim() || PROD_DASHBOARD_BASE_URL;
```

Design notes:
- **Trim + truthiness** — empty / whitespace-only env vars fall back to production defaults instead of silently producing a broken URL.
- **Dashboard URL has no `/dashboard` suffix** — call sites append their own path (`/dashboard/account`, `/dashboard/projects/${id}`). Keeping suffixes at the call site preserves grep-ability and lets a future marketing-site URL diverge from dashboard cleanly without a config split.
- **Module load-time resolution** — env vars are read once when the module is first imported. Changing env vars at runtime won't affect already-loaded constants. Matches Node convention; restart of the extension host (or VSCode reload) picks up changes.
- **No `process.env` access in webview code** — `process.env` is only available in the extension host (Node.js context). All five call sites being migrated live in extension-host code, so this is safe.

### Call site migration

| File | Before | After |
|------|--------|-------|
| `src/api-client.ts:3` | `const BASE_URL = "https://api.recost.dev";` | `import { RECOST_API_BASE_URL } from "./config";` then `const BASE_URL = RECOST_API_BASE_URL;` |
| `src/extension.ts:17` | `const GET_KEY_URL = "https://recost.dev/dashboard/account";` | `import { RECOST_DASHBOARD_BASE_URL } from "./config";` then `const GET_KEY_URL = \`${RECOST_DASHBOARD_BASE_URL}/dashboard/account\`;` |
| `src/extension.ts:18` | `const PRICING_BACKEND_URL = "https://api.recost.dev";` | `const PRICING_BACKEND_URL = RECOST_API_BASE_URL;` (after adding the import) |
| `src/chat/providers/eco.ts:7` | `baseUrl: "https://api.recost.dev",` | `import { RECOST_API_BASE_URL } from "../../config";` then `baseUrl: RECOST_API_BASE_URL,` |
| `src/webview-provider.ts:734-735` | `` `https://recost.dev/dashboard/projects/${targetProjectId}` `` and `"https://recost.dev/dashboard/projects"` | `` `${RECOST_DASHBOARD_BASE_URL}/dashboard/projects/${targetProjectId}` `` and `` `${RECOST_DASHBOARD_BASE_URL}/dashboard/projects` `` |

### Tests

`src/test/config.test.ts` (new):
- **Default behavior** — with `RECOST_API_BASE_URL` and `RECOST_DASHBOARD_BASE_URL` unset, the exported constants equal the production literals.
- **Override behavior** — module-load reads are cached after first import, so this test must spawn a sub-process (`child_process.spawnSync` with `node -e "..."`) to test that env vars override the defaults. Two cases: `https://staging.recost.dev` (typical override) and `   ` (whitespace-only, must fall back to default).
- **Tradeoff** — spawning a sub-process is more expensive than an inline test but is the only way to test load-time resolution without refactoring `config.ts` to export a resolver function. The simplicity of `export const X = process.env.X?.trim() || DEFAULT;` is worth the slightly heavier test.

---

## Section B — #98: collision-resistant local scanId

### `src/scan-id.ts`

```ts
import { randomUUID } from "crypto";

export function newLocalScanId(): string {
  const suffix = randomUUID().replace(/-/g, "").slice(0, 8);
  return `local-${Date.now()}-${suffix}`;
}
```

Design notes:
- **Format** — `local-1716501234567-a1b2c3d4`. Human-readable timestamp prefix preserved for log/debug filtering; 32 bits of entropy in the suffix means collision probability inside a single millisecond is ~2⁻³² ≈ 2.3e-10, which is far past the 1 ms collision window the issue flagged. For a typical extension session that generates fewer than a few thousand local scans total, total collision probability rounds to zero.
- **Why `randomUUID()` instead of `randomBytes(4).toString("hex")`** — both work; `randomUUID()` is what the issue suggested. Stripping dashes before slicing means `slice(0, 8)` returns 8 hex chars (`a1b2c3d4`) rather than 7 chars + a dash (`a1b2c3d-`).
- **Why a helper, not inline** — centralizes the format so future changes (longer entropy, different prefix, etc.) touch one place. Also makes the function trivially mockable in tests.
- **Format compatibility audit** — confirmed via grep: no code anywhere does `scanId.startsWith("local-")` or otherwise discriminates on the format. The hyphen-delimited shape is unchanged from the old `local-${ts}` form (just with a third segment appended), so any code that splits on `-` and reads the first two segments still works.

### Call site migration

Eight call sites become `newLocalScanId()`:

| File | Lines |
|------|-------|
| `src/cli/scan.ts` | 229 |
| `src/webview/chat-handler.ts` | 414 (used as a fallback when `lastEndpoints[0]?.scanId` is undefined) |
| `src/webview/scan-publishing-handler.ts` | 666, 678, 688, 703, 793, 817 |

All sites currently use `` `local-${Date.now()}` ``; replace verbatim with `newLocalScanId()` plus the import.

### Tests

`src/test/scan-id.test.ts` (new):
- **Format** — `newLocalScanId()` matches the regex `/^local-\d+-[0-9a-f]{8}$/`.
- **Uniqueness** — 1000 sequential calls produce 1000 distinct IDs (regression test for #98 — fails with the old `local-${Date.now()}` form in roughly any run that takes < 1 ms per iteration).
- **Timestamp prefix is non-decreasing** — across 100 calls, the integer parsed from segment 2 of each ID never goes backwards (sanity check that `Date.now()` is in fact used).

---

## Verification gates

Standard:
- `npm run test:scanner` — existing + new `config` + new `scan-id` tests pass.
- `npm run build` — clean.

Grep gates (must pass before merge):
- `grep -rn "api.recost.dev\|recost.dev/dashboard" src/` returns hits only inside `src/config.ts`. CLAUDE.md and fingerprint docs may still contain the literals (out of scope).
- `grep -rn 'local-\${Date.now()}' src/` returns zero hits.

Manual EDH gate (low effort, 30 seconds):
- Start the EDH, confirm status bar still shows "Connected" / "Not Configured" correctly and that the "Get a key" / "Open dashboard" links still resolve to `https://recost.dev/...`. Both should be visually identical to current behavior because defaults preserve the literals.

D1 benchmark sanity: Δ +0.00pp (no scanner change expected; only string-literal centralization).

---

## Files touched

| File | Change |
|------|--------|
| `src/config.ts` (new) | `RECOST_API_BASE_URL`, `RECOST_DASHBOARD_BASE_URL` constants with env-var override |
| `src/scan-id.ts` (new) | `newLocalScanId()` helper using `crypto.randomUUID()` |
| `src/api-client.ts` | Import + use `RECOST_API_BASE_URL` |
| `src/extension.ts` | Import + use both URL constants |
| `src/chat/providers/eco.ts` | Import + use `RECOST_API_BASE_URL` |
| `src/webview-provider.ts` | Import + use `RECOST_DASHBOARD_BASE_URL` in template literals |
| `src/cli/scan.ts` | Import + use `newLocalScanId()` |
| `src/webview/chat-handler.ts` | Import + use `newLocalScanId()` |
| `src/webview/scan-publishing-handler.ts` | Import + 6 call sites switch to `newLocalScanId()` |
| `src/test/config.test.ts` (new) | Default + env-override + whitespace fallback coverage |
| `src/test/scan-id.test.ts` (new) | Format + uniqueness + monotonic timestamp coverage |
| `package.json` | Register both new tests in `scripts.test:scanner` |

No removed files. No IPC message changes. No scanner/detector impact.
