# EcoAPI

REST API for analyzing codebase API usage, estimating cost, detecting inefficiencies, and generating optimization suggestions.

## Why This Exists

Developers often ship API-heavy features without visibility into:
- Monthly API spend risk
- Redundant or cacheable request patterns
- Rate-limit and N+1 hotspots

EcoAPI turns parsed API call data into actionable diagnostics:
- Cost analytics
- Endpoint-level risk/status
- Optimization suggestions with estimated savings
- Graph data for dependency visualization
- **Sustainability stats** — electricity (kWh), water (L), and CO2 (g) footprint estimated from API call volume, with AI vs non-AI breakdown

## Tech Stack

### API
- **Cloudflare Workers** — serverless runtime
- **Hono** — web framework (Workers-compatible, Express-like)
- **Cloudflare D1** — SQLite database (persistent)
- **TypeScript** — strict mode

### Dashboard
- **React 18** + **React Router v7** — SPA with client-side routing
- **Vite** — build tool, deployed to Cloudflare Pages
- **TanStack Query v5** — data fetching and caching
- **Tailwind CSS v4** — utility-first styling
- **Recharts** — charts and cost visualizations

### VSCode Extension
- **TypeScript** extension backend
- **React** webview UI

## Project Structure

```
api/                        # Cloudflare Workers API
  src/
    index.ts                # Workers entry point (Hono app)
    env.ts                  # Shared Env/Variables/AppContext types
    config/
      pricing.ts            # Provider pricing & keyword detection
      sustainability.ts     # Energy/water/CO2 constants per provider
    middleware/
      cors.ts
      content-type.ts
      logging.ts
      request-id.ts
      error-handler.ts
    models/
      types.ts              # TypeScript domain types
    routes/
      health.ts
      projects.ts
      providers.ts
      chat.ts               # AI chat endpoint
    services/
      analysis-service.ts   # Core analysis engine (pure, sync)
      project-service.ts    # All CRUD via D1 (async)
      provider-service.ts   # Provider config lookups
      validation-service.ts # Input validation
    utils/
      app-error.ts
      pagination.ts
      sort.ts
  migrations/
    0001_schema.sql         # D1 table definitions
    0002_seed.sql           # Demo project seed data
  wrangler.toml
  package.json
  tsconfig.json
docpages/                   # React SPA (Cloudflare Pages)
  src/
    app/
      pages/                # Dashboard, Projects, Endpoints, Suggestions, Graph, AiChat, About
      layout/               # LandingLayout, Layout
      components/           # Landing page, animated tree, navbar, particles
    lib/
      api.ts                # REST client (BASE_URL → production API)
      queries.ts            # TanStack Query hooks
      types.ts              # TypeScript types matching API responses
    styles/                 # Tailwind, theme, fonts
  public/
    _redirects              # Cloudflare Pages SPA fallback (/* /index.html 200)
  vite.config.ts
  package.json
extension/                  # VSCode extension
  src/                      # Extension backend (TypeScript)
  webview/                  # React webview UI
```

## API Setup

```bash
cd api
npm install
npx wrangler d1 create eco-db          # create D1 database
# paste the returned database_id into api/wrangler.toml
npm run db:migrate:local                # apply schema + seed data
npm run dev                             # start local dev server
```

The app seeds one project + scan via migration for immediate exploration.

## API Commands

Run from the `api/` directory:

| Command | Description |
|---------|-------------|
| `npm run dev` | Start local dev server (`wrangler dev`) |
| `npm run deploy` | Deploy to Cloudflare Workers |
| `npm run typecheck` | TypeScript type check |
| `npm run db:migrate:local` | Apply D1 migrations locally |
| `npm run db:migrate:remote` | Apply D1 migrations to production |

## Docpages Setup

```bash
cd docpages
npm install
npm run dev        # local dev server (Vite)
npm run build      # production build → dist/
npm run preview    # preview the production build locally
```

### Deploy to Cloudflare Pages

In the Cloudflare Pages new project settings:

| Setting | Value |
|---------|-------|
| Root directory | `docpages` |
| Build command | `npm run build` |
| Build output directory | `dist` |
| Framework preset | None (or Vite) |

## VSCode Extension

The `extension/` folder contains a VSCode extension that runs ECO analysis directly inside your editor — no API server needed.

### What it does

- Scans your workspace for API call patterns (TS, JS, Python, Go, Java, Ruby)
- Shows results in a persistent **sidebar panel** (Activity Bar)
- Detects cost, N+1 patterns, missing caching, and unbatched calls
- AI chat via OpenAI to explain issues and suggest fixes

### Running in development (F5)

1. Open `extension/` as your workspace in VSCode:
   ```bash
   code extension/
   ```
2. Install dependencies:
   ```bash
   npm install
   cd webview && npm install && cd ..
   ```
3. Press **F5** — builds everything and launches an Extension Development Host window.
4. Click the **ECO leaf icon** in the Activity Bar to open the sidebar.

### Running from the .vsix

1. Open the Command Palette (`Ctrl+Shift+P`) → **"Extensions: Install from VSIX..."**
2. Select `extension/eco-api-analyzer-0.1.0.vsix`
3. Reload VSCode, then click the ECO icon in the Activity Bar.

To build a fresh `.vsix`:
```bash
cd extension && npm run package
```

### Dev workflow (watch mode)

Run both watchers in separate terminals, then **Ctrl+Shift+P → "Developer: Reload Window"** after changes:

```bash
# Terminal 1 — extension backend
cd extension && npm run watch:ext

# Terminal 2 — React webview
cd extension && npm run watch:webview
```

### Extension settings

| Setting | Default | Description |
|---------|---------|-------------|
| `eco.openaiApiKey` | `""` | OpenAI API key (prompted on first use if unset) |
| `eco.openaiModel` | `gpt-4o-mini` | OpenAI model for chat |
| `eco.scanGlob` | `**/*.{ts,tsx,js,jsx,py,go,java,rb}` | Files to include |
| `eco.excludeGlob` | `**/node_modules/**,...` | Files to exclude |

---

## Core API Behavior

- CORS headers on all responses
- `X-Request-Id` on every response
- JSON validation with `422` field-level errors
- `400` for malformed JSON or missing/invalid `Content-Type`
- Consistent error shape:

```json
{
  "error": {
    "code": "RESOURCE_NOT_FOUND",
    "message": "Project with id 'abc123' not found",
    "status": 404
  }
}
```

## Frequency Heuristics

| Input | Calls/day |
|-------|-----------|
| `per-request` | 1000 |
| `per-session` | 300 |
| `hourly` | 24 |
| `daily` | 1 |
| `weekly` | 1/7 |
| `N/day` | N |
| unknown | 100 |

## Pricing Table

Defined in `api/src/config/pricing.ts`:

| Provider | Cost per call (USD) |
|----------|-------------------|
| Stripe | $0.01 |
| OpenAI | $0.006 |
| Twilio | $0.0075 |
| SendGrid | $0.001 |
| AWS S3 | $0.0004 |
| Google Maps | $0.005 |
| Internal/fallback | $0.0001 |

## Example Scan Payload

```json
{
  "apiCalls": [
    {
      "file": "src/checkout.ts",
      "line": 47,
      "method": "GET",
      "url": "/api/users/:id",
      "library": "axios",
      "frequency": "per-request"
    }
  ]
}
```

## API Reference

### Health

```
GET /health
```

### Projects

```
POST   /projects
GET    /projects?page=1&limit=20&name=my-app&sort=created_at&order=desc
GET    /projects/:id
PATCH  /projects/:id
DELETE /projects/:id
```

### Scans

```
POST   /projects/:id/scans
GET    /projects/:id/scans?page=1&limit=20&sort=created_at&order=desc
GET    /projects/:id/scans/latest
GET    /projects/:id/scans/:scanId
```

### Endpoints

```
GET    /projects/:id/endpoints?provider=stripe&status=cacheable&method=GET&sort=monthly_cost&order=desc
GET    /projects/:id/endpoints/:endpointId
```

### Suggestions

```
GET    /projects/:id/suggestions?type=cache,batch&severity=high&sort=estimated_savings&order=desc
GET    /projects/:id/suggestions/:suggestionId
```

### Graph

```
GET    /projects/:id/graph?cluster_by=provider|file|cost
```

### Cost Analytics

```
GET    /projects/:id/cost
GET    /projects/:id/cost/by-provider?page=1&limit=20
GET    /projects/:id/cost/by-file?page=1&limit=20
```

### Sustainability

```
GET    /projects/:id/sustainability
```

Returns estimated environmental impact computed from the project's latest scan:

```json
{
  "data": {
    "electricity": { "dailyKwh": 4.5, "monthlyKwh": 135.0 },
    "water":       { "dailyLiters": 8.1, "monthlyLiters": 243.0 },
    "co2":         { "dailyGrams": 1737.0, "monthlyGrams": 52110.0 },
    "aiCallsPerDay": 1500,
    "totalCallsPerDay": 1501,
    "aiCallsPercentage": 99.9,
    "byProvider": [
      {
        "provider": "openai",
        "isAi": true,
        "callsPerDay": 1500,
        "dailyKwh": 4.5,
        "dailyWaterLiters": 8.1,
        "dailyCo2Grams": 1737.0
      }
    ]
  }
}
```

**Energy constants** (defined in `api/src/config/sustainability.ts`):

| Provider | kWh per call | AI? |
|----------|-------------|-----|
| OpenAI | 0.003 | Yes |
| Google Maps | 0.00003 | No |
| Stripe | 0.00002 | No |
| Twilio | 0.00001 | No |
| AWS S3 | 0.000008 | No |
| SendGrid / Internal | 0.000005 | No |

Water intensity: **1.8 L/kWh** (Microsoft Azure data center disclosures)
CO2 intensity: **386 g/kWh** (US EPA eGRID 2022 national average)

### Providers

```
GET    /providers?page=1&limit=20
GET    /providers/:name
```

### Chat

```
POST   /chat
```

## Response Formats

**Single resource:**
```json
{ "data": { "...": "resource" } }
```

**Paginated list:**
```json
{
  "data": [],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 47,
    "totalPages": 3,
    "hasNext": true,
    "hasPrev": false
  }
}
```

**DELETE:** `204 No Content`

## Example Workflow

```bash
# 1. Create project
curl -s -X POST https://your-worker.workers.dev/projects \
  -H "Content-Type: application/json" \
  -d '{"name":"my-app"}'

# 2. Trigger scan
curl -s -X POST https://your-worker.workers.dev/projects/{projectId}/scans \
  -H "Content-Type: application/json" \
  -d '{"apiCalls":[{"file":"src/main.ts","line":21,"method":"GET","url":"https://api.stripe.com/v1/customers","library":"fetch","frequency":"1200/day"}]}'

# 3. View endpoints
curl -s https://your-worker.workers.dev/projects/{projectId}/endpoints

# 4. View suggestions
curl -s https://your-worker.workers.dev/projects/{projectId}/suggestions

# 5. View cost breakdown
curl -s https://your-worker.workers.dev/projects/{projectId}/cost/by-provider

# 6. View sustainability stats
curl -s https://your-worker.workers.dev/projects/{projectId}/sustainability
```
