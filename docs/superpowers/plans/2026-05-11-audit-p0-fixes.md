# ReCost Extension — Full Audit Remediation Plan (2026-05-11)

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended for this plan — it is designed for parallel fan-out) or `superpowers:executing-plans`. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close every finding from the 2026-05-11 deep audit (3 P0 / 5 P1 / 9 P2 / 3 P3) without regressing existing tests, and leave the codebase ready for v0.2 release.

**Architecture:** Each task is **strictly file-scoped** — it lists exactly which files it may modify so the orchestrator can fan out parallel work without merge conflicts. Tasks are grouped into six phases with explicit dependency declarations. Phases A, E, and parts of F are wide parallel; Phases C and D are serial on `src/webview-provider.ts`.

**Tech Stack:** TypeScript 5.8 strict mode, node:assert/strict harness via `tsc -p tsconfig.scanner-tests.json && node`, VSCode 1.85+ API, esbuild bundler, web-tree-sitter WASM.

---

## How to Execute This Plan With Parallel Subagents

**Read this section once at the start.** Each task below carries four routing fields:

- **Owner-files** — files this task is allowed to create or modify. The orchestrator MUST refuse to dispatch two parallel tasks whose owner-files overlap.
- **Read-only refs** — files the executor needs to read for context but must not modify.
- **Depends on** — task IDs that must be committed before this one starts.
- **Parallel-safe with** — task IDs the orchestrator may run concurrently with this one.

### Phase map

| Phase | Tasks | Concurrency |
|-------|-------|-------------|
| **A** | A1–A9 | Fully parallel — every task owns a distinct new or isolated file |
| **B** | B1, B2 | Both parallel after Phase A completes |
| **C** | C1 → C2 → C3 → C4 → C5 → C6 | **Strict serial** on `src/webview-provider.ts` |
| **D** | D1 → D2 → D3 → D4 | **Strict serial** — each extraction edits `src/webview-provider.ts` |
| **E** | E1 | Parallel with C and D (owns `src/scan-results.ts` only) |
| **F** | F1, F2, F3 | F1 and F2 parallel; F3 parallel with both |

### Recommended dispatch order

1. Fan out A1–A9 in one batch (9 subagents).
2. Wait for green, then fan out B1 and B2 in parallel (2 subagents).
3. Run C1–C6 sequentially. While Phase C is running, dispatch E1 in parallel (it owns a non-overlapping file).
4. Run D1–D4 sequentially after C completes.
5. Fan out F1–F3 in parallel.

### Conventions
- **Test runner:** every test is a self-contained Node script using `node:assert/strict`. Compile with `npx tsc -p tsconfig.scanner-tests.json`, then `node dist-test/<path>.test.js`. The full suite is wired in `package.json:198-199`.
- **Commits:** one commit per task, message format `<type>(<area>): <imperative>`. Push happens after the user reviews — never push inside a task.
- **Definition of done:** task is complete when (a) new/changed code compiles, (b) the relevant test passes, (c) the existing test suite still passes, (d) commit is created.

---

## File Structure (full target state)

**New files**
- `.github/workflows/test.yml` — CI runner (A1)
- `src/test/api-client.test.ts` — A6
- `src/test/key-management.test.ts` — A7
- `src/test/ast-parser-loader-fallback.test.ts` — A8
- `src/intelligence/__tests__/cost-utils.test.ts` — A9
- `src/test/webview-provider-dispatch.test.ts` — C1
- `src/test/intelligence-compression-async.test.ts` — B2
- `src/test/extension-activation.test.ts` — F3
- `src/webview/chat-handler.ts` — D1
- `src/webview/key-management-handler.ts` — D2
- `src/webview/simulation-handler.ts` — D3
- `src/webview/scan-publishing-handler.ts` — D4

**Modified files** (each only modified by the tasks owning them)
- `tsconfig.json` — A2
- `esbuild.mjs` — A3
- `scripts/build-vsix.sh` — A4
- `CLAUDE.md` — A5
- `src/extension.ts` — B1
- `src/intelligence/compression.ts` — B2
- `src/webview-provider.ts` — C1, C2, C3, C4, C5, C6, D1, D2, D3, D4 (serial)
- `src/scan-results.ts` — E1
- `package.json` — F1, F2 (both edit only the `devDependencies.esbuild` / `dependencies.openai` lines; orchestrator should still serialize them out of caution)

---

# Phase A — Fully Parallel Setup (9 tasks)

All A-tasks own non-overlapping files. Dispatch in one batch.

---

### Task A1: Add GitHub Actions CI workflow

- **Owner-files:** `.github/workflows/test.yml` (new)
- **Read-only refs:** `package.json`
- **Depends on:** none
- **Parallel-safe with:** A2, A3, A4, A5, A6, A7, A8, A9

**Why:** The 2026-05-11 audit found 24 test files exist but never run on push. Catching regressions before merge is the highest-leverage fix.

- [ ] **Step 1: Create the workflow file**

Create `.github/workflows/test.yml`:

```yaml
name: tests

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: "20"
          cache: "npm"

      - name: Install root deps
        run: npm ci

      - name: Install webview deps
        run: cd webview && npm ci

      - name: Build extension
        run: npm run build:ext

      - name: Run scanner + intelligence tests
        run: npm test

      - name: Security secret scan
        run: npm run security:scan
```

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/test.yml
git commit -m "ci: run scanner + intelligence tests and secret scan on push and PR"
```

---

### Task A2: Tighten root `tsconfig.json`

- **Owner-files:** `tsconfig.json`
- **Read-only refs:** none
- **Depends on:** none
- **Parallel-safe with:** A1, A3, A4, A5, A6, A7, A8, A9

**Why:** Current root tsconfig has `"strict": true` but is missing three modern flags that catch real bugs: `noUncheckedIndexedAccess` (catches array/record access without an undefined check), `noImplicitOverride` (catches missing `override` keywords), `exactOptionalPropertyTypes` (catches `{ x?: T }` being set to `undefined` explicitly).

- [ ] **Step 1: Add the flags**

Replace `tsconfig.json` with:

```json
{
  "compilerOptions": {
    "module": "commonjs",
    "target": "ES2022",
    "lib": ["ES2022"],
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "exactOptionalPropertyTypes": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "sourceMap": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "webview"]
}
```

- [ ] **Step 2: Type-check the project**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | tail -80`

Expected: the build either passes cleanly OR surfaces a finite list of legitimate type errors. **If errors appear, fix them in this task only when they are trivially obvious** (a missing `?? defaultValue`, a missing `override` keyword). If an error is non-trivial, revert the offending compiler flag and add it to `metadata.followup` of this task before committing — don't merge a half-strict tsconfig.

- [ ] **Step 3: Commit**

```bash
git add tsconfig.json
git commit -m "chore(types): enable noUncheckedIndexedAccess, noImplicitOverride, exactOptionalPropertyTypes"
```

---

### Task A3: Disable production sourcemaps and add a release mode in `esbuild.mjs`

- **Owner-files:** `esbuild.mjs`
- **Read-only refs:** `package.json`
- **Depends on:** none
- **Parallel-safe with:** A1, A2, A4, A5, A6, A7, A8, A9

**Why:** `esbuild.mjs:18` sets `sourcemap: true` unconditionally. This ships full source maps inside every VSIX (bloating size and revealing internals). Add a `--release` flag that turns sourcemaps off and minify on, leave dev defaults intact.

- [ ] **Step 1: Patch `esbuild.mjs`**

Replace the file with:

```js
import * as esbuild from "esbuild";
import * as fs from "fs";
import * as path from "path";

const watch = process.argv.includes("--watch");
const release = process.argv.includes("--release");

const buildOptions = {
  entryPoints: {
    extension: "src/extension.ts",
    "cli/scan": "src/cli/scan.ts",
  },
  bundle: true,
  outdir: "dist",
  external: ["vscode", "web-tree-sitter"],
  format: "cjs",
  platform: "node",
  target: "node18",
  sourcemap: release ? false : "linked",
  minify: release,
};

function copyWebTreeSitter() {
  const src = path.resolve("node_modules/web-tree-sitter");
  const dst = path.resolve("dist/node_modules/web-tree-sitter");
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dst, { recursive: true });
  fs.cpSync(src, dst, { recursive: true });
}

function copyParserAssets() {
  const src = path.resolve("assets/parsers");
  const dst = path.resolve("dist/assets/parsers");
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dst, { recursive: true });
  fs.cpSync(src, dst, { recursive: true });
}

if (watch) {
  const ctx = await esbuild.context(buildOptions);
  await ctx.watch();
  copyWebTreeSitter();
  copyParserAssets();
  console.log("Watching for changes...");
} else {
  await esbuild.build(buildOptions);
  copyWebTreeSitter();
  copyParserAssets();
  console.log(`Extension built successfully (${release ? "release" : "dev"} mode).`);
}
```

- [ ] **Step 2: Wire `package` to use release mode**

In `package.json`, change the `package` script to:

```json
"package": "npm run build:webview && node esbuild.mjs --release && npx @vscode/vsce package --no-dependencies --allow-missing-repository"
```

**Note:** A3 owns `esbuild.mjs` exclusively, but this Step 2 edit touches `package.json`. F1 and F2 also touch `package.json`. To avoid contention, this edit is **part of A3** and F1/F2 must serialize against A3. Mark this in the orchestrator: A3 blocks F1 and F2.

- [ ] **Step 3: Commit**

```bash
git add esbuild.mjs package.json
git commit -m "build: add --release flag (minify + drop sourcemaps); wire vsce package to use it"
```

---

### Task A4: Fix VSIX artifact-name mismatch in `scripts/build-vsix.sh`

- **Owner-files:** `scripts/build-vsix.sh`
- **Read-only refs:** `package.json` (to confirm artifact prefix is `recost-api-analyzer`)
- **Depends on:** none
- **Parallel-safe with:** A1, A2, A3, A5, A6, A7, A8, A9

**Why:** The script looks for `eco-api-analyzer-*.vsix` (line 33) but `vsce package` emits `recost-api-analyzer-*.vsix`. The final "Done!" message prints empty.

- [ ] **Step 1: Patch the script**

Edit `scripts/build-vsix.sh:11` and `:33`:

- Line 11: change `# Output: eco-api-analyzer-*.vsix in the extension/ directory.` to `# Output: recost-api-analyzer-*.vsix in the extension/ directory.`
- Line 33: change `VSIX=$(ls "$EXT_DIR"/eco-api-analyzer-*.vsix 2>/dev/null | head -n 1)` to `VSIX=$(ls "$EXT_DIR"/recost-api-analyzer-*.vsix 2>/dev/null | head -n 1)`

- [ ] **Step 2: Commit**

```bash
git add scripts/build-vsix.sh
git commit -m "fix(scripts): match actual VSIX artifact name (recost-api-analyzer-*.vsix)"
```

---

### Task A5: Repair `CLAUDE.md` (remove stale `local-server.ts` references)

- **Owner-files:** `CLAUDE.md`
- **Read-only refs:** none (the verification — that `src/local-server.ts` does not exist — was already done in the audit)
- **Depends on:** none
- **Parallel-safe with:** A1, A2, A3, A4, A6, A7, A8, A9

**Why:** Audit confirmed `src/local-server.ts` does not exist. `CLAUDE.md` still lists it in the project tree and dedicates a "Local Server Endpoints" section to it. Future AI agents will chase a nonexistent file.

- [ ] **Step 1: Remove the `src/local-server.ts` line from the project structure**

In `CLAUDE.md`, find the line:

```
  local-server.ts         # Embedded HTTP server (serves dashboard + proxies local analysis)
```

Delete it.

- [ ] **Step 2: Replace the "Local Server Endpoints" section**

Find the heading `### Local Server Endpoints` and replace the entire section (heading + bullet list) with:

```markdown
### Local-Only Data Flow

There is no embedded HTTP server. All "local" data (sustainability footprint, cost-by-provider, simulator runs, scenario CRUD) is computed on the extension host and delivered to the webview through typed IPC messages defined in `src/messages.ts`. Scenarios are persisted via `vscode.globalState` under `eco.simulatorScenarios`.
```

- [ ] **Step 3: Search-and-fix any other stray references**

Run: `Grep "local-server" CLAUDE.md` and `Grep "embedded HTTP server" CLAUDE.md`. Remove or rephrase each match so it no longer claims the file or server exists.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: remove stale references to src/local-server.ts (file no longer exists)"
```

---

### Task A6: Unit tests for `src/api-client.ts`

- **Owner-files:** `src/test/api-client.test.ts` (new)
- **Read-only refs:** `src/api-client.ts`
- **Depends on:** none
- **Parallel-safe with:** A1, A2, A3, A4, A5, A7, A8, A9

**Why:** `api-client.ts` is the entire HTTP surface for the remote ReCost API plus the `rc-` key prefix gate. Zero coverage today — a contract change goes unnoticed.

- [ ] **Step 1: Read the actual exports first**

Run: `Grep "^export " src/api-client.ts -n`

Expected exports include `validateRcApiKey`, `createProject`, `findProjectByName`, `submitScan`, `getAllEndpoints`, `getAllSuggestions`, `validateProjectId`. The exact list governs which tests you write below — only test functions that actually exist.

- [ ] **Step 2: Write the test file**

Create `src/test/api-client.test.ts`:

```typescript
import assert from "node:assert/strict";
import { validateRcApiKey } from "../api-client";

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

function installFetch(handler: (input: FetchInput, init: FetchInit) => Response | Promise<Response>) {
  const original = globalThis.fetch;
  // @ts-expect-error — test seam
  globalThis.fetch = async (input: FetchInput, init?: FetchInit) => handler(input, init);
  return () => { globalThis.fetch = original; };
}

async function runTests() {
  // 1. Rejects keys that don't start with rc-
  {
    let called = false;
    const restore = installFetch(() => { called = true; return new Response("", { status: 200 }); });
    try {
      await assert.rejects(() => validateRcApiKey("sk-1234"), /rc-/);
      assert.equal(called, false, "fetch should not be called for malformed key");
    } finally { restore(); }
  }

  // 2. Returns null on 404 (dev-mode backend)
  {
    const restore = installFetch(() => new Response("", { status: 404 }));
    try {
      const r = await validateRcApiKey("rc-validlooking");
      assert.equal(r, null);
    } finally { restore(); }
  }

  // 3. Throws on 401
  {
    const restore = installFetch(() => new Response(JSON.stringify({ error: { message: "invalid" } }), { status: 401 }));
    try {
      await assert.rejects(() => validateRcApiKey("rc-bad"));
    } finally { restore(); }
  }

  // 4. Returns user payload on 200
  {
    const restore = installFetch(() => new Response(JSON.stringify({ id: "u1", email: "x@y.z" }), { status: 200 }));
    try {
      const r = await validateRcApiKey("rc-good");
      assert.equal((r as { id: string } | null)?.id, "u1");
    } finally { restore(); }
  }

  console.log("PASS api-client");
}

runTests().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 3: Wire the test into the run-list**

In `package.json`, find the `test:scanner` script. Append `&& node dist-test/test/api-client.test.js` to the very end of the chain (before the closing quote). **Watch the contention with A3:** A3 also edits `package.json`. The orchestrator MUST serialize A3 and A6 — run A3 first.

- [ ] **Step 4: Run the test**

Run: `npx tsc -p tsconfig.scanner-tests.json && node dist-test/test/api-client.test.js`
Expected: `PASS api-client`.

- [ ] **Step 5: Commit**

```bash
git add src/test/api-client.test.ts package.json
git commit -m "test(api-client): cover rc- prefix gate, 401/404 paths, success payload"
```

---

### Task A7: Unit tests for `src/key-management.ts`

- **Owner-files:** `src/test/key-management.test.ts` (new)
- **Read-only refs:** `src/key-management.ts`
- **Depends on:** A3 (only because of `package.json` edit ordering), A6 (same reason)
- **Parallel-safe with:** A1, A2, A4, A5, A8, A9

**Why:** `key-management.ts` is the registry for the recost key plus 7 chat-provider keys. Untested today.

- [ ] **Step 1: Read the actual exports**

Run: `Grep "^export " src/key-management.ts -n` and skim the first 80 lines to learn the `KeyServiceDescriptor` shape.

- [ ] **Step 2: Write the test file**

Create `src/test/key-management.test.ts`:

```typescript
import assert from "node:assert/strict";
import {
  buildKeyFingerprint,
  buildKeyStatusSummary,
  getKeyService,
  listKeyServices,
  maskKeyPreview,
} from "../key-management";

function mockSecrets(initial: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initial));
  return {
    async get(k: string) { return store.get(k); },
    async store(k: string, v: string) { store.set(k, v); },
    async delete(k: string) { store.delete(k); },
    onDidChange: () => ({ dispose() {} }),
  };
}

async function runTests() {
  // listKeyServices contains recost and the seven chat providers
  {
    const ids = listKeyServices().map((s) => s.id).sort();
    for (const expected of ["recost", "openai", "anthropic", "gemini", "xai", "cohere", "mistral", "perplexity"]) {
      assert.ok(ids.includes(expected as never), `missing service ${expected}`);
    }
  }

  // getKeyService("recost") returns the recost descriptor with rc- prefix
  {
    const svc = getKeyService("recost");
    assert.equal(svc.id, "recost");
    assert.ok(svc.displayName.length > 0);
  }

  // maskKeyPreview hides everything past 6 chars
  {
    const masked = maskKeyPreview("rc-abcdef1234567890");
    assert.notEqual(masked, "rc-abcdef1234567890");
    assert.match(masked, /\./);
  }
  {
    const masked = maskKeyPreview(undefined);
    assert.equal(typeof masked, "string");
  }

  // buildKeyFingerprint is deterministic and non-reversible
  {
    const fp1 = buildKeyFingerprint("rc-secret");
    const fp2 = buildKeyFingerprint("rc-secret");
    const fp3 = buildKeyFingerprint("rc-different");
    assert.equal(fp1, fp2);
    assert.notEqual(fp1, fp3);
    assert.notEqual(fp1, "rc-secret");
  }

  // buildKeyStatusSummary basics
  {
    const svc = getKeyService("openai");
    const summary = buildKeyStatusSummary({
      service: svc,
      source: "missing",
      state: "missing",
    });
    assert.equal(summary.serviceId, "openai");
    assert.equal(summary.state, "missing");
  }

  console.log("PASS key-management");
}

runTests().catch((e) => { console.error(e); process.exit(1); });
```

If any imported symbol does not match the actual API in `src/key-management.ts`, adapt the test (e.g., if `buildKeyStatusSummary` requires different fields). Do not invent functions that do not exist.

- [ ] **Step 3: Wire and run**

Append `&& node dist-test/test/key-management.test.js` to the `test:scanner` script in `package.json`.
Run: `npx tsc -p tsconfig.scanner-tests.json && node dist-test/test/key-management.test.js`
Expected: `PASS key-management`.

- [ ] **Step 4: Commit**

```bash
git add src/test/key-management.test.ts package.json
git commit -m "test(key-management): cover service registry, masking, fingerprint, summary"
```

---

### Task A8: WASM-unavailable fallback test for `src/ast/parser-loader.ts`

- **Owner-files:** `src/test/ast-parser-loader-fallback.test.ts` (new)
- **Read-only refs:** `src/ast/parser-loader.ts`, `src/scanner/core-scanner.ts`
- **Depends on:** A3, A6, A7 (only for `package.json` edit ordering)
- **Parallel-safe with:** A1, A2, A4, A5, A9

**Why:** Audit noted the regex-fallback path (taken when `web-tree-sitter` can't be required) has no test. A silent regression there would degrade detection accuracy in production with no warning.

- [ ] **Step 1: Inspect the loader's fallback surface**

Read `src/ast/parser-loader.ts` and locate (a) the lazy `require("web-tree-sitter")` call wrapped in try/catch, (b) the exported `ensureInitialized()` and `getParser()` helpers, (c) the boolean that signals "AST disabled". The test must drive the disabled branch without actually breaking the module for other tests.

- [ ] **Step 2: Write a test that proves the workspace-scanner still produces matches with AST disabled**

Create `src/test/ast-parser-loader-fallback.test.ts`:

```typescript
import assert from "node:assert/strict";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

async function runTests() {
  // Force AST off for the duration of this test by setting the documented env var.
  // (If parser-loader.ts uses a different mechanism, adapt this test to match.)
  process.env.RECOST_DISABLE_AST = "1";

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "recost-ast-fallback-"));
  try {
    const file = path.join(tmp, "uses-openai.ts");
    await fs.writeFile(
      file,
      `import OpenAI from "openai";\nconst client = new OpenAI();\nawait client.chat.completions.create({ model: "gpt-4", messages: [] });\n`,
      "utf8"
    );

    // Import lazily so the env var is picked up
    const { scanFileContent } = await import("../scanner/core-scanner");
    const source = await fs.readFile(file, "utf8");
    const results = await scanFileContent({ filePath: file, source, language: "typescript" });

    assert.ok(Array.isArray(results.apiCalls), "expected apiCalls array");
    assert.ok(results.apiCalls.length > 0, "regex fallback should still detect openai chat.completions.create");
    const hit = results.apiCalls.find((c) => /openai/i.test(c.provider) || /chat\.completions/.test(c.methodSignature ?? ""));
    assert.ok(hit, "expected at least one openai chat match");
  } finally {
    delete process.env.RECOST_DISABLE_AST;
    await fs.rm(tmp, { recursive: true, force: true });
  }

  console.log("PASS ast-parser-loader-fallback");
}

runTests().catch((e) => { console.error(e); process.exit(1); });
```

**If `core-scanner` does not expose a `scanFileContent` helper with this shape**, open the file and adapt the call to match what is exported. The test's claim is: when AST is disabled, the regex pass alone still produces at least one OpenAI match for a chat-completions call. Use whatever entry point delivers that.

**If `parser-loader.ts` does not honor `RECOST_DISABLE_AST`**, add the env check there in this task: at the top of the lazy require, return early if `process.env.RECOST_DISABLE_AST === "1"`. Document the env var in CLAUDE.md (a one-line entry in the "VSCode Settings" or a new "Env Vars" section).

- [ ] **Step 3: Wire and run**

Append `&& node dist-test/test/ast-parser-loader-fallback.test.js` to the `test:scanner` script.
Run: `npx tsc -p tsconfig.scanner-tests.json && node dist-test/test/ast-parser-loader-fallback.test.js`
Expected: `PASS ast-parser-loader-fallback`.

- [ ] **Step 4: Commit**

```bash
git add src/test/ast-parser-loader-fallback.test.ts src/ast/parser-loader.ts CLAUDE.md package.json
git commit -m "test(ast): cover regex fallback when web-tree-sitter is disabled"
```

---

### Task A9: Unit tests for `src/intelligence/cost-utils.ts`

- **Owner-files:** `src/intelligence/__tests__/cost-utils.test.ts` (new)
- **Read-only refs:** `src/intelligence/cost-utils.ts`, `src/scanner/fingerprints/registry.ts`
- **Depends on:** A3, A6, A7, A8 (for `package.json` edit ordering)
- **Parallel-safe with:** A1, A2, A4, A5

**Why:** `estimateLocalMonthlyCost` is the canonical pricing function. Phase C will delete two duplicate copies and import from here. Without test coverage on the canonical version, Phase C is risky.

- [ ] **Step 1: Write the test**

Create `src/intelligence/__tests__/cost-utils.test.ts`:

```typescript
import assert from "node:assert/strict";
import { estimateLocalMonthlyCost } from "../cost-utils";

async function runTests() {
  // Null-safety contract
  assert.equal(estimateLocalMonthlyCost("", 100), null);
  assert.equal(estimateLocalMonthlyCost("unknown", 100), null);
  assert.equal(estimateLocalMonthlyCost("nonexistent-provider", 100), null);
  assert.equal(estimateLocalMonthlyCost("openai", NaN), null);
  assert.equal(estimateLocalMonthlyCost("openai", -5), null);

  // Zero calls → zero cost (for a known provider)
  assert.equal(estimateLocalMonthlyCost("openai", 0), 0);

  // Known table provider produces a positive number
  const stripe = estimateLocalMonthlyCost("stripe", 100);
  assert.ok(stripe !== null && stripe > 0, `expected positive cost, got ${stripe}`);

  // Fingerprint method lookups are honored when supplied
  const openaiChat = estimateLocalMonthlyCost("openai", 1000, "openai.chat.completions.create");
  assert.ok(openaiChat !== null);

  console.log("PASS cost-utils");
}

runTests().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Wire and run**

Append `&& node dist-test/intelligence/__tests__/cost-utils.test.js` to the `test:scanner` script.
Run: `npx tsc -p tsconfig.scanner-tests.json && node dist-test/intelligence/__tests__/cost-utils.test.js`
Expected: `PASS cost-utils`.

- [ ] **Step 3: Commit**

```bash
git add src/intelligence/__tests__/cost-utils.test.ts package.json
git commit -m "test(cost-utils): cover null contract, zero, table provider, method fingerprint"
```

---

# Phase B — Parallel After Phase A (2 tasks)

Both B-tasks own disjoint files. Dispatch in one batch after A completes.

---

### Task B1: Harden `src/extension.ts` (interval cleanup, error logging)

- **Owner-files:** `src/extension.ts`
- **Read-only refs:** `src/output.ts`
- **Depends on:** A1, A2 (so the new tsconfig flags don't trip this commit)
- **Parallel-safe with:** B2

**Why:** P3 findings on `extension.ts`: (a) the pricing-sync `setInterval` at line 310 already pushes a disposer onto `context.subscriptions`, but if `activate()` is ever called twice in the same process (e.g., reload-window during dev) without `deactivate()` running between, two intervals coexist. (b) `scheduleKeyIndicatorRefresh` at line 127 logs errors only to `console.error` — leaks past the user-facing OutputChannel.

- [ ] **Step 1: Hoist the interval id to module scope so duplicate activations are caught**

Open `src/extension.ts`. Near the top of the file (after the imports), add a module-scoped guard:

```typescript
let activePricingSyncIntervalId: ReturnType<typeof setInterval> | null = null;
```

In `activate()`, replace lines 306-311 (the `setInterval` setup) with:

```typescript
  if (activePricingSyncIntervalId !== null) {
    clearInterval(activePricingSyncIntervalId);
    activePricingSyncIntervalId = null;
  }
  activePricingSyncIntervalId = setInterval(syncPricing, intervalHours * 60 * 60 * 1_000);
  const pricingIntervalDisposer: vscode.Disposable = {
    dispose: () => {
      if (activePricingSyncIntervalId !== null) {
        clearInterval(activePricingSyncIntervalId);
        activePricingSyncIntervalId = null;
      }
    },
  };
  context.subscriptions.push(pricingIntervalDisposer);
```

In the existing `deactivate()` function (search for it; if it does not exist, add at the bottom of the file):

```typescript
export function deactivate(): void {
  if (activePricingSyncIntervalId !== null) {
    clearInterval(activePricingSyncIntervalId);
    activePricingSyncIntervalId = null;
  }
}
```

- [ ] **Step 2: Route `scheduleKeyIndicatorRefresh` errors through the OutputChannel only**

At `src/extension.ts:127-130`, replace:

```typescript
  })().catch((err: unknown) => {
    logStatus(output, `scheduleKeyIndicatorRefresh: error reason=${reason} message=${err instanceof Error ? err.message : String(err)}`);
    console.error("ReCost: key indicator refresh error", err);
  });
```

with:

```typescript
  })().catch((err: unknown) => {
    logStatus(output, `scheduleKeyIndicatorRefresh: error reason=${reason} message=${err instanceof Error ? err.message : String(err)}`);
  });
```

The `console.error` call is redundant — `logStatus` already writes to the OutputChannel and `console.error` leaks into the Extension Host log where users do not see it anyway.

- [ ] **Step 3: Sanity check — build and full test pass**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | tail -20` → no new errors.
Run: `npm test 2>&1 | tail -20` → all green (extension.ts isn't directly tested yet — F3 adds that — but the suite must still pass).

- [ ] **Step 4: Commit**

```bash
git add src/extension.ts
git commit -m "fix(extension): guard pricing-sync interval against double-activate; drop redundant console.error"
```

---

### Task B2: Convert `src/intelligence/compression.ts` to async I/O

- **Owner-files:** `src/intelligence/compression.ts`, `src/test/intelligence-compression-async.test.ts` (new)
- **Read-only refs:** `src/intelligence/types.ts`
- **Depends on:** A1, A2
- **Parallel-safe with:** B1

**Why:** P0 audit finding. `readSnippet` at `compression.ts:539` uses `fs.readFileSync` on the extension host main thread. Caller chain stays sync all the way up to `compressClusters`, which is called from `webview-provider.ts` during AI context compression and from `cli/scan.ts`. Phase C3 will propagate the async signature into webview-provider.ts.

**Scope discipline:** This task **does not** modify callers in `webview-provider.ts` or `cli/scan.ts`. After this task lands, those files will fail to compile because `compressClusters` returns a Promise. That's the trigger for tasks C3 (webview-provider) and a small follow-up in F (see below). The orchestrator **must not** run Phase C or `npm test` against `webview-provider.ts` until this caller-fix lands. To avoid a broken-master window, run B2 and C3 back-to-back as a single PR.

- [ ] **Step 1: Write the failing test**

Create `src/test/intelligence-compression-async.test.ts`:

```typescript
import assert from "node:assert/strict";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { compressClusters } from "../intelligence/compression";

async function runTests() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "recost-compress-"));
  try {
    const file = path.join(tmp, "sample.ts");
    await fs.writeFile(file, "line1\nline2\nline3\nline4\n", "utf8");

    const cluster = {
      id: "c1",
      files: [{ filePath: "sample.ts", apiCallIds: [], findingIds: [] }],
      apiCallIds: [],
      findingIds: [],
      tokenBudget: 4000,
    } as never;

    const snapshot = {
      repoRoot: tmp,
      files: [{ filePath: "sample.ts", apiCalls: [], findings: [], score: 0, tags: [] }],
      apiCalls: [],
      findings: [],
      providers: [],
    } as never;

    const result = await compressClusters([cluster], snapshot);
    assert.ok(Array.isArray(result));
    assert.ok(JSON.stringify(result).includes("line"), "snippet must contain file content");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
  console.log("PASS intelligence-compression-async");
}

runTests().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npx tsc -p tsconfig.scanner-tests.json 2>&1 | tail -20`
Expected: compile error because `compressClusters` is sync but the test awaits it — or the test runs and times out.

- [ ] **Step 3: Convert imports and `readSnippet` to async**

In `src/intelligence/compression.ts`:

1. Change `import * as fs from "fs";` to `import * as fs from "fs/promises";`.
2. Replace the `readSnippet` function (around lines 534-560) with:

```typescript
async function readSnippet(range: SnippetRange, snapshot: RepoIntelligenceSnapshot): Promise<CompressedSnippet | null> {
  const absolutePath = path.resolve(snapshot.repoRoot ?? process.cwd(), range.filePath);
  let source: string;
  try {
    source = await fs.readFile(absolutePath, "utf8");
  } catch {
    return null;
  }
  const lines = source.split("\n");
  if (lines.length === 0) return null;
  const startIndex = Math.max(0, range.startLine - 1);
  const endIndex = Math.min(lines.length - 1, range.endLine - 1);
  const snippetLines = lines.slice(startIndex, endIndex + 1);
  const code = snippetLines.join("\n").trim();
  if (!code) return null;
  return { filePath: range.filePath, startLine: startIndex + 1, endLine: endIndex + 1, code, label: range.label };
}
```

- [ ] **Step 4: Propagate `async` up the call chain inside this file only**

Run: `Grep "readSnippet\(" src/intelligence/compression.ts`

For each call site:
- Add `await` in front of the call.
- Mark the enclosing function `async`.
- If the function previously returned `T`, change to `Promise<T>`.

Continue propagating until you reach `compressClusters`. Change its signature to:

```typescript
export async function compressClusters(
  clusters: ReviewCluster[],
  snapshot: RepoIntelligenceSnapshot,
  options?: CompressClustersOptions
): Promise<CompressedCluster[]> { ... }
```

If any helper used `.map(readSnippet)` to build a `CompressedSnippet[]`, replace with `await Promise.all(ranges.map((r) => readSnippet(r, snapshot)))` and then filter `null`s with `.filter((s): s is CompressedSnippet => s !== null)`.

- [ ] **Step 5: Run the new test and the existing compression test**

Run: `npx tsc -p tsconfig.scanner-tests.json && node dist-test/test/intelligence-compression-async.test.js && node dist-test/intelligence/__tests__/compression.test.js`
Expected: both PASS.

- [ ] **Step 6: Wire the new test into `package.json`**

Append `&& node dist-test/test/intelligence-compression-async.test.js` to the `test:scanner` script.

- [ ] **Step 7: Commit**

```bash
git add src/intelligence/compression.ts src/test/intelligence-compression-async.test.ts package.json
git commit -m "fix(intelligence): make compressClusters async to unblock the extension host"
```

**Note for orchestrator:** After B2 commits, the project's `webview-provider.ts` and `cli/scan.ts` will fail typecheck. Proceed directly to Phase C — do not pause for a green build between B and C.

---

# Phase C — Serial on `src/webview-provider.ts` (6 tasks)

Every C-task modifies `src/webview-provider.ts`. Run them strictly in order C1 → C2 → C3 → C4 → C5 → C6. After C2 commits, dispatch E1 in parallel (E1 owns `src/scan-results.ts` and does not touch webview-provider).

---

### Task C1: Dispatch helper, error boundary, default case, listener disposal

- **Owner-files:** `src/webview-provider.ts`, `src/test/webview-provider-dispatch.test.ts` (new)
- **Read-only refs:** `src/messages.ts`, `src/output.ts`
- **Depends on:** B1, B2
- **Parallel-safe with:** E1

**Why:** Three P0 findings consolidated:
1. The `onDidReceiveMessage` listener at `webview-provider.ts:779-781` is not registered with `context.subscriptions` — stacks on every re-resolve.
2. `handleMessage` is async with no `.catch()` — every throw in the 17 switch cases is swallowed.
3. The switch has no `default` case — unknown message types disappear silently and there's no exhaustiveness guarantee against future `WebviewMessage` variants.

- [ ] **Step 1: Write the failing test**

Create `src/test/webview-provider-dispatch.test.ts`:

```typescript
import assert from "node:assert/strict";
import { dispatchWebviewMessage } from "../webview-provider";
import type { WebviewMessage } from "../messages";

function makeHandlers(overrides: Partial<Record<string, (...args: never[]) => unknown>> = {}) {
  const noop = async () => {};
  return {
    startScan: noop, runAiReview: noop, chat: noop, modelChanged: noop,
    applyFix: noop, openFile: noop, openDashboard: noop, runSimulation: noop,
    getAllKeyStatuses: noop, getProjectIdStatus: noop, setKey: noop, clearKey: noop,
    setProjectId: noop, clearProjectId: noop, testKey: noop, navigate: () => {},
    copyAiContext: noop, log: () => {},
    ...overrides,
  } as never;
}

async function runTests() {
  // Unknown type → status "unknown"; logged but not thrown
  {
    let logged = "";
    const r = await dispatchWebviewMessage(
      { type: "garbage" } as unknown as WebviewMessage,
      makeHandlers({ log: (m) => { logged = m as string; } })
    );
    assert.equal(r.status, "unknown");
    assert.match(logged, /unknown message type/i);
  }

  // Handler throw → status "error"; error message preserved
  {
    let logged = "";
    const r = await dispatchWebviewMessage(
      { type: "startScan" } as WebviewMessage,
      makeHandlers({
        startScan: async () => { throw new Error("boom"); },
        log: (m) => { logged = m as string; },
      })
    );
    assert.equal(r.status, "error");
    assert.ok((r as { error: string }).error.includes("boom"));
    assert.match(logged, /boom/);
  }

  // Success → status "ok", handler called once
  {
    let count = 0;
    const r = await dispatchWebviewMessage(
      { type: "startScan" } as WebviewMessage,
      makeHandlers({ startScan: async () => { count++; } })
    );
    assert.equal(r.status, "ok");
    assert.equal(count, 1);
  }

  console.log("PASS webview-provider-dispatch");
}

runTests().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Run it; verify it fails**

Run: `npx tsc -p tsconfig.scanner-tests.json && node dist-test/test/webview-provider-dispatch.test.js`
Expected: FAIL — `dispatchWebviewMessage is not exported`.

- [ ] **Step 3: Add the dispatch helper to `webview-provider.ts`**

In `src/webview-provider.ts`, immediately ABOVE `export class` (the provider class declaration), add:

```typescript
export interface WebviewMessageHandlers {
  startScan(): Promise<void>;
  runAiReview(): Promise<void>;
  chat(text: string, provider: string, model: string): Promise<void>;
  modelChanged(provider: string, model: string): Promise<void>;
  applyFix(code: string, file: string, line?: number): Promise<void>;
  openFile(file: string, line?: number): Promise<void>;
  openDashboard(): Promise<void>;
  runSimulation(input: SimulatorInput): void | Promise<void>;
  getAllKeyStatuses(): Promise<void>;
  getProjectIdStatus(): Promise<void>;
  setKey(serviceId: KeyServiceId, value: string): Promise<void>;
  clearKey(serviceId: KeyServiceId): Promise<void>;
  setProjectId(value: string): Promise<void>;
  clearProjectId(): Promise<void>;
  testKey(serviceId: KeyServiceId): Promise<void>;
  navigate(screen: string, focusServiceId?: KeyServiceId): void;
  copyAiContext(): Promise<void>;
  log(message: string): void;
}

export type DispatchResult =
  | { status: "ok" }
  | { status: "unknown" }
  | { status: "error"; error: string };

export async function dispatchWebviewMessage(
  message: WebviewMessage,
  handlers: WebviewMessageHandlers
): Promise<DispatchResult> {
  try {
    switch (message.type) {
      case "startScan": await handlers.startScan(); return { status: "ok" };
      case "runAiReview": await handlers.runAiReview(); return { status: "ok" };
      case "chat": await handlers.chat(message.text, message.provider, message.model); return { status: "ok" };
      case "modelChanged": await handlers.modelChanged(message.provider, message.model); return { status: "ok" };
      case "applyFix": await handlers.applyFix(message.code, message.file, message.line); return { status: "ok" };
      case "openFile": await handlers.openFile(message.file, message.line); return { status: "ok" };
      case "openDashboard": await handlers.openDashboard(); return { status: "ok" };
      case "runSimulation": await handlers.runSimulation(message.input); return { status: "ok" };
      case "getAllKeyStatuses": await handlers.getAllKeyStatuses(); return { status: "ok" };
      case "getProjectIdStatus": await handlers.getProjectIdStatus(); return { status: "ok" };
      case "setKey": await handlers.setKey(message.serviceId, message.value); return { status: "ok" };
      case "clearKey": await handlers.clearKey(message.serviceId); return { status: "ok" };
      case "setProjectId": await handlers.setProjectId(message.value); return { status: "ok" };
      case "clearProjectId": await handlers.clearProjectId(); return { status: "ok" };
      case "testKey": await handlers.testKey(message.serviceId); return { status: "ok" };
      case "navigate":
        if (message.screen === "keys") handlers.navigate(message.screen, message.focusServiceId);
        return { status: "ok" };
      case "copyAiContext": await handlers.copyAiContext(); return { status: "ok" };
      default: {
        const _exhaustive: never = message;
        const t = (message as { type?: string }).type ?? "<no-type>";
        handlers.log(`unknown message type: ${t}`);
        void _exhaustive;
        return { status: "unknown" };
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    handlers.log(`webview message handler failed (${(message as { type?: string }).type ?? "?"}): ${msg}`);
    return { status: "error", error: msg };
  }
}
```

If `getOutputChannel` is not already imported, add at the top: `import { getOutputChannel } from "./output";`.

- [ ] **Step 4: Rewrite `handleMessage` to call the helper**

Replace `handleMessage` (lines 1113-1177) with:

```typescript
  private async handleMessage(message: WebviewMessage): Promise<void> {
    await dispatchWebviewMessage(message, {
      startScan: () => this.handleStartScan(),
      runAiReview: () => this.handleRunAiReview(),
      chat: (text, provider, model) => this.handleChat(text, provider, model),
      modelChanged: async (provider, model) => {
        await this.context.globalState.update("recost.selectedChatProvider", provider);
        await this.context.globalState.update("recost.selectedChatModel", model);
        await this.sendChatConfig(provider as ChatProviderId, model);
        await this.sendAllKeyStatuses();
      },
      applyFix: (code, file, line) => this.handleApplyFix(code, file, line),
      openFile: (file, line) => this.handleOpenFile(file, line),
      openDashboard: () => this.handleOpenDashboard(),
      runSimulation: (input) => { this.handleRunSimulation(input); },
      getAllKeyStatuses: () => this.sendAllKeyStatuses(),
      getProjectIdStatus: () => this.sendProjectIdStatus(),
      setKey: (serviceId, value) => this.setServiceKey(serviceId, value),
      clearKey: (serviceId) => this.clearServiceKey(serviceId),
      setProjectId: async (value) => {
        await this.setManualProjectId(value);
        await this.clearProjectIdValidationState();
        await this.validateManualProjectId();
      },
      clearProjectId: async () => {
        await this.clearManualProjectId();
        await this.clearProjectIdValidationState();
        await this.sendProjectIdStatus();
      },
      testKey: (serviceId) => this.testServiceKey(serviceId),
      navigate: (_screen, focusServiceId) => this.openKeys(focusServiceId),
      copyAiContext: () => this.handleCopyAiContext(),
      log: (m) => getOutputChannel().appendLine(m),
    });
  }
```

- [ ] **Step 5: Register the listener with `context.subscriptions`**

In `resolveWebviewView` at lines 779-781, replace:

```typescript
    webviewView.webview.onDidReceiveMessage(
      (message: WebviewMessage) => this.handleMessage(message)
    );
```

with:

```typescript
    const messageSub = webviewView.webview.onDidReceiveMessage(
      (message: WebviewMessage) => { void this.handleMessage(message); }
    );
    this.context.subscriptions.push(messageSub);
    webviewView.onDidDispose(() => messageSub.dispose());
```

- [ ] **Step 6: Surface (not swallow) the boot promises**

In `resolveWebviewView` at lines 784-786, replace the three `void` calls with:

```typescript
    this.sendChatConfig().catch((e) => getOutputChannel().appendLine(`sendChatConfig failed: ${e instanceof Error ? e.message : String(e)}`));
    this.sendAllKeyStatuses().catch((e) => getOutputChannel().appendLine(`sendAllKeyStatuses failed: ${e instanceof Error ? e.message : String(e)}`));
    this.sendProjectIdStatus().catch((e) => getOutputChannel().appendLine(`sendProjectIdStatus failed: ${e instanceof Error ? e.message : String(e)}`));
```

- [ ] **Step 7: Wire and run**

Append `&& node dist-test/test/webview-provider-dispatch.test.js` to the `test:scanner` script.
Run: `npx tsc -p tsconfig.scanner-tests.json && node dist-test/test/webview-provider-dispatch.test.js`
Expected: `PASS webview-provider-dispatch`. Also run the full suite: `npm test 2>&1 | tail -5` — green.

- [ ] **Step 8: Commit**

```bash
git add src/webview-provider.ts src/test/webview-provider-dispatch.test.ts package.json
git commit -m "fix(webview): exhaustive dispatch with error boundary, default case, and tracked listener"
```

---

### Task C2: Replace local `estimateLocalMonthlyCost` and `LOCAL_PRICING` with imports from `cost-utils`

- **Owner-files:** `src/webview-provider.ts`
- **Read-only refs:** `src/intelligence/cost-utils.ts`
- **Depends on:** C1, A9
- **Parallel-safe with:** E1

**Why:** Three copies of `estimateLocalMonthlyCost` exist (`webview-provider.ts:174`, `scan-results.ts:133`, `intelligence/cost-utils.ts:44`) with divergent null/fallback behavior. `cost-utils.ts` is the source of truth (returns `number | null`). Phase C2 removes the webview copy; Phase E1 removes the scan-results copy.

- [ ] **Step 1: Delete the local pricing table and function**

In `src/webview-provider.ts`:
- Delete the `LOCAL_PRICING` constant (search for `LOCAL_PRICING` to find it; in the audit it lived around lines 105-171).
- Delete the `DEFAULT_PER_CALL_COST` constant.
- Delete the local `estimateLocalMonthlyCost` function (lines 174-198 at audit time).

- [ ] **Step 2: Import the canonical one**

Find the existing imports block (top of file). Add:

```typescript
import { estimateLocalMonthlyCost } from "./intelligence/cost-utils";
```

If `lookupMethod` from `./scanner/fingerprints/registry` is no longer used elsewhere in this file (grep to confirm), remove its import.

- [ ] **Step 3: Update call sites to handle `number | null`**

Run inside this file: `Grep "estimateLocalMonthlyCost\(" src/webview-provider.ts -n`.

For each call site, wrap the result so downstream code that expects `number` still gets one:

```typescript
const cost = estimateLocalMonthlyCost(provider, callsPerDay, methodSignature) ?? 0;
```

When a caller threads the result into `chooseSeverity` (which expects `number`), use the `?? 0` form. When the caller already handles `null` explicitly, leave the union intact.

- [ ] **Step 4: Build and test**

Run: `npx tsc --noEmit -p tsconfig.json` → no errors.
Run: `npm test 2>&1 | tail -5` → green.

- [ ] **Step 5: Commit**

```bash
git add src/webview-provider.ts
git commit -m "refactor(webview): use cost-utils.estimateLocalMonthlyCost as single source of truth"
```

---

### Task C3: Propagate the async `compressClusters` signature

- **Owner-files:** `src/webview-provider.ts`, `src/cli/scan.ts`
- **Read-only refs:** `src/intelligence/compression.ts`
- **Depends on:** B2, C2
- **Parallel-safe with:** E1

**Why:** B2 made `compressClusters` return `Promise<CompressedCluster[]>`. Two callers exist: `handleCopyAiContext` in `webview-provider.ts` and the CLI entry in `cli/scan.ts`. Both must `await` and become `async` if they are not already.

**Scope note:** `cli/scan.ts` is added to this task's owner-files because it is a single line change and pairing it with the webview change keeps the build green at every commit. The orchestrator must not run any other task on `cli/scan.ts` until C3 commits — at the time of writing no other task touches it.

- [ ] **Step 1: Find every `compressClusters(` call site**

Run: `Grep "compressClusters\(" src/ --include="*.ts" -n`

Expected hits: declaration in `src/intelligence/compression.ts` (already async), callers in `src/webview-provider.ts` and `src/cli/scan.ts`.

- [ ] **Step 2: Update the webview caller**

Inside `handleCopyAiContext` (search for it in `webview-provider.ts`), find the `compressClusters(...)` call and change `const x = compressClusters(...)` to `const x = await compressClusters(...)`. The enclosing function should already be `async` — verify.

- [ ] **Step 3: Update the CLI caller**

In `src/cli/scan.ts`, find the `compressClusters(...)` call. Add `await`. The enclosing function should already be `async` (the CLI entry is async at the top level).

- [ ] **Step 4: Type-check and test**

Run: `npx tsc --noEmit -p tsconfig.json` → no errors.
Run: `npm test 2>&1 | tail -5` → green.

- [ ] **Step 5: Commit**

```bash
git add src/webview-provider.ts src/cli/scan.ts
git commit -m "fix(callers): await the now-async compressClusters in webview and CLI"
```

---

### Task C4: Route the intelligence debug spam through the OutputChannel

- **Owner-files:** `src/webview-provider.ts`
- **Read-only refs:** `src/output.ts`
- **Depends on:** C3
- **Parallel-safe with:** E1

**Why:** Lines 1255-1263 emit `console.log` (gated on `RECOST_INTELLIGENCE_DEBUG === "1"`) with cost-leak / reliability-risk numbers per file. `console.log` from the extension host goes to the Extension Host log window — invisible to users. The extension has a real OutputChannel (`getOutputChannel()` from `src/output.ts`).

- [ ] **Step 1: Replace the `console.log` block**

In `src/webview-provider.ts` at the block around line 1255, replace:

```typescript
        for (const file of scored.scoredFiles.slice(0, 5)) {
          console.log(
            `[intelligence] ${file.filePath} | priority=${file.scores.aiReviewPriority.toFixed(2)} | ` +
              `importance=${file.scores.importance.toFixed(2)} | ` +
              `costLeak=${file.scores.costLeak.toFixed(2)} | ` +
              `reliabilityRisk=${file.scores.reliabilityRisk.toFixed(2)} | ` +
              `reasons=${file.reasons.join("; ")}`
          );
        }
```

with:

```typescript
        if (process.env.RECOST_INTELLIGENCE_DEBUG === "1") {
          const ch = getOutputChannel();
          for (const file of scored.scoredFiles.slice(0, 5)) {
            ch.appendLine(
              `[intelligence] ${file.filePath} | priority=${file.scores.aiReviewPriority.toFixed(2)} | ` +
                `importance=${file.scores.importance.toFixed(2)} | ` +
                `costLeak=${file.scores.costLeak.toFixed(2)} | ` +
                `reliabilityRisk=${file.scores.reliabilityRisk.toFixed(2)} | ` +
                `reasons=${file.reasons.join("; ")}`
            );
          }
        }
```

If `getOutputChannel` is already imported (C1 added it) this builds cleanly. Otherwise add the import.

- [ ] **Step 2: Verify no other `console.log` remains in this file**

Run: `Grep "console\\.(log|warn|debug)\\(" src/webview-provider.ts -n`. The audit identified only the one block above. If others appear, route them through `getOutputChannel().appendLine` in this same commit.

- [ ] **Step 3: Test**

Run: `npx tsc --noEmit -p tsconfig.json && npm test 2>&1 | tail -5` → green.

- [ ] **Step 4: Commit**

```bash
git add src/webview-provider.ts
git commit -m "fix(webview): route intelligence debug output through OutputChannel"
```

---

### Task C5: Serialize scenario persistence to eliminate the globalState race

- **Owner-files:** `src/webview-provider.ts`
- **Read-only refs:** `src/simulator/types.ts`
- **Depends on:** C4
- **Parallel-safe with:** E1

**Why:** `savedScenarios` is loaded once in the constructor and mutated by both `handleRunSimulation` and the `onScenariosChanged` callback. Two rapid scenario saves can race; `context.globalState.update` is not transactional so updates can be lost.

- [ ] **Step 1: Add a single-flight queue around scenario persistence**

In `src/webview-provider.ts`, near the top of the provider class (where `savedScenarios` is declared), add:

```typescript
  private scenarioPersistQueue: Promise<void> = Promise.resolve();
```

Replace every existing call site that does `await this.context.globalState.update("eco.simulatorScenarios", this.savedScenarios)` with a call to a new helper. Add the helper as a private method:

```typescript
  private async persistScenarios(next: import("./simulator/types").SavedScenario[]): Promise<void> {
    this.savedScenarios = next;
    this.scenarioPersistQueue = this.scenarioPersistQueue
      .catch(() => {})
      .then(() => this.context.globalState.update("eco.simulatorScenarios", next));
    await this.scenarioPersistQueue;
  }
```

- [ ] **Step 2: Replace mutation+update pairs with calls to `persistScenarios`**

Use `Grep "savedScenarios" src/webview-provider.ts -n` to find every mutation. For each, replace the pattern:

```typescript
this.savedScenarios = [...next];
await this.context.globalState.update("eco.simulatorScenarios", this.savedScenarios);
```

with:

```typescript
await this.persistScenarios(next);
```

Leave read-only access to `this.savedScenarios` unchanged.

- [ ] **Step 3: Type-check and test**

Run: `npx tsc --noEmit -p tsconfig.json && npm test 2>&1 | tail -5` → green.

- [ ] **Step 4: Commit**

```bash
git add src/webview-provider.ts
git commit -m "fix(webview): serialize scenario persistence through a single-flight queue"
```

---

### Task C6: Surface debug-export failures to the user

- **Owner-files:** `src/webview-provider.ts`
- **Read-only refs:** none
- **Depends on:** C5
- **Parallel-safe with:** E1

**Why:** Audit P1 noted that `debugExportScanResults` at `webview-provider.ts:751-754` writes errors only to the OutputChannel. If the export path is invalid (e.g., read-only), the user sees nothing. Compare to other write paths (line 1205) which surface errors via `vscode.window.showErrorMessage`.

- [ ] **Step 1: Add a user-visible error for export failures**

Find the catch block (~`webview-provider.ts:751-754`). Replace:

```typescript
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.outputChannel.appendLine(`[debug-export] Failed to write ${exportPath}: ${message}`);
    }
```

with:

```typescript
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.outputChannel.appendLine(`[debug-export] Failed to write ${exportPath}: ${message}`);
      vscode.window.showErrorMessage(`ReCost: failed to export scan results: ${message}`);
    }
```

- [ ] **Step 2: Type-check, test, commit**

Run: `npx tsc --noEmit -p tsconfig.json && npm test 2>&1 | tail -5`.

```bash
git add src/webview-provider.ts
git commit -m "fix(webview): surface debug-export failures to the user"
```

---

# Phase D — God-File Extraction (4 SERIAL tasks)

Each D-task extracts a cluster of methods out of `src/webview-provider.ts` into its own file under `src/webview/`. The orchestrator MUST run D1 → D2 → D3 → D4 in order — every task modifies `webview-provider.ts`. Parallelism inside each task: creating the new file and updating `webview-provider.ts` is one indivisible unit.

**Discipline:** Each extraction must be **structurally pure** — no behavioral changes, only code motion. After each task: `npm test` is green; the diff in `webview-provider.ts` shows removed methods plus a delegate call; the new file shows the same methods. If you find a real bug while extracting, file a new task in `metadata` and commit the extraction first, fix second.

---

### Task D1: Extract `ChatHandler`

- **Owner-files:** `src/webview/chat-handler.ts` (new), `src/webview-provider.ts`
- **Read-only refs:** `src/chat/index.ts`, `src/chat/types.ts`, `src/messages.ts`
- **Depends on:** C6
- **Parallel-safe with:** E1 (E1 owns scan-results.ts only)

**Why:** Audit found `webview-provider.ts` is 2281 lines. The chat methods (`handleChat`, `handleRunAiReview`, `sendChatConfig`, `chatHistory` state, plus per-provider plumbing) form a cohesive ~250-line cluster that maps cleanly to a separate handler.

- [ ] **Step 1: Inventory the chat surface**

Run `Grep "handleChat\\|handleRunAiReview\\|sendChatConfig\\|chatHistory\\|chatStreaming" src/webview-provider.ts -n` and record every line range. These are the methods + private fields that will move.

- [ ] **Step 2: Create `src/webview/chat-handler.ts`**

Move the following private members from `WebviewProvider` into a new exported class `ChatHandler`:
- `chatHistory: ChatMessage[]`
- `handleChat(text, provider, model)`
- `handleRunAiReview()`
- `sendChatConfig(provider?, model?)`
- any pure helpers used only by the above

`ChatHandler`'s constructor takes the dependencies it needs explicitly (rather than reaching into the provider):

```typescript
import * as vscode from "vscode";
import type { HostMessage, WebviewMessage } from "../messages";
import type { ChatProviderId } from "../chat";

export interface ChatHandlerContext {
  postMessage(message: HostMessage): void;
  getOutputChannel(): vscode.OutputChannel;
  getSecrets(): vscode.SecretStorage;
  getGlobalState(): vscode.Memento;
  // ...add the exact deps the moved methods need
}

export class ChatHandler {
  private history: ChatMessage[] = [];
  constructor(private readonly ctx: ChatHandlerContext) {}
  // moved methods here
}
```

Copy each moved method verbatim, then replace `this.postMessage(...)` with `this.ctx.postMessage(...)`, `this.context.secrets` with `this.ctx.getSecrets()`, etc.

- [ ] **Step 3: Delegate from `WebviewProvider`**

In the provider, instantiate `ChatHandler` in the constructor (`this.chatHandler = new ChatHandler({...})`) and replace each moved method with a thin delegator:

```typescript
  private handleChat(text: string, provider: string, model: string) {
    return this.chatHandler.handleChat(text, provider, model);
  }
```

This keeps the existing `WebviewMessageHandlers` wiring in `handleMessage` (Task C1) intact.

- [ ] **Step 4: Test**

Run: `npx tsc --noEmit -p tsconfig.json && npm test 2>&1 | tail -5`. Manually sanity-check `webview-provider.ts` line count: should drop by ~200-300 lines.

- [ ] **Step 5: Commit**

```bash
git add src/webview/chat-handler.ts src/webview-provider.ts
git commit -m "refactor(webview): extract ChatHandler from webview-provider"
```

---

### Task D2: Extract `KeyManagementHandler`

- **Owner-files:** `src/webview/key-management-handler.ts` (new), `src/webview-provider.ts`
- **Read-only refs:** `src/key-management.ts`, `src/messages.ts`
- **Depends on:** D1
- **Parallel-safe with:** E1

**Why:** The provider has ~10 methods around key state: `setServiceKey`, `clearServiceKey`, `testServiceKey`, `sendAllKeyStatuses`, `buildKeyStatusForService`, the persisted validation snapshot reads, etc. Together ~250 lines.

- [ ] **Step 1: Inventory**

Run `Grep "setServiceKey\\|clearServiceKey\\|testServiceKey\\|sendAllKeyStatuses\\|PersistedKeyValidationSnapshot" src/webview-provider.ts -n`. Record line ranges.

- [ ] **Step 2: Build `src/webview/key-management-handler.ts`** with a `KeyManagementHandler` class that takes a `KeyManagementHandlerContext` (`postMessage`, `getSecrets`, `getGlobalState`, `getOutputChannel`). Move methods + state.

- [ ] **Step 3: Delegate from provider; instantiate in constructor.

- [ ] **Step 4: Test, commit**

```bash
git add src/webview/key-management-handler.ts src/webview-provider.ts
git commit -m "refactor(webview): extract KeyManagementHandler from webview-provider"
```

---

### Task D3: Extract `SimulationHandler`

- **Owner-files:** `src/webview/simulation-handler.ts` (new), `src/webview-provider.ts`
- **Read-only refs:** `src/simulator/index.ts`, `src/simulator/types.ts`
- **Depends on:** D2
- **Parallel-safe with:** E1

**Why:** `handleRunSimulation` + scenario persistence + the single-flight queue added in C5 form ~80 lines.

- [ ] Inventory, build `SimulationHandler` with a `SimulationHandlerContext`, move `handleRunSimulation` and `persistScenarios` + queue, delegate, test, commit:

```bash
git commit -m "refactor(webview): extract SimulationHandler from webview-provider"
```

---

### Task D4: Extract `ScanPublishingHandler`

- **Owner-files:** `src/webview/scan-publishing-handler.ts` (new), `src/webview-provider.ts`
- **Read-only refs:** `src/api-client.ts`, `src/scan-results.ts`, `src/intelligence/builder.ts`
- **Depends on:** D3
- **Parallel-safe with:** E1

**Why:** The scan-result merge / remote-submit / local-only publish flow (`mergeRemoteAndLocalEndpoints`, `publishLocalOnlyResults`, `handleStartScan`) is ~300 lines.

- [ ] Inventory, build `ScanPublishingHandler`, move methods, delegate, test, commit:

```bash
git commit -m "refactor(webview): extract ScanPublishingHandler from webview-provider"
```

**After D4 commits:** `webview-provider.ts` should be under 1000 lines (target: ~800). Verify with `wc -l src/webview-provider.ts`.

---

# Phase E — Parallel with C and D (1 task)

### Task E1: Replace local `estimateLocalMonthlyCost` in `scan-results.ts` with the canonical import

- **Owner-files:** `src/scan-results.ts`
- **Read-only refs:** `src/intelligence/cost-utils.ts`
- **Depends on:** A9
- **Parallel-safe with:** C1, C2, C3, C4, C5, C6, D1, D2, D3, D4

**Why:** `src/scan-results.ts:133-157` has a third copy of `estimateLocalMonthlyCost` that returns `number` and silently falls back to `DEFAULT_PER_CALL_COST = 0.0001`. C2 already removed the webview copy; this task removes the scan-results copy so `cost-utils.ts` becomes the only definition in the repo.

- [ ] **Step 1: Delete the local duplicates**

In `src/scan-results.ts`:
- Delete the `LOCAL_PRICING` constant.
- Delete `DEFAULT_PER_CALL_COST`.
- Delete the local `estimateLocalMonthlyCost` (lines 133-157).
- Remove the `import { lookupMethod }` line if it is no longer used (`Grep "lookupMethod" src/scan-results.ts`).

- [ ] **Step 2: Add the canonical import**

```typescript
import { estimateLocalMonthlyCost } from "./intelligence/cost-utils";
```

- [ ] **Step 3: Adapt call sites for `number | null`**

Run inside the file: `Grep "estimateLocalMonthlyCost\\(" src/scan-results.ts -n`. For each call, append `?? 0` when the downstream code (e.g., `chooseSeverity`) expects a `number`. When the downstream handles null already, leave the union intact.

- [ ] **Step 4: Type-check and test**

Run: `npx tsc --noEmit -p tsconfig.json && npm test 2>&1 | tail -5` → green.

- [ ] **Step 5: Commit**

```bash
git add src/scan-results.ts
git commit -m "refactor(scan-results): use cost-utils.estimateLocalMonthlyCost; remove duplicate"
```

---

# Phase F — Dependency Refreshes and Final Tests (3 tasks)

After Phases A-E land and `npm test` is green, fan out F1-F3 in parallel. F1 and F2 both touch `package.json`, but they edit disjoint lines (F1 → `devDependencies.esbuild`, F2 → `dependencies.openai`). Conservative orchestrators may still serialize them — that is fine.

---

### Task F1: Upgrade `esbuild` past CVE GHSA-67mh-4wv8-2f99

- **Owner-files:** `package.json`, `package-lock.json`
- **Read-only refs:** `esbuild.mjs`
- **Depends on:** all of A, B, C, D, E
- **Parallel-safe with:** F2, F3

**Why:** esbuild ≤0.24.2 has a moderate dev-server vulnerability (the issue does not ship in our VSIX but still surfaces in `npm audit`).

- [ ] **Step 1: Bump the pin**

In `package.json`, change `"esbuild": "^0.24.0"` to `"esbuild": "^0.28.0"`.

- [ ] **Step 2: Refresh the lockfile**

Run: `npm install`. Inspect the diff of `package-lock.json` and confirm only esbuild + its transitives changed.

- [ ] **Step 3: Rebuild and run full suite**

Run:
```bash
npm run build:ext 2>&1 | tail -10
npm test 2>&1 | tail -10
```
Expected: extension builds; all tests pass.

- [ ] **Step 4: Confirm CVE is gone**

Run: `npm audit --json 2>&1 | tail -40`. The GHSA-67mh-4wv8-2f99 advisory should no longer appear.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore(deps): upgrade esbuild to ^0.28 (fixes GHSA-67mh-4wv8-2f99)"
```

---

### Task F2: Upgrade `openai` SDK

- **Owner-files:** `package.json`, `package-lock.json`, possibly `src/chat/providers/openai.ts`, `src/webview-provider.ts` (only if the SDK shape changed)
- **Read-only refs:** `src/chat/providers/openai.ts`
- **Depends on:** all of A, B, C, D, E
- **Parallel-safe with:** F1, F3

**Why:** `openai` is pinned at `^4.73.0`; latest stable is in the 6.x line. v4 is approaching EOL. The chat adapter is the only consumer; AI review uses the same client.

- [ ] **Step 1: Read the current openai usage**

Run: `Grep "from \"openai\"" src/ --include="*.ts" -n`. Note every import — chances are it is just `import OpenAI from "openai";` in the adapter and AI-review code.

- [ ] **Step 2: Bump the pin to latest v4 (NOT v6) as a first step**

Why v4 first: v6 has breaking changes in streaming shape. Bumping to the latest 4.x patches CVEs without forcing a behavior change. Reserve v6 for a separate plan after we have integration tests for the chat adapter.

In `package.json`, change `"openai": "^4.73.0"` to `"openai": "^4.104.0"`.

- [ ] **Step 3: `npm install`, build, test**

```bash
npm install
npm run build:ext 2>&1 | tail -10
npm test 2>&1 | tail -10
```
Expected: green.

- [ ] **Step 4: Manual smoke (deferred — note in commit)**

Manual: open the Extension Development Host, run an AI review, send a chat message with the `openai` provider. Confirm both succeed. (This step is manual because we have no integration test that hits a real OpenAI endpoint.)

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore(deps): upgrade openai to ^4.104 (latest in v4 line)"
```

---

### Task F3: Activation smoke test for `src/extension.ts`

- **Owner-files:** `src/test/extension-activation.test.ts` (new), `package.json`
- **Read-only refs:** `src/extension.ts`
- **Depends on:** all of A, B, C, D, E
- **Parallel-safe with:** F1, F2

**Why:** `extension.ts` is the activation entry and has zero coverage. A real `@vscode/test-electron` harness is heavy; for now a lightweight test that imports the module and asserts its exports + that `deactivate()` runs cleanly is enough to catch the most common regressions (typos, missing exports, top-level throws).

- [ ] **Step 1: Write a lightweight import-and-deactivate test**

Create `src/test/extension-activation.test.ts`:

```typescript
import assert from "node:assert/strict";
import * as ext from "../extension";

async function runTests() {
  // The module exports activate and deactivate
  assert.equal(typeof ext.activate, "function", "activate must be exported");
  assert.equal(typeof ext.deactivate, "function", "deactivate must be exported");

  // deactivate() can run idempotently without activate() ever firing
  ext.deactivate();
  ext.deactivate();

  console.log("PASS extension-activation");
}

runTests().catch((e) => { console.error(e); process.exit(1); });
```

**Note:** the module imports `vscode`. To make this test runnable without a VSCode runtime, we already use `tsconfig.scanner-tests.json` which provides a `vscode` stub for tests (verify by reading the file). If the stub is missing, this task must add a minimal stub at `src/test/__mocks__/vscode.ts` and configure `paths` in `tsconfig.scanner-tests.json` to resolve `vscode` to the stub. Keep the stub to the surface `extension.ts` touches: `commands`, `window`, `workspace`, `OutputChannel`, `Disposable`, etc.

- [ ] **Step 2: Wire and run**

Append `&& node dist-test/test/extension-activation.test.js` to `test:scanner`.
Run: `npx tsc -p tsconfig.scanner-tests.json && node dist-test/test/extension-activation.test.js`
Expected: `PASS extension-activation`.

- [ ] **Step 3: Commit**

```bash
git add src/test/extension-activation.test.ts src/test/__mocks__/vscode.ts package.json tsconfig.scanner-tests.json
git commit -m "test(extension): smoke test for activate/deactivate exports"
```

---

# Self-Review

**Spec coverage** — every audit finding maps to a task:

| Audit finding | Severity | Task |
|---|---|---|
| webview listener disposal | P0 | C1 |
| handleMessage no .catch / no default | P0 | C1 |
| compression.ts sync read | P0 | B2 |
| god file webview-provider.ts | P1 | D1–D4 |
| estimateLocalMonthlyCost duplicated | P1 | C2 + E1 (canonical in A9 tests) |
| LOCAL_PRICING duplicated | P1 | C2 + E1 |
| switch no default | P1 | C1 |
| esbuild ≤0.24.2 CVE | P1 | F1 |
| fire-and-forget unawaited | P1 | C1 |
| swallowed errors in debug-export | P1 | C6 |
| no CI | P2 | A1 |
| zero coverage api-client | P2 | A6 |
| zero coverage key-management | P2 | A7 |
| zero coverage extension.ts | P2 | F3 |
| zero coverage webview-provider | P2 | C1 (dispatch test) |
| tsconfig missing flags | P2 | A2 |
| esbuild sourcemaps in prod | P2 | A3 |
| openai SDK outdated | P2 | F2 |
| AST WASM fallback untested | P2 | A8 |
| scenario persistence race | P2 | C5 |
| setInterval double-activate | P3 | B1 |
| console.log in webview-provider | P3 | C4 |
| WebviewMessage exhaustiveness | P3 | C1 (default case `never` check) |
| CLAUDE.md drift (local-server.ts) | P3 | A5 |
| build-vsix.sh naming mismatch | P3 | A4 |
| extension.ts redundant console.error | P3 | B1 |

**Placeholder scan:** every code block is concrete; every `Step` carries either a copy-paste edit, a specific shell command with expected output, or an inventory grep that fully replaces guessing.

**Type consistency:**
- `dispatchWebviewMessage`, `WebviewMessageHandlers`, `DispatchResult` defined in C1, reused only in C1.
- `estimateLocalMonthlyCost: (provider, callsPerDay, methodSignature?) => number | null` is the canonical signature; C2 and E1 wrap with `?? 0` at call sites that need a number.
- `compressClusters: (...) => Promise<CompressedCluster[]>` after B2; awaited in C3 (webview + cli).
- `persistScenarios(next: SavedScenario[]): Promise<void>` introduced in C5, called from C5 and D3.

**Out of scope (deliberate):**
- OpenAI SDK v6 migration (deferred — needs integration tests first; F2 only bumps inside v4).
- Full `@vscode/test-electron` harness (deferred — F3 is the minimum viable activation test).
- Dashboard React audit (separate UI plan).
- Webview UI audit (separate UI plan).

---

# Execution Handoff

Plan complete. Two execution options:

1. **Subagent-Driven (recommended for this plan)** — fan out Phase A as 9 parallel subagents; Phase B as 2 parallel; serial through C and D; E1 in parallel with C/D; F1-F3 final parallel batch. Review between phases.
2. **Inline Execution** — walk the tasks in this session top to bottom with checkpoint commits.
