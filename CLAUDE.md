# ECO - API Usage Analyzer (VSCode Extension)

VSCode extension that scans your workspace for API call patterns, estimates costs, shows diagnostics, and opens a full dashboard locally. Optional AI review via OpenAI.

## Tech Stack

- **TypeScript** — extension backend (strict mode)
- **esbuild** — bundler for extension and webview
- **React 18** — sidebar webview UI
- **Vite** — dashboard bundler
- **OpenAI SDK** — AI review (optional, `gpt-4.1-mini` default)

## Project Structure

```
src/
  extension.ts            # Extension entry point
  api-client.ts           # HTTP client for remote ECO API
  local-server.ts         # Embedded HTTP server (serves dashboard + proxies local analysis)
  webview-provider.ts     # Sidebar webview provider
  messages.ts             # IPC message types (extension ↔ webview)
  analysis/
    types.ts              # Analysis type definitions
  chat/
    prompts.ts            # AI prompt templates
  scanner/
    patterns.ts           # API call detection regex patterns
    workspace-scanner.ts  # Workspace file scanner
  simulator/              # Cost Simulator computation layer
    types.ts              # SimulatorInput, SimulatorResult, SavedScenario, etc.
    engine.ts             # Pure runSimulation() function (no side effects)
    static-source.ts      # StaticDataSource adapter (EndpointRecord[] → SimulatorDataSource)
    index.ts              # Barrel re-export
webview/                  # React sidebar UI
  src/
    App.tsx
    main.tsx
    types.ts
    vscode.ts             # VSCode API bridge
    components/
      LandingPage.tsx
      ScanningPage.tsx
      ResultsPage.tsx
      ChatPage.tsx
      SimulatePage.tsx    # Cost Simulator tab (Simulate tab in results)
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
    layout/
    lib/
      api.ts              # REST client
      queries.ts          # TanStack Query hooks
      types.ts
    pages/
      Dashboard.tsx
      Endpoints.tsx
      Graph.tsx
      Suggestions.tsx
      Simulator.tsx       # Cost Simulator page with scenario management
    styles/
  vite.config.ts
  package.json
dashboard-dist/           # Built dashboard (output of npm run build:dashboard)
scripts/
  start-extension.sh      # Full dev setup (install + build + open VSCode)
esbuild.mjs               # esbuild config for extension + webview
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
# → outputs eco-api-analyzer-*.vsix in extension/

# Install
code --install-extension eco-api-analyzer-*.vsix
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

- The extension embeds a local HTTP server (`local-server.ts`) that serves the built dashboard and handles analysis requests without any remote API
- Webview ↔ extension IPC uses typed messages defined in `messages.ts`
- The workspace scanner (`workspace-scanner.ts`) uses regex patterns from `patterns.ts` to detect API calls across supported file types
- AI review is optional: prompts live in `chat/prompts.ts`, calls go through `openai` SDK; key is stored in VSCode SecretStorage
- `dashboard-dist/` must exist (built) before the extension can serve the dashboard — `build:dashboard` handles this

### Cost Simulator

The Cost Simulator (`src/simulator/`) is a pure computation layer (no Node/browser/VSCode deps) that projects API costs at scale:

- **Engine** (`engine.ts`): `runSimulation(dataSource, input)` scales each endpoint proportionally, applies ±30% uncertainty range, groups by provider
- **Data source abstraction** (`SimulatorDataSource` interface): allows static scan data (v1) or future live telemetry to be swapped in without UI changes
- **VS Code sidebar**: "Simulate" tab in `ResultsPage`, rendered by `SimulatePage.tsx`. Sends `runSimulation` IPC message; receives `simulationResult`
- **Dashboard**: `/simulator` route with full scenario management (save, compare 2, export CSV). Simulator API routes on local server: `POST /api/projects/local/simulator/run`, `GET/POST/DELETE /api/projects/local/simulator/scenarios`, `GET /api/projects/local/simulator/scenarios/export`
- **Scenario persistence**: Saved scenarios stored in `vscode.globalState` under `eco.simulatorScenarios`, passed to local server via `onScenariosChanged` callback

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
