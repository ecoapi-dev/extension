# ReCost - API Usage Analyzer (VSCode Extension)

VSCode extension that scans your workspace for API call patterns, estimates costs, shows diagnostics, and opens a full dashboard locally. Multi-provider AI chat and optional AI code review.

## Tech Stack

- **TypeScript** — extension backend (strict mode)
- **esbuild** — bundler for extension and webview
- **React 18** — sidebar webview UI
- **Vite** — dashboard bundler
- **Multi-provider AI chat** — ReCost AI (free, default), OpenAI, Anthropic, Gemini, xAI, Cohere, Mistral, Perplexity
- **OpenAI SDK** — AI review (optional, `gpt-4.1-mini` default)
- **web-tree-sitter** — AST parsing for JS/TS/Python (WASM, loaded at runtime)

## Project Structure

```
src/
  extension.ts            # Extension entry point
  api-client.ts           # HTTP client for remote ReCost API (rc- prefix key validation)
  webview-provider.ts     # Sidebar webview provider (IPC handling, local pricing table for 40+ providers, cost estimation algorithm)
  messages.ts             # IPC message types (extension ↔ webview)
  key-management.ts       # Key service registry, validation snapshots, KeyServiceDescriptor; manages recost + all chat provider keys
  output.ts               # Lazy OutputChannel singleton ("ReCost Status")
  scan-results.ts         # Post-scan result builder: scope/provider enrichment, local pricing, filters unknown providers before remote submit
  workspace-file-access.ts # Safe workspace path resolver — guards against path traversal before file reads
  analysis/
    types.ts              # Analysis type definitions
  cli/
    scan.ts               # CLI scan runner — orchestrates workspace scan, remote submit, intelligence pipeline, and formatted output
    filesystem-adapter.ts # ScanFileAccess adapter backed by the real filesystem (vs the VSCode workspace API)
  ast/
    parser-loader.ts      # web-tree-sitter WASM loader (resolves from dist/../assets/parsers/)
    ast-scanner.ts        # AST-based API call scanner (JS/TS/Python)
    call-visitor.ts       # AST call expression visitor — walks tree, emits raw call sites
    frequency-analyzer.ts # Classifies call frequency: single, bounded-loop, unbounded-loop, polling, parallel, conditional, cache-guarded
    cross-file-resolver.ts # Resolves API calls through helper functions back to their origin file
    import-resolver.ts    # Resolves import paths for cross-file tracing
    waste/
      batch-detector.ts      # AST-based batch and N+1 waste detector
      cache-detector.ts      # AST-based cache guard waste detector
      concurrency-detector.ts # AST-based concurrency/parallel waste detector
  chat/
    prompts.ts            # AI prompt templates
    types.ts              # Shared chat types
    provider-registry.ts  # Provider registry & auth resolution (env var → SecretStorage fallback)
    index.ts              # executeChat() dispatcher
    errors.ts             # ChatAdapterError
    providers/            # Per-provider adapters (recost, openai, anthropic, gemini, xai, cohere, mistral, perplexity)
  scanner/
    patterns.ts           # API call detection regex patterns (fallback/augment to AST)
    patterns/             # 16 provider-specific pattern scanners (Firebase, GraphQL, OpenAI, Stripe, Anthropic, Bedrock, etc.) + registry.ts, types.ts, utils.ts
    core-scanner.ts       # Core single-file scanner (coordinates AST + regex passes)
    workspace-scanner.ts  # Workspace file scanner (orchestrates core-scanner across files)
    file-discovery.ts     # Workspace file discovery and glob filtering
    path-excludes.ts      # Default exclude path patterns
    endpoint-classification.ts  # Classifies endpoints as internal/external, detects 50+ provider hosts
    local-waste-detector.ts     # Detects waste patterns using AST signals (N+1, unbounded loops, polling without backoff, missing cache guards, unbatched parallel)
    python-waste-detector.ts    # Python-specific waste detection
    fingerprints/               # Per-method pricing fingerprints — JSON data files per provider + index.ts, registry.ts, types.ts
  simulator/              # Cost Simulator computation layer
    types.ts              # SimulatorInput, SimulatorResult, SavedScenario, scale presets (1K–100K)
    engine.ts             # Pure runSimulation() — frequency-class multipliers, free endpoint zeroing, dynamic confidence
    static-source.ts      # StaticDataSource adapter (EndpointRecord[] → SimulatorDataSource, passes frequencyClass + costModel)
    index.ts              # Barrel re-export
  intelligence/           # Intelligence layer — graph model of a scanned repo
    types.ts              # Shared interface contracts (FileNode, ApiCallNode, FindingNode, ProviderNode, RepoIntelligenceSnapshot, ScoredSnapshot, ReviewCluster, CompressedCluster, ExportedContext, etc.). Do NOT change without team sync.
    builder.ts            # buildSnapshot() — constructs RepoIntelligenceSnapshot from apiCalls + findings
    scorer.ts             # scoreSnapshot() — produces ScoredSnapshot with per-file cost/reliability/coverage scores
    clusters.ts           # buildReviewClusters() — groups ScoredFiles into ReviewCluster batches for AI review
    compression.ts        # compressClusters() — token-budget-aware compression of clusters into CompressedCluster (≤4000 tokens)
    export.ts             # buildExportContext() / formatAsJSON() / formatAsMarkdown() — structured export for CLI and AI context
    cost-utils.ts         # estimateLocalMonthlyCost() — shared local cost estimation (no remote API)
    file-signals.ts       # isTestLikeFilePath(), isDeprioritizedContextFilePath(), isAnalysisToolingFilePath() predicates
    finding-dedupe.ts     # dedupeFindings() — deduplicates FindingNode by normalized description + evidence
    path-utils.ts         # normalizeRepoPath() — cross-platform path normalization
    provider-normalization.ts  # normalizeProviderId(), filterRealProviders(), collectRealProviders() — canonical provider aliases
    mocks/
      mockSnapshot.ts     # Shared RepoIntelligenceSnapshot mock (5 files, 10 API calls, 6 findings, 3 providers) for tests and local dev
webview/                  # React sidebar UI
  src/
    App.tsx               # 3 screens: landing → scanning → results
    main.tsx
    types.ts
    vscode.ts             # VSCode API bridge
    components/
      LandingPage.tsx
      ScanningPage.tsx
      ResultsPage.tsx     # Main results view with Findings (Issues/Endpoints subtabs), Chat, Simulate tabs
      ChatPage.tsx        # AI chat tab — key-missing warning shown inline as chat bubble
      SimulatePage.tsx    # Cost Simulator tab
      KeysPage.tsx        # API key / provider key management tab
      Markdown.tsx
      LeafIcon.tsx
    styles/
      index.css
dashboard/                # React SPA (full dashboard)
  src/
    App.tsx               # Root component with routing
    theme-context.tsx
    themes.ts
    components/
      ScenarioCompare.tsx # Side-by-side scenario comparison modal
      Select.tsx / animated-tree.tsx / particles.tsx
    layout/
    lib/
      api.ts              # REST client
      queries.ts          # TanStack Query hooks
      types.ts
      format.ts           # formatCost(), formatCostRange() shared utilities
    pages/
      Dashboard.tsx
      Endpoints.tsx       # Badge tooltips for costModel + frequencyClass
      Suggestions.tsx
      Simulator.tsx       # Cost Simulator page with scenario management
      Graph.tsx           # API call graph visualization
    styles/
  vite.config.ts
  package.json
dashboard-dist/           # Built dashboard (output of npm run build:dashboard)
scripts/
  build-vsix.sh           # Build & package as .vsix (run in bash)
  start-extension.sh      # Full dev setup (install + build + open VSCode)
esbuild.mjs               # esbuild config for extension + webview; also copies web-tree-sitter into dist/node_modules/ at build time
package.json
tsconfig.json
```

## Commands

Run from the root (`extension/`) directory:

| Command | Description |
|---------|-------------|
| `npm run build` | Full build: dashboard + webview + extension |
| `npm run build:ext` | Build extension backend only |
| `npm run build:webview` | Build React sidebar webview |
| `npm run build:dashboard` | Build dashboard and copy to `dashboard-dist/` |
| `npm run watch:ext` | Watch extension backend |
| `npm run watch:webview` | Watch webview |
| `npm run package` | Package as `.vsix` |

## Local Install (VSIX)

Use the build script — it installs all deps, builds everything, and packages the `.vsix`.
Confirmed compatible with **macOS**, **Windows** (Git Bash / WSL), and **Linux**. The setup scripts require bash — run in a bash terminal, not PowerShell or CMD:

```bash
bash scripts/build-vsix.sh
# → outputs recost-api-analyzer-*.vsix in extension/

# Install
code --install-extension recost-api-analyzer-*.vsix
# or: Ctrl+Shift+P → "Extensions: Install from VSIX..."
```

One-liner after dependencies are already installed:
```bash
npm run build && npm run package
```

## Dev Setup

Run in a bash terminal (Git Bash / WSL on Windows):

```bash
bash scripts/start-extension.sh
```

Then press **F5** in VSCode to launch the Extension Development Host.

## Architecture Notes

- All "local" analysis (sustainability footprint, cost-by-provider, simulator runs, scenario CRUD) is computed on the extension host and delivered to the webview through typed IPC messages — no embedded HTTP server, no localhost ports
- Webview ↔ extension IPC uses typed messages defined in `messages.ts`
- The workspace scanner (`workspace-scanner.ts`) orchestrates the AST scanner (`src/ast/`) and regex patterns (`patterns/`) to detect API calls across supported file types
- AST scanning produces rich per-endpoint metadata: `frequencyClass`, `costModel`, `batchCapable`, `cacheCapable`, `streaming`, `isMiddleware`, `crossFileOrigins`, `methodSignature`
- `endpoint-classification.ts` classifies detected endpoints as internal/external and identifies 50+ provider hosts (GitHub, Stripe, AWS, Google, Twilio, etc.)
- `local-waste-detector.ts` detects waste patterns using AST signals (N+1, unbounded loops, polling without backoff, missing cache guards, unbatched parallel calls)
- AI review is optional: prompts live in `chat/prompts.ts`, calls go through `openai` SDK; key is stored in VSCode SecretStorage
- AI review validation (`webview-provider.ts`) checks findings against allowed types, severity, file existence, and confidence threshold
- `dashboard-dist/` must exist (built) before the extension can load the dashboard into the webview — `build:dashboard` handles this

### AST Parsing Engine

The AST layer (`src/ast/`) uses web-tree-sitter (WASM) to parse JS/TS/Python source files:

- **`parser-loader.ts`**: Loads WASM grammars from `assets/parsers/` relative to `dist/` (esbuild output). Path is `path.join(__dirname, "..", "assets", "parsers")`. Uses a lazy `require()` in a try/catch at module init — if `web-tree-sitter` is not resolvable the module does not crash; `_Parser`/`_Language` are null and `ensureInitialized()` throws, causing the scanner to fall back to regex patterns.
- **`ast-scanner.ts`** + **`call-visitor.ts`**: Walk the AST to find API call sites, emitting `EndpointRecord` with enriched fields
- **`frequency-analyzer.ts`**: Classifies each call site by surrounding AST context — loop types, timers, conditionals, cache guards
- **`cross-file-resolver.ts`**: Follows import chains to resolve helper function calls back to their original HTTP call site
- **`fingerprints/`**: Maps provider+method signatures to pricing models (`per_token`, `per_transaction`, `per_request`, `free`) and per-call cost estimates — data in JSON files per provider, loaded via `index.ts`/`registry.ts`

### Local-Only Data Flow

There is no embedded HTTP server. All "local" data (sustainability footprint, cost-by-provider, simulator runs, scenario CRUD) is computed on the extension host and delivered to the webview through typed IPC messages defined in `src/messages.ts`. Scenarios are persisted via `vscode.globalState` under `eco.simulatorScenarios`.

**SDK "local mode" (runtime telemetry) is not consumed by this extension.** The Node and Python middleware SDKs (`recost-dev/middleware-node`, `recost-dev/middleware-python`) ship a separate "local mode" transport that targets `ws://127.0.0.1:9847`. The extension does not host that server and intentionally will not — the IPC seam here is VS Code's webview-message channel, not localhost sockets. The SDKs are switching local-mode default to a file-based transport tracked in `recost-dev/middleware-node#37` and `recost-dev/middleware-python#38`; the extension is not a consumer of those files either.

### Auth / API Key System

Two separate key systems coexist:

**ReCost API key** (for scanning/remote API) — managed entirely in `extension.ts`:
- Stored in `context.secrets` under `"recost.apiKey"`
- Must begin with `rc-` prefix — validated before storing
- `validateApiKey()` in `api-client.ts` calls `GET /auth/me` with `Authorization: Bearer <key>`; returns the authenticated user on 200, throws on any non-2xx (including 401 invalid and 404)
- Status bar item reflects auth state with color: green (`testing.iconPassed`) when connected, `statusBarItem.warningForeground` when unreachable, no color when unconfigured; clicking it runs `recost.openKeys`
- `context.secrets.onDidChange` listener keeps status bar live without reload
- After key validation in the webview (`serviceId === "recost"`), `recost.keyOnline` context is also updated so the status bar stays in sync

**Chat provider keys** (OpenAI, Anthropic, etc.) — managed in `webview-provider.ts` + `chat/provider-registry.ts`:
- Stored per-provider in `context.secrets` under provider-specific keys (e.g., `eco.providerApiKey.openai`)
- Resolved via env var → SecretStorage fallback in `resolveProviderAuth()`
- Default provider: "recost" with "recost-ai" model (free, no key required, calls `https://api.recost.dev/chat`)
- When a non-recost provider key is missing, the chat UI shows an inline warning bubble (not a subtitle bar)

### Cost Estimation

- `webview-provider.ts` contains a hard-coded per-call cost table for 40+ providers (OpenAI, Anthropic, Stripe, AWS, Google, Twilio, SendGrid, etc.)
- Suggestion savings are estimated using base multipliers by type (redundancy 0.35, n_plus_one 0.3, cache 0.2, batch 0.18, default 0.12) × severity multiplier (high 1.0, medium 0.75, low 0.5)
- Suggestions can have `source: "local-rule"` (from local waste detection) or `source: "remote"` (from API)
- `getAllEndpoints()` and `getAllSuggestions()` in `api-client.ts` accept an explicit `rcApiKey` parameter that is passed through to `apiFetch()` — the key is no longer implicitly read from a module-level variable at call time
- Before submitting to the remote API, `scan-publishing-handler.ts` delegates to `build-remote-api-calls.ts:buildRemoteApiCalls()`. That helper applies `shouldSubmitRemote()` (in `scan-results.ts`), then resolves provider via `lookupHost()` on the normalized hostname. Calls where the provider is unresolved are **submitted** with the literal value `"unknown"` and the count is surfaced in a `scanNotification` IPC message at scan end — they are never silently dropped.

### Cost Simulator

The Cost Simulator (`src/simulator/`) is a pure computation layer (no Node/browser/VSCode deps) that projects API costs at scale:

- **Engine** (`engine.ts`): `runSimulation(dataSource, input)` scales each endpoint proportionally, applies ±30% uncertainty range, groups by provider
- **Frequency class multipliers**: When no user override is set, `frequencyClass` from the AST engine automatically amplifies call volume — `polling` = 8×, `unbounded-loop` = 10×, `parallel`/`bounded-loop` = 3×, `conditional` = 0.5×, `cache-guarded` = 0.1×
- **Free endpoints**: `costModel: "free"` endpoints are priced at $0 regardless of call volume
- **Dynamic confidence**: `"high"` if ≥70% of endpoints have AST-enriched data, `"medium"` if ≥30%, `"low"` otherwise
- **Input modes**: "user-centric" (DAU × calls/user) or "volume-centric" (total calls/day)
- **Scale presets**: 1K, 10K, 50K, 100K (both DAU and volume variants)
- **Data source abstraction** (`SimulatorDataSource` interface): `static-source.ts` maps `EndpointRecord[]` including `frequencyClass` and `costModel`
- **VS Code sidebar**: "Simulate" tab in `ResultsPage`, rendered by `SimulatePage.tsx`. Sends `runSimulation` IPC message; receives `simulationResult`
- **Dashboard**: `/simulator` route with full scenario management (save, compare 2, export CSV)
- **Scenario persistence**: Saved scenarios stored in `vscode.globalState` under `eco.simulatorScenarios` and synchronized to the webview via IPC messages

### Sidebar UI — Results Screen

The results screen (`ResultsPage.tsx`) has three top-level tabs: **Findings**, **Chat**, **Simulate**.

**Findings tab** is split into two subtabs:
- **Issues** — collapsible severity groups (high/medium/low), type filter dropdown, `SuggestionCard` shows type/source/confidence badges in header; description and savings only when expanded
- **Endpoints** — provider summary counts bar at top; grouped list by method (POST → GET → others) then by provider sub-dividers; URL + file:line per row; small red dot on right for at-risk endpoints with tooltip explaining the risk reason

**Chat tab**: key-missing warning appears as an inline bubble in the message stream, not as a subtitle bar.

### Cost numbers: heuristic vs authoritative

Two layers compute cost numbers and they are intentionally not reconciled:

- **Authoritative** (API + runtime middleware): fingerprint-based pricing + real telemetry. Source of truth, surfaced on the ReCost dashboard.
- **Heuristic** (extension static scan): `LOCAL_PRICING` in `src/intelligence/cost-utils.ts` + `FREQUENCY_CLASS_MULTIPLIERS` in `src/simulator/engine.ts`. Estimates for risk surfacing and scale projection inside the editor; never expected to match the API exactly.

Do not refactor the extension to consume API constants or sync `LOCAL_PRICING`. The webview's `EstimateDisclaimer` banner labels the numbers as estimates and points users at the dashboard for real cost.

## VSCode Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `eco.scanGlob` | `**/*.{ts,tsx,js,jsx,py,go,java,rb}` | Files to scan |
| `eco.scanIncludeGlobs` | `""` | Optional allowlist globs (comma-separated) |
| `eco.excludeGlob` | node_modules, dist, build, etc. | Files to exclude |
| `eco.aiReview.enabled` | `true` | Enable AI second-pass review |
| `eco.aiReview.minConfidence` | `0.7` | Min confidence for AI findings |
| `eco.aiReview.maxFiles` | `25` | Max files sent to AI review |
| `eco.aiReview.maxCharsPerFile` | `6000` | Max chars per file in AI context |
| `eco.aiReview.model` | `gpt-4.1-mini` | OpenAI model for AI review |

## Env Vars

| Env Var | Default | Description |
|---------|---------|-------------|
| `RECOST_DISABLE_AST` | unset | When set to `1`, disables web-tree-sitter AST scanning and uses regex-only detection. For testing the fallback path. |
