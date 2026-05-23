# Wave 8 — Status / Error UX Design

**Date:** 2026-05-22
**Closes:** #94, #100, #46
**Wave label:** `wave/8-status-error-ux`
**Area:** `area/extension-ux`
**PR shape:** one bundled PR

## Goal

Three related defects on the same auth/indicator surface ship together:

1. **#94** — `validateApiKey()` treats a 404 from `/auth/me` as "valid in dev mode," fail-open at the auth boundary.
2. **#100** — Scan submission catches a 429 from the API and surfaces nothing to the user.
3. **#46** — The status-bar indicator switches state randomly and doesn't always update when it should.

## Non-goals

- SDK-side 429 handling (tracked separately in `middleware-node` and `middleware-python`).
- State-machine overhaul of the indicator. The current five-state model is fine; only the trigger plumbing is broken.
- Any change to `validateRcApiKey()` (the function that hits `/projects?limit=1`). It has no bug. We only clean up CLAUDE.md naming confusion that swapped the two functions.

## Architecture

All changes live in four files plus tests:

- `src/api-client.ts` — `validateApiKey()` and `apiFetch()`
- `src/extension.ts` — status-bar refresh plumbing
- `src/webview-provider.ts` — wire `refreshStatusBar` through the context interface that scan-publishing-handler consumes
- `src/webview/scan-publishing-handler.ts` — scan-error catch block
- CLAUDE.md — naming fix in the "Auth / API Key System" section

No new modules, no IPC surface changes, no scanner/detector impact.

---

## Section A — #94: remove the 404-as-valid branch

### Current behavior

`validateApiKey()` at `src/api-client.ts:136-152` calls `GET /auth/me` and:

- 200 → returns `AuthMeUser`.
- 401 → throws (status: 401).
- 404 → returns `null`, treated as valid ("dev mode").
- Network error → throws (no status).

The 404 branch is a fail-open at the auth boundary. Any future API regression that makes `/auth/me` 404 silently marks every key as valid.

### Change

```ts
export async function validateApiKey(key: string): Promise<AuthMeUser> {
  if (!key.startsWith("rc-")) {
    const err = new Error("Invalid ReCost API key — keys must start with rc-") as Error & { status: number };
    err.status = 401;
    throw err;
  }
  const { data } = await apiFetch<{ data: AuthMeUser }>("/auth/me", undefined, key);
  return data;
}
```

- Return type drops `| null`.
- Try/catch removed; 404 now propagates normally via `apiFetch`'s default behavior (`status: 404`, message `API error 404`).
- JSDoc updated to remove dev-mode mention.

### Callsite update — `src/extension.ts:44-94`

The `if (user) { ... } else { ... }` branch on `validateApiKey`'s return collapses because `user` is always present on success. The email-bearing status text becomes unconditional.

In the catch block, a 404 falls into the `error.status !== 401` path — meaning it's treated as a transient/network-style error and goes through the persisted-snapshot fallback. This is intentional:

- One-off 404 on a previously-valid key → grace period via snapshot.
- 404 on a brand-new key (no snapshot) → marks invalid.

### CLAUDE.md fix

The "Auth / API Key System" section currently says `validateRcApiKey()` calls `/auth/me`. It doesn't — `validateApiKey()` does. Rename in the doc to remove the cross-reference confusion.

### Tests

`src/test/api-client.test.ts`:
- Drop any test that asserts 404 → null on `validateApiKey`.
- Add: `validateApiKey` throws with `status: 404` when the backend returns 404.

---

## Section B — #100: surface 429 with Retry-After

### Current behavior

The scan-submission catch block at `src/webview/scan-publishing-handler.ts:778-814` handles:

- 401 / 403 (auth-like) — invalidates key, opens Keys tab.
- 404 with manual project ID — posts a scanNotification.
- `"fetch failed"` — posts a scanNotification.

A 429 falls through with no notification. `publishLocalOnlyResults` runs earlier in the catch chain so the user does see local findings — but no signal that they were rate-limited.

### Change 1 — plumb Retry-After

`src/api-client.ts:26-32` (`apiFetch` error path):

```ts
if (!res.ok) {
  const body = await res.json().catch(() => ({})) as ApiError;
  const msg = body?.error?.message ?? `API error ${res.status}`;
  const err = new Error(msg) as Error & { status: number; retryAfterSeconds?: number };
  err.status = res.status;
  if (res.status === 429) {
    const header = res.headers.get("Retry-After");
    const parsed = header !== null ? Number.parseInt(header, 10) : NaN;
    if (Number.isFinite(parsed) && parsed >= 0) {
      err.retryAfterSeconds = parsed;
    }
  }
  throw err;
}
```

Defensive parsing: header can also be an HTTP-date per RFC 7231, but our API emits seconds. Unparseable values are silently dropped — the message degrades to a generic "in a moment" form.

### Change 2 — catch-block branch

`src/webview/scan-publishing-handler.ts` — insert before the existing `authLikeFailure` check:

```ts
if (status === 429) {
  const retryAfter = (err as { retryAfterSeconds?: number }).retryAfterSeconds;
  const waitText = retryAfter !== undefined
    ? `Try again in ${retryAfter} second${retryAfter === 1 ? "" : "s"}.`
    : "Try again in a moment.";
  this.ctx.postMessage({
    type: "scanNotification",
    message: `ReCost scan rate limit reached. ${waitText} Showing local results.`,
  });
  publishLocalOnlyResults(manualProjectId ?? this.ctx.getProjectId() ?? "local", `local-${Date.now()}`);
  return;
}
```

Placement notes:
- Goes **before** `authLikeFailure` (no overlap: 429 ≠ 401/403).
- Goes **before** the 404 / fetch-failed branches.
- Returns early so the rest of the catch block does not run.
- `publishLocalOnlyResults` called explicitly so the user still sees local findings — matches the existing pattern.

### Tests

Add a new `src/test/scan-publishing-handler.test.ts` (no existing test file for this handler; the closest, `webview-provider-dispatch.test.ts`, is scoped to IPC dispatch):
- Stub a 429 response with `Retry-After: 42`; assert the scanNotification message contains `42 seconds` and local results are published.
- Stub a 429 without `Retry-After`; assert the generic "in a moment" message.

---

## Section C — #46: status-bar indicator audit

The user-visible symptom is "state switches randomly and doesn't always switch." The audit found four concrete bugs. No state-machine overhaul; targeted fixes only.

### Bug A — scan-side 401 doesn't refresh the status bar

`src/webview/scan-publishing-handler.ts:788-797` updates `setValidationState` (persistence) and `sendRecostKeyStatusUpdate` (sidebar UI) on an auth-like scan failure. Neither touches the status bar.

The status bar only refreshes via:
- `secrets.onDidChange` — but the secret didn't change here.
- `onDidChangeWindowState` focus.
- `onDidChangeWorkspaceFolders`.
- Manual commands.

Result: revoked key surfaces in the sidebar but the status bar still shows "Connected" until the user alt-tabs away and back.

**Fix:** add a `refreshStatusBar()` callback to the webview-provider context (the interface that already exposes `setRecostValidationState` and `sendRecostKeyStatusUpdate`). The activate-time wire-up in `extension.ts` provides an implementation that calls `scheduleKeyIndicatorRefresh(statusBar, context, statusOutput, "scanAuthFailure")`. Call it from the scan-side auth-failure handler immediately after `sendRecostKeyStatusUpdate()`.

### Bug B — concurrent validations race

`scheduleKeyIndicatorRefresh` is fire-and-forget; no in-flight guard. Two triggers close together start two `/auth/me` calls in parallel, and `statusBar.text`/`color` are written by whichever finishes last — not necessarily the most recent start. This produces "switching randomly" under any combination of (focus + secret change + command).

**Fix:** generation counter inside `updateStatusBar`. A module-level `let validationGeneration = 0`. Each call captures `const myGen = ++validationGeneration` at the top. Before each write to `statusBar.text` / `statusBar.color` / `setContext("recost.keyOnline", …)`, the call checks `if (myGen !== validationGeneration) return;`. Stale completions silently no-op.

The check goes after every `await` boundary where a newer call could have started — in practice, after the `validateApiKey()` await and after `hasPersistedValidEcoKey()` awaits.

### Bug C — window-focus trigger is too aggressive

`onDidChangeWindowState` fires every alt-tab back into VS Code, kicking a fresh `/auth/me`. Combined with Bug B, this is the most common flicker source.

**Fix:** debounce focus-only triggers. Track `let lastValidationAt = 0` at module scope. In `scheduleKeyIndicatorRefresh`, if `reason === "windowFocused"` and `Date.now() - lastValidationAt < 60_000`, skip the call. All other reasons (manual commands, secret change, scan auth failure) bypass the debounce — explicit user intent or state-changing events override.

Set `lastValidationAt = Date.now()` at the end of every `updateStatusBar` call (success or failure, after the generation check).

### Bug D — workspace-folder trigger is noise

`vscode.workspace.onDidChangeWorkspaceFolders` at `src/extension.ts:251-254` triggers a refresh on multi-root changes. Workspace folder identity has nothing to do with ReCost auth state.

**Fix:** delete the listener and its subscription registration.

### What is NOT changing

- The five status-bar states (`Not Configured`, `Connected`, `Auth Check Failed`, `Invalid Key`, `Unreachable`) stay.
- The persisted-snapshot fallback semantics stay.
- The `secrets.onDidChange` trigger stays.
- Manual-command triggers (openPanel, openKeys, scanWorkspace) stay.

### Tests

Unit tests:
- Generation counter: race two `updateStatusBar` calls where the older finishes second; assert final state reflects the newer call. This requires DI for the validation function and the status-bar item; if the wiring gets ugly, drop the unit test and rely on manual EDH gate B.
- Focus debounce: simulate two `windowFocused` triggers within 60s; assert only one `validateApiKey` fetch fires.

Integration test:
- Wire a stubbed scan response that returns 401; assert that after the catch block runs, the status-bar refresh callback was invoked.

Manual EDH gates (added to PR test plan, unchecked at PR open):
1. Revoke key in dashboard → run scan → confirm status bar flips to "Invalid Key" (not just sidebar). Tests Bug A.
2. Alt-tab away and back 5x rapidly while connected → status text stays "Connected", no flicker. Tests Bugs B + C.
3. Configure a fresh invalid key that returns 404 from `/auth/me` → status bar shows "Invalid Key", not "Connected". Tests #94.
4. Submit 11 scans within 60s → 11th run shows the rate-limit scanNotification with a wait time. Tests #100.

---

## Verification gates

Standard:
- `npm run build` clean.
- `npm test` passes (existing + new tests).
- D1 benchmark Δ +0.00pp (no scanner change expected; run as sanity).

Manual EDH gates: see Section C tests above.

---

## Files touched

| File | Purpose |
|------|---------|
| `src/api-client.ts` | Remove 404 branch in `validateApiKey`; plumb `retryAfterSeconds` in `apiFetch` |
| `src/extension.ts` | Generation counter, focus debounce, drop workspace-folders trigger, expose `refreshStatusBar` callback, collapse `if (user)` branch |
| `src/webview/scan-publishing-handler.ts` | 429 catch branch with Retry-After; invoke `refreshStatusBar` from auth-failure handler |
| `src/webview-provider.ts` | Wire `refreshStatusBar` through the context interface |
| `src/test/api-client.test.ts` | Update 404 test; add Retry-After tests |
| `src/test/scan-publishing-handler.test.ts` (new) | 429 scanNotification tests |
| `CLAUDE.md` | Rename `validateRcApiKey` → `validateApiKey` in the auth section |

No new files. No removed files.
