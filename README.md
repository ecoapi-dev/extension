# ECO - API Usage Analyzer

VSCode extension that scans your workspace for API call patterns, estimates costs, and generates optimization suggestions — all locally, no remote server required.

## Why This Exists

Developers often ship API-heavy features without visibility into:
- Monthly API spend risk
- Redundant or cacheable request patterns
- Rate-limit and N+1 hotspots

ECO turns parsed API call data into actionable diagnostics:
- Cost analytics
- Endpoint-level risk/status
- Optimization suggestions with estimated savings
- Graph data for dependency visualization
- **Sustainability stats** — electricity (kWh), water (L), and CO2 (g) footprint estimated from API call volume, with AI vs non-AI breakdown

## Tech Stack

- **TypeScript** — extension backend
- **React 18** — sidebar webview UI
- **Vite** + **esbuild** — bundlers
- **TanStack Query v5**, **Tailwind CSS v4**, **D3.js**, **Radix UI** — dashboard UI
- **OpenAI SDK** — optional AI review (`gpt-4.1-mini` default)

## Project Structure

```
src/                        # Extension backend
  extension.ts              # Entry point
  api-client.ts             # HTTP client for remote ECO API
  local-server.ts           # Embedded server (dashboard + local analysis)
  webview-provider.ts       # Sidebar webview provider
  messages.ts               # IPC message types
  analysis/types.ts
  chat/prompts.ts           # AI prompt templates
  scanner/
    patterns.ts             # API call detection regex
    workspace-scanner.ts    # Workspace file scanner
webview/                    # React sidebar UI
  src/
    App.tsx
    vscode.ts               # VSCode API bridge
    components/
      LandingPage.tsx
      ScanningPage.tsx
      ResultsPage.tsx
      ChatPage.tsx
dashboard/                  # Full React dashboard (built into dashboard-dist/)
  src/
    pages/                  # Dashboard, Endpoints, Graph, Suggestions
    lib/                    # API client, TanStack Query hooks, types
dashboard-dist/             # Built dashboard (generated — do not edit)
scripts/
  build-vsix.sh             # Build & package as .vsix (run in bash)
  start-extension.sh        # Full dev setup (F5 workflow)
```

## Install from .vsix (recommended)

Run in a **bash terminal** (Git Bash / WSL on Windows — not PowerShell or CMD):

```bash
bash scripts/build-vsix.sh
```

Then install the generated file:

```bash
code --install-extension eco-api-analyzer-0.1.0.vsix
# or: Ctrl+Shift+P → "Extensions: Install from VSIX..."
```

Reload the window when prompted, then click the **ECO leaf icon** in the Activity Bar.

## Quick Start (Dev)

For developing on the extension itself:

```bash
bash scripts/start-extension.sh
```

Then press **F5** in VSCode to launch the Extension Development Host.

If deps are already installed, rebuild and repackage with:

```bash
cd extension
npm run build && npm run package
```

## API

The live ECO API is available at **https://api.ecoapi.dev** — no setup required.

Full API documentation: **https://ecoapi.dev**

---

Licensed under the [GNU Affero General Public License v3.0](LICENSE) © 2026 Andres Lopez, Aslan Wang, Donggyu Yoon.
