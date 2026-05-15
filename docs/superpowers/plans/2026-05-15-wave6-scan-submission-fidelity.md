# Wave 6: Scan Submission Fidelity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop silently dropping scan data — surface unknown-provider calls in the dashboard (#96), and persist AST `span` ranges end-to-end through the API (#95).

**Architecture:** Two narrow PRs across two repos.
- **PR 1** (`recost-dev/extension`, closes #96): Replace the silent provider-filter at `src/webview/scan-publishing-handler.ts:683-689` with a pure helper that retains every call and reports an "unknown-provider count + top hosts" summary; emit that summary as a `scanNotification` IPC message. The API already accepts `provider: "unknown"` (validator at `api/src/services/validation-service.ts:61` only requires a non-empty string ≤64 chars), so no API change is needed for this PR.
- **PR 2** (`recost-dev/api`, closes #95): Add `span` to the `ApiCallInput` validator, the `EndpointCallSite` model, and the call-site builder in `analysis-service.ts`. No migration — `callSites` is already a JSON column.

**Tech Stack:** TypeScript. Extension tests are compiled with `tsc -p tsconfig.scanner-tests.json` and run as `node dist-test/test/<name>.js` via the `test:scanner` script. API uses `vitest`.

**Execution order:** PR 1 first (fully reversible, single repo). PR 2 second (API persistence change; benefits from PR 1's bug being fixed first because more calls reach the API to round-trip).

---

## File Structure

### PR 1 (extension)
- **Create** `src/webview/build-remote-api-calls.ts` — pure helper `buildRemoteApiCalls(apiCalls)` returning `{ submitted, unknownProviderCount, unknownProviderHosts }`. No VS Code API imports so the test runner exercises it directly.
- **Create** `src/test/wave6-pr1-submit-filter.test.ts` — unit tests for the helper.
- **Modify** `src/webview/scan-publishing-handler.ts:683-693` — delegate to helper; emit `scanNotification` when `unknownProviderCount > 0`.
- **Modify** `package.json:201` — append the new compiled test path to `test:scanner`.
- **Modify** `CLAUDE.md:224` — update the now-incorrect "drops calls" sentence.

### PR 2 (api)
- **Modify** `src/models/types.ts` — add `SourceSpan`; add `span?: SourceSpan` on `ApiCallInput` (line 8) and `EndpointCallSite` (line 101).
- **Modify** `src/services/validation-service.ts` — validate optional `span` in `validateApiCall()` and pass through in return.
- **Modify** `src/services/analysis-service.ts:180-187` — include `span` when building `callSites` from validated `apiCalls`.
- **Modify** `src/tests/scan.test.ts` — validation tests + round-trip persistence test.

---

# PR 1 — Extension: surface unknown-provider calls (closes #96)

### Task 1.1: Stub helper + failing tests

**Files:**
- Create: `src/webview/build-remote-api-calls.ts`
- Create: `src/test/wave6-pr1-submit-filter.test.ts`
- Modify: `package.json:201`

- [ ] **Step 1: Stub the helper module so the test imports cleanly**

Create `src/webview/build-remote-api-calls.ts`:

```typescript
import type { ApiCallInput } from "../analysis/types";

export interface RemoteSubmitBuild {
  submitted: ApiCallInput[];
  unknownProviderCount: number;
  unknownProviderHosts: Record<string, number>;
}

export function buildRemoteApiCalls(_apiCalls: ApiCallInput[]): RemoteSubmitBuild {
  throw new Error("not implemented");
}
```

- [ ] **Step 2: Write the failing test**

Create `src/test/wave6-pr1-submit-filter.test.ts`:

```typescript
import test from "node:test";
import assert from "node:assert/strict";
import { buildRemoteApiCalls } from "../webview/build-remote-api-calls";
import type { ApiCallInput } from "../analysis/types";

function call(over: Partial<ApiCallInput>): ApiCallInput {
  return {
    file: "src/x.ts",
    line: 1,
    method: "GET",
    url: "https://api.openai.com/v1/chat/completions",
    library: "fetch",
    ...over,
  };
}

test("buildRemoteApiCalls passes through known-provider calls unchanged", () => {
  const result = buildRemoteApiCalls([call({ provider: "openai" })]);
  assert.equal(result.submitted.length, 1);
  assert.equal(result.submitted[0].provider, "openai");
  assert.equal(result.unknownProviderCount, 0);
  assert.deepEqual(result.unknownProviderHosts, {});
});

test("buildRemoteApiCalls fills missing provider via URL detection", () => {
  const result = buildRemoteApiCalls([call({ provider: undefined })]);
  assert.equal(result.submitted.length, 1);
  assert.equal(result.submitted[0].provider, "openai");
  assert.equal(result.unknownProviderCount, 0);
});

test("buildRemoteApiCalls keeps unrecognized-host calls and tags them 'unknown'", () => {
  const result = buildRemoteApiCalls([
    call({ url: "https://acme.fictional/data", provider: undefined }),
    call({ url: "https://internal.example/x", provider: undefined }),
    call({ url: "https://acme.fictional/data2", provider: undefined }),
  ]);
  assert.equal(result.submitted.length, 3);
  for (const c of result.submitted) assert.equal(c.provider, "unknown");
  assert.equal(result.unknownProviderCount, 3);
  assert.deepEqual(result.unknownProviderHosts, {
    "acme.fictional": 2,
    "internal.example": 1,
  });
});

test("buildRemoteApiCalls drops calls that fail shouldSubmitRemote (no library / low-confidence URL)", () => {
  const result = buildRemoteApiCalls([
    call({ library: undefined, url: "https://api.openai.com/v1/chat" }),
    call({ url: "${ENDPOINT}/x", library: "fetch" }),
  ]);
  assert.equal(result.submitted.length, 0);
  assert.equal(result.unknownProviderCount, 0);
});
```

- [ ] **Step 3: Register the test with the runner**

In `package.json:201`, append ` && node dist-test/test/wave6-pr1-submit-filter.test.js` to the `test:scanner` value (immediately before the closing quote).

- [ ] **Step 4: Run the test and verify failure**

```bash
npm test
```

Expected: all 4 new tests fail with `Error: not implemented` thrown from the stub. Other tests should still pass.

### Task 1.2: Implement `buildRemoteApiCalls`

**Files:**
- Modify: `src/webview/build-remote-api-calls.ts`

- [ ] **Step 1: Replace the stub with the implementation**

Replace the body of `src/webview/build-remote-api-calls.ts`:

```typescript
import type { ApiCallInput } from "../analysis/types";
import { shouldSubmitRemote } from "../scan-results";
import { detectEndpointProvider } from "../scanner/endpoint-classification";

export interface RemoteSubmitBuild {
  submitted: ApiCallInput[];
  unknownProviderCount: number;
  unknownProviderHosts: Record<string, number>;
}

function safeHostname(url: string): string {
  try {
    return new URL(url).hostname || "<no-host>";
  } catch {
    return "<unparseable>";
  }
}

export function buildRemoteApiCalls(apiCalls: ApiCallInput[]): RemoteSubmitBuild {
  const candidates = apiCalls.filter(shouldSubmitRemote);
  const hosts: Record<string, number> = {};
  let unknownCount = 0;
  const submitted = candidates.map((call) => {
    const detected = detectEndpointProvider(call.url);
    const provider = call.provider ?? detected ?? "unknown";
    if (provider === "unknown") {
      unknownCount += 1;
      const host = safeHostname(call.url);
      hosts[host] = (hosts[host] ?? 0) + 1;
    }
    return { ...call, provider };
  });
  return { submitted, unknownProviderCount: unknownCount, unknownProviderHosts: hosts };
}
```

- [ ] **Step 2: Run tests, confirm they pass**

```bash
npm test
```

Expected: all 4 new tests pass; no other test regresses.

- [ ] **Step 3: Commit**

```bash
git add src/webview/build-remote-api-calls.ts src/test/wave6-pr1-submit-filter.test.ts package.json
git commit -m "feat(wave6-pr1): add buildRemoteApiCalls helper retaining unknown-provider calls"
```

### Task 1.3: Wire the helper into the publishing handler + emit summary

**Files:**
- Modify: `src/webview/scan-publishing-handler.ts:683-693`

- [ ] **Step 1: Add the import**

At the top of `src/webview/scan-publishing-handler.ts`, add (group with the other webview-relative imports):

```typescript
import { buildRemoteApiCalls } from "./build-remote-api-calls";
```

- [ ] **Step 2: Replace the inline filter+map**

Replace lines 683-693 (the `const remoteApiCalls = apiCalls.filter(...)...filter(...)` block, plus the immediately-following empty-array early return):

```typescript
      const remoteApiCalls = apiCalls
        .filter(shouldSubmitRemote)
        .map((call) => ({
          ...call,
          provider: call.provider ?? detectEndpointProvider(canonicalizeEndpointUrl(call.url)) ?? "unknown",
        }))
        .filter((call) => call.provider !== "unknown");
      if (remoteApiCalls.length === 0) {
        publishLocalOnlyResults(manualProjectId ?? this.ctx.getProjectId() ?? "local", `local-${Date.now()}`);
        return;
      }
```

with:

```typescript
      const { submitted: remoteApiCalls, unknownProviderCount, unknownProviderHosts } =
        buildRemoteApiCalls(apiCalls);
      if (remoteApiCalls.length === 0) {
        publishLocalOnlyResults(manualProjectId ?? this.ctx.getProjectId() ?? "local", `local-${Date.now()}`);
        return;
      }
      if (unknownProviderCount > 0) {
        const topHosts = Object.entries(unknownProviderHosts)
          .sort(([, a], [, b]) => b - a)
          .slice(0, 3)
          .map(([host, count]) => `${host}: ${count}`)
          .join(", ");
        this.ctx.postMessage({
          type: "scanNotification",
          message: `Submitted ${remoteApiCalls.length} calls. ${unknownProviderCount} have unrecognized provider (top hosts — ${topHosts}). They are still submitted and will appear in the dashboard.`,
        });
      }
```

- [ ] **Step 3: Drop now-unused imports if any**

After the edit, search `src/webview/scan-publishing-handler.ts` for other uses of `detectEndpointProvider` and `canonicalizeEndpointUrl`. If either is no longer referenced, remove it from the import list. Do NOT remove `shouldSubmitRemote` — it may still be needed in adjacent code paths (verify by searching the file).

- [ ] **Step 4: Build to confirm TypeScript compiles**

```bash
npm run build:ext
```

Expected: clean build, no TS errors.

- [ ] **Step 5: Re-run the full test suite**

```bash
npm test
```

Expected: every test passes.

- [ ] **Step 6: Commit**

```bash
git add src/webview/scan-publishing-handler.ts
git commit -m "feat(wave6-pr1): stop silently dropping unknown-provider calls; surface scan-end summary

Closes #96"
```

### Task 1.4: Update CLAUDE.md

**Files:**
- Modify: `CLAUDE.md:224`

- [ ] **Step 1: Update the stale sentence**

Replace line 224 (the bullet starting `- Before submitting to the remote API, ...`):

```markdown
- Before submitting to the remote API, `webview-provider.ts` guards null/undefined `library` in `shouldSubmitRemote()`, fills missing `provider` via URL-based detection (`detectEndpointProvider`), and drops calls where provider is still `"unknown"`
```

with:

```markdown
- Before submitting to the remote API, `scan-publishing-handler.ts` delegates to `build-remote-api-calls.ts:buildRemoteApiCalls()`. That helper applies `shouldSubmitRemote()` (in `scan-results.ts`), then fills missing `provider` via URL-based detection (`detectEndpointProvider`). Calls where the provider remains `"unknown"` are **submitted** with that literal value and surfaced in a `scanNotification` IPC message at scan end — they are never silently dropped.
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(claude.md): update submit-filter behavior to match #96 fix"
```

### Task 1.5: Push + PR

- [ ] **Step 1: Push the branch**

```bash
git push -u origin wave6/pr1-surface-unknown-providers
```

- [ ] **Step 2: Open the PR**

```bash
gh pr create --repo recost-dev/extension \
  --base main --head wave6/pr1-surface-unknown-providers \
  --title "feat: surface unknown-provider calls instead of silently dropping (closes #96)" \
  --body "$(cat <<'EOF'
## Summary

- Extracts the inline submit-filter at \`scan-publishing-handler.ts:683-689\` into a pure helper \`buildRemoteApiCalls()\`.
- The helper keeps every call (post-\`shouldSubmitRemote\`), tagging any unresolved provider as \`\"unknown\"\` rather than dropping it. The API validator already accepts that literal.
- When the unknown count is non-zero, surfaces a \`scanNotification\` IPC message summarizing the count and top unrecognized hosts.
- Updates \`CLAUDE.md\` to remove the now-incorrect "drops calls" sentence.

## Test plan

- [ ] Unit tests in \`src/test/wave6-pr1-submit-filter.test.ts\` cover the four behavior buckets (known provider, URL-detected provider, unrecognized host, low-confidence URL).
- [ ] Manually scan a workspace containing \`fetch("https://acme.fictional/data")\` — confirm the notification fires and the endpoint appears in the dashboard with \`provider: "unknown"\`.

Closes #96

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

# PR 2 — API: persist `span` end-to-end (closes #95)

### Task 2.1: Add `SourceSpan` and extend models

**Files:**
- Modify: `src/models/types.ts`

- [ ] **Step 1: Add the type and extend `ApiCallInput` + `EndpointCallSite`**

Near the top of `src/models/types.ts`, after the `CrossFileOrigin` interface, add:

```typescript
/**
 * Source span describing where a call expression lives in the user's code.
 * - Lines are 1-based; columns are 0-based; endLine/endColumn are exclusive.
 * Format mirrors the extension's `src/scanner/source-span.ts`.
 */
export interface SourceSpan {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}
```

In `ApiCallInput` (currently at line 8), add an optional `span` after `line`:

```typescript
export interface ApiCallInput {
  file: string;
  line: number;
  /** Full source span — optional because regex-fallback call sites may omit it. */
  span?: SourceSpan;
  method: string;
  url: string;
  provider: string;
  // ... (existing fields unchanged)
}
```

In `EndpointCallSite` (currently at line 101), add an optional `span` after `line`:

```typescript
export interface EndpointCallSite {
  file: string;
  line: number;
  /** Full source span — optional because regex-fallback call sites may omit it. */
  span?: SourceSpan;
  library?: string;
  // ... (existing fields unchanged)
}
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```

Expected: clean.

### Task 2.2: Validate `span` in `validateApiCall()`

**Files:**
- Modify: `src/services/validation-service.ts`
- Modify: `src/tests/scan.test.ts`

- [ ] **Step 1: Add failing validation tests**

Append to `src/tests/scan.test.ts` (or merge into an existing `describe` block — match the style already there; if `validateApiCall` is not currently exported from `validation-service.ts`, export it as a named export):

```typescript
import { describe, it, expect } from "vitest";
import { validateApiCall } from "../services/validation-service";

describe("validateApiCall span field", () => {
  const baseInput = {
    file: "src/x.ts",
    line: 42,
    method: "POST",
    url: "https://api.openai.com/v1/chat/completions",
    provider: "openai",
  };

  it("accepts a well-formed span", () => {
    const result = validateApiCall({
      ...baseInput,
      span: { startLine: 42, startColumn: 4, endLine: 47, endColumn: 1 },
    }, 0);
    expect(result.span).toEqual({ startLine: 42, startColumn: 4, endLine: 47, endColumn: 1 });
  });

  it("rejects a span with non-integer fields", () => {
    expect(() =>
      validateApiCall({
        ...baseInput,
        span: { startLine: 42, startColumn: "four", endLine: 47, endColumn: 1 } as never,
      }, 0)
    ).toThrow(/span/);
  });

  it("returns span undefined when omitted", () => {
    const result = validateApiCall(baseInput, 0);
    expect(result.span).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests, verify the "accepts well-formed span" test fails**

```bash
npm test -- scan.test.ts
```

Expected: the first new test fails because the returned object has no `span` property.

- [ ] **Step 3: Implement span validation**

In `src/services/validation-service.ts`:

1. Update the imports at the top of the file — add `SourceSpan` to the existing destructured import from `../models/types`:

```typescript
import {
  ApiCallInput, CrossFileOrigin, FrequencyClass, MethodCostModel,
  ProjectInput, ProjectPatchInput, ScanInput, SourceSpan,
  TelemetryMetricInput, TelemetryWindowInput,
} from "../models/types";
```

2. Inside `validateApiCall()`, after the `crossFileOrigin` validation block (around current line 97-103, immediately before the `if (fieldErrors.length > 0)` check at line 105), add:

```typescript
  const span = call.span;
  let validatedSpan: SourceSpan | undefined;
  if (span !== undefined) {
    if (typeof span !== "object" || span === null || Array.isArray(span)) {
      fieldErrors.push({
        field: `apiCalls[${index}].span`,
        message: "span must be an object when provided.",
      });
    } else {
      const s = span as Record<string, unknown>;
      const intKeys = ["startLine", "startColumn", "endLine", "endColumn"] as const;
      const allInts = intKeys.every((k) => typeof s[k] === "number" && Number.isInteger(s[k]));
      if (!allInts) {
        fieldErrors.push({
          field: `apiCalls[${index}].span`,
          message: "span fields (startLine, startColumn, endLine, endColumn) must all be integers.",
        });
      } else {
        validatedSpan = {
          startLine: s.startLine as number,
          startColumn: s.startColumn as number,
          endLine: s.endLine as number,
          endColumn: s.endColumn as number,
        };
      }
    }
  }
```

3. In the return statement at the bottom of `validateApiCall()` (currently line 116-132), insert `span: validatedSpan,` after the `line: line as number,` field:

```typescript
  return {
    file: file as string,
    line: line as number,
    span: validatedSpan,
    method: (method as string).toUpperCase(),
    // ... rest unchanged
  };
```

- [ ] **Step 4: Run tests, verify all three new validation tests pass**

```bash
npm test -- scan.test.ts
```

Expected: all three new tests pass; no existing tests regress.

- [ ] **Step 5: Commit**

```bash
git add src/services/validation-service.ts src/models/types.ts src/tests/scan.test.ts
git commit -m "feat(api): validate optional span on apiCalls"
```

### Task 2.3: Persist `span` into `callSites`

**Files:**
- Modify: `src/services/analysis-service.ts:180-187`
- Modify: `src/tests/scan.test.ts`

- [ ] **Step 1: Add a round-trip test**

Append to `src/tests/scan.test.ts`. The exact entry point depends on what `analysis-service.ts` exports — check existing tests in `scan.test.ts` for the analysis function name (likely the top-level scan-handling export). If existing tests already wire up a scan and assert on `endpoints[0].callSites`, follow that pattern verbatim:

```typescript
describe("analysis-service span persistence", () => {
  it("preserves span on every callSite of every endpoint", () => {
    // Replicate the setup style used by other scan-pipeline tests in this file.
    const input = {
      apiCalls: [
        {
          file: "src/x.ts",
          line: 42,
          span: { startLine: 42, startColumn: 4, endLine: 47, endColumn: 1 },
          method: "POST",
          url: "https://api.openai.com/v1/chat/completions",
          provider: "openai",
          library: "openai",
        },
      ],
    };
    // Replace `runAnalysis` with the actual entry-point name used in existing tests:
    const result = runAnalysis(input, "proj_test", "scan_test");
    expect(result.endpoints).toHaveLength(1);
    expect(result.endpoints[0].callSites[0].span).toEqual({
      startLine: 42, startColumn: 4, endLine: 47, endColumn: 1,
    });
  });
});
```

> **Note:** If the existing tests in `scan.test.ts` already exercise the analysis pipeline end-to-end via Hono request fixtures, prefer extending one of those tests with a `span` assertion instead of adding a new entry-point harness. Match the conventions you see.

- [ ] **Step 2: Run and verify the new assertion fails**

```bash
npm test -- scan.test.ts
```

Expected: the span assertion fails because the returned `callSites[0]` has no `span` field.

- [ ] **Step 3: Include `span` when building `callSites`**

In `src/services/analysis-service.ts:180-187`, change:

```typescript
      callSites: calls.map((call) => ({
        file: call.file,
        line: call.line,
        library: call.library,
        frequency: call.frequency,
        ...(call.frequencyClass !== undefined ? { frequencyClass: call.frequencyClass } : {}),
        ...(call.crossFileOrigin !== undefined ? { crossFileOrigin: call.crossFileOrigin } : {}),
      })),
```

to:

```typescript
      callSites: calls.map((call) => ({
        file: call.file,
        line: call.line,
        ...(call.span !== undefined ? { span: call.span } : {}),
        library: call.library,
        frequency: call.frequency,
        ...(call.frequencyClass !== undefined ? { frequencyClass: call.frequencyClass } : {}),
        ...(call.crossFileOrigin !== undefined ? { crossFileOrigin: call.crossFileOrigin } : {}),
      })),
```

- [ ] **Step 4: Run the full test suite**

```bash
npm test
```

Expected: the new round-trip assertion passes; all existing tests still pass.

- [ ] **Step 5: Commit**

```bash
git add src/services/analysis-service.ts src/tests/scan.test.ts
git commit -m "feat(api): persist span on endpoint callSites

Closes #95"
```

### Task 2.4: Push + PR

- [ ] **Step 1: Push the branch**

```bash
git push -u origin wave6/pr2-persist-span
```

- [ ] **Step 2: Open the PR**

```bash
gh pr create --repo recost-dev/api \
  --base main --head wave6/pr2-persist-span \
  --title "feat: persist source span on endpoint callSites (closes #95)" \
  --body "$(cat <<'EOF'
## Summary

- Adds an optional \`span: SourceSpan\` field to \`ApiCallInput\` and \`EndpointCallSite\` in \`models/types.ts\` (1-based lines, 0-based columns, exclusive ends — mirrors the extension's convention).
- \`validateApiCall()\` now shape-checks an optional \`span\` (all four integer fields required when present).
- \`analysis-service.ts\` propagates \`span\` from validated input to the persisted \`callSites\` JSON. No migration required (\`callSites\` is already a JSON column).
- Unblocks the dashboard's "jump to highlighted range" UX without requiring any extension change — the extension has been sending \`span\` all along.

## Test plan

- [ ] \`src/tests/scan.test.ts\` covers validation of well-formed / malformed / absent span and a round-trip persistence assertion.
- [ ] After deploy: scan a project from the extension and confirm \`GET /projects/:id/endpoints\` returns \`callSites[i].span\` populated.

Closes #95

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-Review

**1. Spec coverage:**
- #96 silent filter — Task 1.1-1.3 ✓
- #96 user-visible signal — Task 1.3 (`scanNotification`) ✓
- #96 stale doc — Task 1.4 ✓
- #95 validator — Task 2.2 ✓
- #95 persistence — Task 2.3 ✓
- #95 model surface — Task 2.1 ✓

**2. Placeholder scan:**
- Task 2.3 Step 1 includes one explicit "match the existing entry-point naming in `scan.test.ts`" note — this is intentional because the api repo's analysis-service top-level export name varies by codebase version. The note flags the lookup; it is not a hidden TODO.
- All other code blocks contain complete, runnable content.

**3. Type consistency:**
- `SourceSpan` shape is identical in `extension/src/scanner/source-span.ts` (existing) and the new `api/src/models/types.ts` (added in Task 2.1).
- `buildRemoteApiCalls`'s return shape (`submitted` / `unknownProviderCount` / `unknownProviderHosts`) is consistent across Task 1.1 (test), Task 1.2 (impl), and Task 1.3 (consumer).
- The destructure in Task 1.3 (`const { submitted: remoteApiCalls, ... }`) matches the property names declared in Task 1.1's `RemoteSubmitBuild` interface.
