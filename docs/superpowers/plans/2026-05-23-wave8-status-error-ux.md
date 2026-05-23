# Wave 8 — Status / Error UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close #94 (404-as-valid fail-open), #100 (silent 429 on scan submit), and #46 (status-bar indicator flicker) in one bundled PR.

**Architecture:** Three small, independent fixes share the same auth/indicator surface, so they ship together with a single test pass.
1. `validateApiKey()` drops the 404 → null branch and now propagates 404 like any other error.
2. `apiFetch()` annotates 429 errors with a parsed `retryAfterSeconds`; the scan-publishing catch-block surfaces a `scanNotification` and still publishes local results.
3. The status-bar refresh path gains (a) a generation counter to drop stale writes, (b) a 60-second debounce on `windowFocused` triggers only, (c) deletion of the workspace-folders trigger, and (d) a `refreshStatusBar` callback wired through `ReCostSidebarProvider` so the scan-side auth-failure branch can refresh the status bar without waiting for focus.

**Tech Stack:** TypeScript (strict), Node test runner via `node:assert/strict`, `tsc -p tsconfig.scanner-tests.json`, esbuild for extension build.

---

## File Structure

| File | Change |
|------|--------|
| `src/api-client.ts` | Remove 404 branch in `validateApiKey`; drop `\| null` from return type; refresh JSDoc. In `apiFetchWith`, parse `Retry-After` on 429 and attach `err.retryAfterSeconds`. |
| `src/extension.ts` | Add `validationGeneration` + `lastValidationAt` module-level state. Insert generation check in `updateStatusBar`. Add focus debounce in `scheduleKeyIndicatorRefresh`. Delete `onDidChangeWorkspaceFolders` subscription. Collapse the `if (user)` branch. Export `scheduleKeyIndicatorRefresh` indirectly to the provider via a callback. |
| `src/webview-provider.ts` | Constructor accepts an optional `refreshStatusBar?: () => void`. Wire it through to `ScanPublishingHandler` via the context. |
| `src/webview/scan-publishing-handler.ts` | Add `refreshStatusBar()` to `ScanPublishingHandlerContext`. Call it inside the auth-failure branch after `sendRecostKeyStatusUpdate()`. Add a new 429 branch above the auth-like check that posts `scanNotification` with Retry-After text and publishes local results. |
| `src/test/api-client.test.ts` | Drop the 404-returns-null test. Add: 404 throws, 429 attaches `retryAfterSeconds`, 429 without header attaches `undefined`. |
| `src/test/scan-publishing-handler.test.ts` (new) | Cover the 429 branch end-to-end via stubbed `submitScan` rejection. |
| `package.json` | Register the new test file under `scripts.test:scanner`. |
| `CLAUDE.md` | Rename `validateRcApiKey()` → `validateApiKey()` in the "Auth / API Key System" bullet; remove the dev-mode 404 wording. |

No new modules. No removed files. No IPC message changes.

---

## Task 1: Drop the 404-as-valid branch in `validateApiKey`

**Files:**
- Modify: `src/api-client.ts:126-152`
- Test: `src/test/api-client.test.ts:81-90` (drop), then add new 404-throws case

- [ ] **Step 1: Update the 404 test to expect a throw (failing)**

Replace the existing case 5 block (lines 81-90 of `src/test/api-client.test.ts`) with:

```ts
  // 5. validateApiKey throws with status: 404 when /auth/me returns 404
  {
    const restore = installFetch(() => new Response("", { status: 404 }));
    try {
      let caught: (Error & { status?: number }) | null = null;
      try {
        await validateApiKey("rc-validlooking");
      } catch (err) {
        caught = err as Error & { status?: number };
      }
      assert.ok(caught, "expected validateApiKey to throw on 404");
      assert.equal(caught!.status, 404);
    } finally {
      restore();
    }
  }
```

- [ ] **Step 2: Run the test suite to verify it fails**

Run:
```bash
npm run test:scanner 2>&1 | tail -40
```

Expected: `api-client` test fails with `AssertionError [ERR_ASSERTION]: expected validateApiKey to throw on 404`. Every other test still passes.

- [ ] **Step 3: Update `validateApiKey` in `src/api-client.ts`**

Replace lines 126-152 (the `AuthMeUser` interface, JSDoc, and function) with:

```ts
export interface AuthMeUser {
  email: string;
}

/**
 * Validates an API key against GET /auth/me.
 * Returns AuthMeUser on success.
 * Throws with err.status === 401 for invalid key.
 * Throws with err.status === <code> for other HTTP errors (including 404).
 * Throws without .status for network errors.
 */
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

- [ ] **Step 4: Run the test suite to verify it passes**

Run:
```bash
npm run test:scanner 2>&1 | tail -10
```

Expected: All tests pass. The line `PASS api-client` appears in the output.

- [ ] **Step 5: Collapse the `if (user)` branch in `src/extension.ts`**

`validateApiKey` no longer returns `null`, so the `else` branch on line 50-54 of `src/extension.ts` is dead. Replace lines 44-57 (`try { const user = await validateApiKey(key); ... return true; }`) with:

```ts
  try {
    const user = await validateApiKey(key);
    logStatus(output, `updateStatusBar: validateApiKey succeeded for ${user.email}; setting keyOnline=true`);
    statusBar.text = `$(check) ReCost: ${user.email}`;
    statusBar.tooltip = `Connected as ${user.email}`;
    statusBar.color = new vscode.ThemeColor("testing.iconPassed");
    await vscode.commands.executeCommand("setContext", "recost.keyOnline", true);
    return true;
  } catch (err: unknown) {
```

The catch block on lines 58-93 is untouched — a 404 falls through to the `error.status !== 401` path (transient/network style) which uses the persisted-snapshot fallback. This is the intended behavior per the spec.

- [ ] **Step 6: Verify the build still typechecks**

Run:
```bash
npm run build:ext 2>&1 | tail -5
```

Expected: build succeeds with no TypeScript errors. If TS complains that `user` could be `null` somewhere else, search for other call sites: `grep -rn "validateApiKey" src/`. Only `extension.ts` should call it.

- [ ] **Step 7: Commit**

```bash
git add src/api-client.ts src/extension.ts src/test/api-client.test.ts
git commit -m "fix(wave8): validateApiKey no longer treats 404 as valid (#94)"
```

---

## Task 2: Plumb `Retry-After` through `apiFetch`

**Files:**
- Modify: `src/api-client.ts:13-34` (`apiFetchWith` error path)
- Test: `src/test/api-client.test.ts` — add two new cases at the end of `runTests()` (before `console.log("PASS api-client")`)

- [ ] **Step 1: Write the failing tests**

Add these two blocks immediately before the `console.log("PASS api-client");` line in `src/test/api-client.test.ts`:

```ts
  // 8. apiFetch attaches retryAfterSeconds on 429 with numeric Retry-After
  {
    const restore = installFetch(
      () =>
        new Response(JSON.stringify({ error: { message: "rate limited" } }), {
          status: 429,
          headers: { "Retry-After": "42" },
        })
    );
    try {
      let caught: (Error & { status?: number; retryAfterSeconds?: number }) | null = null;
      try {
        await validateApiKey("rc-good");
      } catch (err) {
        caught = err as Error & { status?: number; retryAfterSeconds?: number };
      }
      assert.ok(caught, "expected validateApiKey to throw on 429");
      assert.equal(caught!.status, 429);
      assert.equal(caught!.retryAfterSeconds, 42);
    } finally {
      restore();
    }
  }

  // 9. apiFetch leaves retryAfterSeconds undefined when Retry-After is absent or non-numeric
  {
    const restore = installFetch(
      () =>
        new Response(JSON.stringify({ error: { message: "rate limited" } }), {
          status: 429,
        })
    );
    try {
      let caught: (Error & { status?: number; retryAfterSeconds?: number }) | null = null;
      try {
        await validateApiKey("rc-good");
      } catch (err) {
        caught = err as Error & { status?: number; retryAfterSeconds?: number };
      }
      assert.ok(caught, "expected validateApiKey to throw on 429");
      assert.equal(caught!.status, 429);
      assert.equal(caught!.retryAfterSeconds, undefined);
    } finally {
      restore();
    }
  }
```

- [ ] **Step 2: Run the test to verify it fails**

Run:
```bash
npm run test:scanner 2>&1 | tail -20
```

Expected: case 8 fails because `caught.retryAfterSeconds` is `undefined` instead of `42`.

- [ ] **Step 3: Update `apiFetchWith` error path in `src/api-client.ts`**

Replace lines 26-32 (the `if (!res.ok)` block) with:

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

Notes:
- Header parsing is defensive — RFC 7231 allows an HTTP-date, but our API emits integer seconds. Unparseable values silently drop to `undefined`, which the UI degrades to a generic "in a moment" message.
- `Number.parseInt` returns `NaN` for the empty string, so the `Number.isFinite` guard covers both "missing" and "unparseable."

- [ ] **Step 4: Run the test to verify it passes**

Run:
```bash
npm run test:scanner 2>&1 | tail -10
```

Expected: `PASS api-client` appears; all other tests still pass.

- [ ] **Step 5: Commit**

```bash
git add src/api-client.ts src/test/api-client.test.ts
git commit -m "feat(wave8): plumb Retry-After seconds through apiFetch 429 errors"
```

---

## Task 3: Add 429 branch to scan-publishing catch block

**Files:**
- Modify: `src/webview/scan-publishing-handler.ts:778-814`
- Test: `src/test/scan-publishing-handler.test.ts` (new)
- Modify: `package.json` (add new test to `test:scanner`)

- [ ] **Step 1: Create the failing test file**

Create `src/test/scan-publishing-handler.test.ts`:

```ts
import assert from "node:assert/strict";
import Module from "node:module";

// Stub `vscode` before any dependency tries to require it.
const originalResolve = (Module as unknown as {
  _resolveFilename: (req: string, parent: unknown) => string;
})._resolveFilename;
(Module as unknown as {
  _resolveFilename: (req: string, parent: unknown) => string;
})._resolveFilename = function (request: string, parent: unknown) {
  if (request === "vscode") return require.resolve("./vscode-stub");
  return originalResolve.call(this, request, parent);
};

// Stub the workspace-scanner before scan-publishing-handler is imported, so we
// can drive handleStartScan() without touching the real scanner.
const scannerStub = {
  scanWorkspace: async () => [],
  detectLocalWastePatterns: async () => [],
  countScopedWorkspaceFiles: async () => 0,
  getWorkspaceScanFiles: async () => [],
};
require.cache[require.resolve("../scanner/workspace-scanner")] = {
  id: require.resolve("../scanner/workspace-scanner"),
  filename: require.resolve("../scanner/workspace-scanner"),
  loaded: true,
  exports: scannerStub,
} as unknown as NodeJS.Module;

// Stub api-client.submitScan to reject with the status we want to test.
let nextScanError: (Error & { status?: number; retryAfterSeconds?: number }) | null = null;
require.cache[require.resolve("../api-client")] = {
  id: require.resolve("../api-client"),
  filename: require.resolve("../api-client"),
  loaded: true,
  exports: {
    createProject: async () => "proj-stub",
    submitScan: async () => {
      if (nextScanError) throw nextScanError;
      return { scanId: "scan-stub", summary: { totalEndpoints: 0, redundantCalls: 0, n1Suspects: 0, batchOpportunities: 0, cacheOpportunities: 0 } };
    },
    getAllEndpoints: async () => [],
    getAllSuggestions: async () => [],
  },
} as unknown as NodeJS.Module;

import { ScanPublishingHandler, type ScanPublishingHandlerContext } from "../webview/scan-publishing-handler";
import type { HostMessage } from "../messages";

function makeCtx(posted: HostMessage[]): ScanPublishingHandlerContext {
  const noop = async () => {};
  return {
    postMessage: (m) => { posted.push(m); },
    context: { secrets: { get: async () => undefined }, globalState: { get: () => undefined, update: noop }, workspaceState: { get: () => undefined, update: noop } } as never,
    setLastEndpoints: () => {},
    setLastSuggestions: () => {},
    setLastSummary: () => {},
    setLastApiCalls: () => {},
    setLastFindings: () => {},
    setProjectId: () => {},
    getProjectId: () => null,
    getManualProjectId: () => null,
    getRcApiKey: async () => "rc-good",
    resolveScanProjectTarget: async () => ({ projectId: "proj-stub", source: "auto" }),
    getWorkspaceName: () => "ws",
    openKeys: () => {},
    setRecostValidationState: noop,
    clearRecostValidationState: noop,
    sendRecostKeyStatusUpdate: noop,
    refreshStatusBar: () => {},
    resetChatHistory: () => {},
    exportDebugScanResults: noop,
    pruneSavedScenariosAgainst: noop,
  };
}

async function runTests() {
  // 1. 429 with Retry-After: 42 surfaces a scanNotification with "42 seconds" and publishes local results
  {
    const posted: HostMessage[] = [];
    const err = new Error("rate limited") as Error & { status: number; retryAfterSeconds: number };
    err.status = 429;
    err.retryAfterSeconds = 42;
    nextScanError = err;
    const handler = new ScanPublishingHandler(makeCtx(posted));
    await handler.handleStartScan();
    const notification = posted.find((m) => m.type === "scanNotification") as { type: "scanNotification"; message: string } | undefined;
    assert.ok(notification, "expected a scanNotification message");
    assert.match(notification!.message, /42 seconds/);
    assert.match(notification!.message, /local results/i);
  }

  // 2. 429 without Retry-After surfaces the generic "in a moment" message
  {
    const posted: HostMessage[] = [];
    const err = new Error("rate limited") as Error & { status: number };
    err.status = 429;
    nextScanError = err;
    const handler = new ScanPublishingHandler(makeCtx(posted));
    await handler.handleStartScan();
    const notification = posted.find((m) => m.type === "scanNotification") as { type: "scanNotification"; message: string } | undefined;
    assert.ok(notification, "expected a scanNotification message");
    assert.match(notification!.message, /in a moment/);
  }

  // 3. 429 with retryAfterSeconds: 1 produces "1 second" (singular)
  {
    const posted: HostMessage[] = [];
    const err = new Error("rate limited") as Error & { status: number; retryAfterSeconds: number };
    err.status = 429;
    err.retryAfterSeconds = 1;
    nextScanError = err;
    const handler = new ScanPublishingHandler(makeCtx(posted));
    await handler.handleStartScan();
    const notification = posted.find((m) => m.type === "scanNotification") as { type: "scanNotification"; message: string } | undefined;
    assert.ok(notification, "expected a scanNotification message");
    assert.match(notification!.message, /1 second\b/);
  }

  // 4. 401 calls refreshStatusBar() exactly once after sendRecostKeyStatusUpdate
  {
    const posted: HostMessage[] = [];
    let refreshCalls = 0;
    let sentKeyUpdate = false;
    let refreshedAfterUpdate = false;
    const err = new Error("invalid auth") as Error & { status: number };
    err.status = 401;
    nextScanError = err;
    const ctx: ScanPublishingHandlerContext = {
      ...makeCtx(posted),
      sendRecostKeyStatusUpdate: async () => { sentKeyUpdate = true; },
      refreshStatusBar: () => {
        refreshCalls++;
        if (sentKeyUpdate) refreshedAfterUpdate = true;
      },
    };
    const handler = new ScanPublishingHandler(ctx);
    await handler.handleStartScan();
    assert.equal(refreshCalls, 1);
    assert.equal(refreshedAfterUpdate, true, "refreshStatusBar must be called after sendRecostKeyStatusUpdate");
  }

  console.log("PASS scan-publishing-handler");
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

- [ ] **Step 2: Register the new test in `package.json`**

Open `package.json`, find the `test:scanner` script (currently the only line inside `"scripts"` starting with `"test:scanner":`). Append ` && node dist-test/test/scan-publishing-handler.test.js` to the end of the command string (immediately before the closing `"`). Do not reorder existing entries.

- [ ] **Step 3: Run the test to verify it fails**

Run:
```bash
npm run test:scanner 2>&1 | tail -30
```

Expected: `scan-publishing-handler` fails. The most likely failure is that `posted` contains no `scanNotification`, or `refreshStatusBar` is not part of the context type. If the failure is a TypeScript error about `refreshStatusBar` missing on `ScanPublishingHandlerContext`, that is exactly what we need to add in the next step.

- [ ] **Step 4: Add `refreshStatusBar` to the handler context**

In `src/webview/scan-publishing-handler.ts`, modify `ScanPublishingHandlerContext` (around line 45-66) — add the property `refreshStatusBar(): void;` immediately after `sendRecostKeyStatusUpdate`. The full added line:

```ts
  refreshStatusBar(): void;
```

- [ ] **Step 5: Insert the 429 branch and `refreshStatusBar` call**

In `src/webview/scan-publishing-handler.ts`, replace lines 778-814 (the entire `catch (err: unknown) { ... }` block ending right before the outer try's closing `}`) with:

```ts
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : "Remote analysis failed";
        const status = (err as { status?: number }).status;

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

        const authLikeFailure =
          status === 401 ||
          (status === 403 && /invalid|unauthori[sz]ed|forbidden|auth/i.test(message));

        if (authLikeFailure) {
          const rcKey = await this.ctx.getRcApiKey();
          if (rcKey) {
            await this.ctx.setRecostValidationState({
              state: "invalid",
              message,
              lastCheckedAt: new Date().toISOString(),
              keyFingerprint: buildKeyFingerprint(rcKey),
            });
          } else {
            await this.ctx.clearRecostValidationState();
          }
          await this.ctx.sendRecostKeyStatusUpdate();
          this.ctx.refreshStatusBar();
          this.ctx.openKeys("recost");
        }
        publishLocalOnlyResults(manualProjectId ?? this.ctx.getProjectId() ?? "local", `local-${Date.now()}`);
        if (status === 404 && manualProjectId) {
          this.ctx.postMessage({
            type: "scanNotification",
            message: `Project ID ${manualProjectId} was not found. Keeping the saved manual Project ID and showing local results.`,
          });
          return;
        }
        if (err instanceof Error && err.message === "fetch failed") {
          this.ctx.postMessage({
            type: "scanNotification",
            message: "Could not reach ReCost server. Showing local results.",
          });
        }
      }
```

Placement reminders (already reflected above):
- 429 branch runs **before** the auth-like check. No overlap because 429 ≠ 401/403.
- 429 branch calls `publishLocalOnlyResults` explicitly and `return`s — none of the later branches run.
- `this.ctx.refreshStatusBar()` runs inside `authLikeFailure`, immediately after `sendRecostKeyStatusUpdate()`.

- [ ] **Step 6: Provide a stub `refreshStatusBar` in `webview-provider.ts`**

The provider must satisfy the new context property. Open `src/webview-provider.ts` and modify the `new ScanPublishingHandler({ ... })` literal (lines 236-257). Add this line right after `sendRecostKeyStatusUpdate: () => this.sendKeyStatusUpdate("recost", "recost"),` (currently line 253):

```ts
      refreshStatusBar: () => { this.refreshStatusBar?.(); },
```

Then add a private optional field near the top of the class (right before the constructor, after the other private declarations). Search for `private readonly scanPublishingHandler: ScanPublishingHandler;` and add right after it:

```ts
  private refreshStatusBar?: () => void;
```

Modify the constructor signature on line 198 from:
```ts
  constructor(context: vscode.ExtensionContext) {
```
to:
```ts
  constructor(context: vscode.ExtensionContext, refreshStatusBar?: () => void) {
```

And inside the constructor body, immediately after `this.context = context;` (line 199), add:
```ts
    this.refreshStatusBar = refreshStatusBar;
```

- [ ] **Step 7: Wire the callback in `extension.ts`**

Open `src/extension.ts`. Find line 152: `const provider = new ReCostSidebarProvider(context);` and replace with:

```ts
  const provider = new ReCostSidebarProvider(context, () => {
    scheduleKeyIndicatorRefresh(statusBar, context, statusOutput, "scanAuthFailure");
  });
```

The callback can reference `statusBar`, `context`, and `statusOutput` because line 152 is after their declarations (lines 135-152).

- [ ] **Step 8: Run the test to verify it passes**

Run:
```bash
npm run test:scanner 2>&1 | tail -10
```

Expected: `PASS scan-publishing-handler` plus all other tests pass.

- [ ] **Step 9: Verify the build still typechecks**

Run:
```bash
npm run build 2>&1 | tail -10
```

Expected: webview + extension build succeed.

- [ ] **Step 10: Commit**

```bash
git add src/webview/scan-publishing-handler.ts src/webview-provider.ts src/extension.ts src/test/scan-publishing-handler.test.ts package.json
git commit -m "feat(wave8): surface 429 with Retry-After and refresh status bar on scan auth failure (#100, #46 Bug A)"
```

---

## Task 4: Generation counter — drop stale status-bar writes (#46 Bug B)

**Files:**
- Modify: `src/extension.ts:22-94` (module state + `updateStatusBar`)

This task has no isolated unit test that runs reliably in our existing test harness (the status-bar state lives on a vscode-only object and `updateStatusBar` is not exported). The manual EDH gate B ("Alt-tab away and back 5x rapidly — no flicker") is the regression check. We still implement and reason about it carefully because the bug is real.

- [ ] **Step 1: Add module-level generation state**

In `src/extension.ts`, immediately after line 22 (`let activePricingSyncIntervalId: ReturnType<typeof setInterval> | null = null;`), add:

```ts
let validationGeneration = 0;
let lastValidationAt = 0;
```

- [ ] **Step 2: Insert generation captures + checks inside `updateStatusBar`**

In `src/extension.ts`, replace the whole `updateStatusBar` function (lines 30-94) with the version below. The changes vs current: capture `myGen` at the top; after each `await`, bail out via `return` (using whatever value the snapshot would have produced — but since we're stale, we no-op and return the prior value) before writing to `statusBar.*`; set `lastValidationAt` at the very end of every code path.

```ts
async function updateStatusBar(
  statusBar: vscode.StatusBarItem,
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel
): Promise<boolean> {
  const myGen = ++validationGeneration;
  const key = await readStoredSecret(getKeyService("recost"), context.secrets);
  if (myGen !== validationGeneration) return false;
  if (!key) {
    logStatus(output, "updateStatusBar: no stored ReCost key; setting keyOnline=false");
    statusBar.text = "$(key) ReCost: Not Configured";
    statusBar.tooltip = "Click to manage your ReCost API keys";
    statusBar.color = undefined;
    await vscode.commands.executeCommand("setContext", "recost.keyOnline", false);
    lastValidationAt = Date.now();
    return false;
  }
  try {
    const user = await validateApiKey(key);
    if (myGen !== validationGeneration) return true;
    logStatus(output, `updateStatusBar: validateApiKey succeeded for ${user.email}; setting keyOnline=true`);
    statusBar.text = `$(check) ReCost: ${user.email}`;
    statusBar.tooltip = `Connected as ${user.email}`;
    statusBar.color = new vscode.ThemeColor("testing.iconPassed");
    await vscode.commands.executeCommand("setContext", "recost.keyOnline", true);
    lastValidationAt = Date.now();
    return true;
  } catch (err: unknown) {
    if (myGen !== validationGeneration) return false;
    const error = err as Error & { status?: number };
    if (error.status === 401) {
      const hasSnapshot = await hasPersistedValidEcoKey(context, output);
      if (myGen !== validationGeneration) return false;
      if (hasSnapshot) {
        logStatus(output, `updateStatusBar: validateApiKey returned 401 (${error.message}) but a persisted valid snapshot still exists; keeping keyOnline=true`);
        statusBar.text = "$(warning) ReCost: Auth Check Failed";
        statusBar.tooltip = "Stored ReCost key was previously validated, but the latest background auth check returned 401.";
        statusBar.color = new vscode.ThemeColor("statusBarItem.warningForeground");
        await vscode.commands.executeCommand("setContext", "recost.keyOnline", true);
        lastValidationAt = Date.now();
        return true;
      }
      logStatus(output, `updateStatusBar: validateApiKey returned 401 (${error.message}); setting keyOnline=false`);
      statusBar.text = "$(warning) ReCost: Invalid Key";
      statusBar.tooltip = "ReCost API key is invalid. Click to manage keys.";
      statusBar.color = new vscode.ThemeColor("statusBarItem.warningForeground");
      await vscode.commands.executeCommand("setContext", "recost.keyOnline", false);
      lastValidationAt = Date.now();
      return false;
    }

    const hasSnapshot = await hasPersistedValidEcoKey(context, output);
    if (myGen !== validationGeneration) return false;
    if (hasSnapshot) {
      logStatus(output, `updateStatusBar: validateApiKey failed transiently (${error.message}); keeping keyOnline=true from persisted valid snapshot`);
      statusBar.text = "$(check) ReCost: Connected";
      statusBar.tooltip = "ReCost key is stored and was previously validated. ReCost is temporarily unreachable.";
      statusBar.color = new vscode.ThemeColor("testing.iconPassed");
      await vscode.commands.executeCommand("setContext", "recost.keyOnline", true);
      lastValidationAt = Date.now();
      return true;
    } else {
      logStatus(output, `updateStatusBar: validateApiKey failed without trusted snapshot (${error.message}); setting keyOnline=false`);
      statusBar.text = "$(warning) ReCost: Unreachable";
      statusBar.tooltip = "Cannot reach ReCost. Check your connection.";
      statusBar.color = new vscode.ThemeColor("statusBarItem.warningForeground");
      await vscode.commands.executeCommand("setContext", "recost.keyOnline", false);
      lastValidationAt = Date.now();
      return false;
    }
  }
}
```

Note: each `await` boundary that could race with a newer call is followed by a generation check. Stale completions silently no-op and return the most-recent-return value (which is then discarded by the fire-and-forget caller).

- [ ] **Step 3: Verify the build typechecks**

Run:
```bash
npm run build:ext 2>&1 | tail -5
```

Expected: build succeeds.

- [ ] **Step 4: Commit**

```bash
git add src/extension.ts
git commit -m "fix(wave8): drop stale status-bar writes via generation counter (#46 Bug B)"
```

---

## Task 5: Debounce window-focus trigger (#46 Bug C)

**Files:**
- Modify: `src/extension.ts:119-132` (`scheduleKeyIndicatorRefresh`)

- [ ] **Step 1: Add the debounce check**

Replace the entire `scheduleKeyIndicatorRefresh` function (lines 119-132) with:

```ts
function scheduleKeyIndicatorRefresh(
  statusBar: vscode.StatusBarItem,
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
  reason: string
): void {
  if (reason === "windowFocused" && Date.now() - lastValidationAt < 60_000) {
    logStatus(output, `scheduleKeyIndicatorRefresh: debounced reason=${reason}`);
    return;
  }
  void (async () => {
    logStatus(output, `scheduleKeyIndicatorRefresh: begin reason=${reason}`);
    await updateStatusBar(statusBar, context, output);
    logStatus(output, `scheduleKeyIndicatorRefresh: end reason=${reason} text="${statusBar.text}"`);
  })().catch((err: unknown) => {
    logStatus(output, `scheduleKeyIndicatorRefresh: error reason=${reason} message=${err instanceof Error ? err.message : String(err)}`);
  });
}
```

Notes:
- The debounce only applies to `reason === "windowFocused"`. All other reasons (`activate`, `openPanel`, `openKeys`, `scanWorkspace`, `scanAuthFailure`) bypass it — they are explicit user intent or state-changing events.
- `lastValidationAt` is set at the end of every `updateStatusBar` path (Task 4). On first activate it is `0`, so `Date.now() - 0 ≥ 60_000` is true on cold start and the first `windowFocused` after activate still fires.

- [ ] **Step 2: Verify the build typechecks**

Run:
```bash
npm run build:ext 2>&1 | tail -5
```

Expected: build succeeds.

- [ ] **Step 3: Commit**

```bash
git add src/extension.ts
git commit -m "fix(wave8): debounce windowFocused status-bar refresh to 60s (#46 Bug C)"
```

---

## Task 6: Delete workspace-folders trigger (#46 Bug D)

**Files:**
- Modify: `src/extension.ts:250-254`

- [ ] **Step 1: Remove the subscription**

Delete lines 250-254 of `src/extension.ts`:

```ts
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      scheduleKeyIndicatorRefresh(statusBar, context, statusOutput, "workspaceFoldersChanged");
    })
  );
```

After deletion, the surrounding code goes directly from the `onDidChangeWindowState` subscription block (ending around line 249) to the `statusOnlineCommand` declaration (currently line 256). No comma fixups or scope changes needed — the subscription pushes are independent.

- [ ] **Step 2: Verify the build typechecks**

Run:
```bash
npm run build:ext 2>&1 | tail -5
```

Expected: build succeeds with no unused-import warnings.

- [ ] **Step 3: Commit**

```bash
git add src/extension.ts
git commit -m "fix(wave8): drop workspace-folders status-bar trigger (#46 Bug D)"
```

---

## Task 7: Update CLAUDE.md naming

**Files:**
- Modify: `CLAUDE.md:207`

- [ ] **Step 1: Rewrite the bullet**

In `CLAUDE.md`, find line 207:
```
- `validateRcApiKey()` in `api-client.ts` calls `GET /auth/me` with `Authorization: Bearer <key>`; returns `null` on 404 (dev mode), throws on 401 (invalid) or network error
```

Replace with:
```
- `validateApiKey()` in `api-client.ts` calls `GET /auth/me` with `Authorization: Bearer <key>`; returns the authenticated user on 200, throws on any non-2xx (including 401 invalid and 404)
```

This corrects the name confusion (`validateRcApiKey` hits `/projects?limit=1`, not `/auth/me`) and removes the now-incorrect 404-as-dev-mode wording.

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(wave8): correct CLAUDE.md auth-section naming and behavior"
```

---

## Task 8: Final verification

- [ ] **Step 1: Full test suite**

Run:
```bash
npm run test:scanner 2>&1 | tail -10
```

Expected: every line ending in `PASS …` for the existing suite, plus `PASS api-client` and `PASS scan-publishing-handler`. No failures.

- [ ] **Step 2: Full build**

Run:
```bash
npm run build 2>&1 | tail -10
```

Expected: dashboard + webview + extension builds clean. No TypeScript errors.

- [ ] **Step 3: D1 benchmark sanity check**

If the benchmark gate is reachable from this repo, run:
```bash
npm run bench 2>&1 | tail -20
```

Expected: Δ +0.00pp (this PR does not touch the scanner). If `npm run bench` does not exist here, skip this step — it is a sanity check, not a hard gate.

- [ ] **Step 4: Open the PR**

Create a feature branch from the work done above (if not already on one) and open the PR:

```bash
# If still on main, move commits to a branch:
git checkout -b wave8/status-error-ux

git push -u origin wave8/status-error-ux

gh pr create --title "wave8: status/error UX (#94, #100, #46)" --body "$(cat <<'EOF'
## Summary
- #94: `validateApiKey()` no longer treats `/auth/me` 404 as valid in dev mode.
- #100: scan-submit 429 surfaces a `scanNotification` with `Retry-After` text; local results still publish.
- #46: status-bar indicator stops flickering — generation counter, focus debounce, workspace-folders trigger removed, scan-side auth failure now refreshes the status bar.

## Test plan
- [ ] `npm run test:scanner` passes (existing + new `api-client` + new `scan-publishing-handler`)
- [ ] `npm run build` clean
- [ ] D1 benchmark Δ +0.00pp (sanity)
- [ ] EDH gate 1 — Revoke key in dashboard → run scan → status bar flips to "Invalid Key" (not just sidebar). (Bug A)
- [ ] EDH gate 2 — Alt-tab away and back 5x rapidly while connected → status stays "Connected", no flicker. (Bugs B + C)
- [ ] EDH gate 3 — Configure a fresh key whose `/auth/me` returns 404 → status bar shows "Invalid Key", not "Connected". (#94)
- [ ] EDH gate 4 — Submit 11 scans within 60s → 11th run shows the rate-limit `scanNotification` with a wait time. (#100)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Return the PR URL.

---

## Self-review notes

- **Spec coverage:** Sections A (#94), B (#100), C (#46 Bugs A/B/C/D) and the CLAUDE.md naming fix all have tasks. Section A → Task 1. Section B → Tasks 2 + 3. Section C Bug A → Task 3 Steps 4-7. Section C Bug B → Task 4. Section C Bug C → Task 5. Section C Bug D → Task 6. CLAUDE.md fix → Task 7. Verification gates → Task 8.
- **Tests covered:** Spec asks for (a) 404-throws on `validateApiKey` (Task 1), (b) 429 Retry-After parsing (Task 2), (c) 429 scanNotification with seconds + generic fallback (Task 3), (d) status-bar refresh callback invoked on 401 (Task 3 case 4). The "generation counter race" unit test the spec floats was explicitly noted as droppable in favor of manual gate B — Task 4 follows that path.
- **Type consistency:** `refreshStatusBar` is a `() => void` throughout — context interface, provider constructor, extension.ts wire-up. `retryAfterSeconds` is a `number | undefined` on both `apiFetch` errors and the 429 catch branch.
- **Risk:** Task 3 Step 1's `require.cache` stubbing is fragile if module paths change. If the test ever fails to stub correctly, fall back to factoring out an explicit "fetch-failed scan handler" function with DI — but try the stub-first approach first since it matches the style of `webview-provider-dispatch.test.ts`.
