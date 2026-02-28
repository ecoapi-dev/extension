# ECO - API Usage Analyzer

REST API for analyzing codebase API call patterns, estimating costs, and generating optimization suggestions.

## Tech Stack

- **Cloudflare Workers** — hosting and serverless runtime
- **Hono** — web framework (Workers-compatible, Express-like)
- **Cloudflare D1** — SQLite database (persistent)
- **TypeScript** — strict mode

## Setup

1. `cd api && npm install`
2. Create D1 database: `npx wrangler d1 create eco-db`
3. Paste the returned `database_id` into `api/wrangler.toml`
4. Create KV namespace: `npx wrangler kv namespace create rate-limit`
5. Paste the returned `id` and `preview_id` into `api/wrangler.toml` under `[[kv_namespaces]]`
6. Apply migrations: `npm run db:migrate:local`
7. Start dev server: `npm run dev`

## Commands

Run from the `api/` directory:

| Command | Description |
|---------|-------------|
| `npm run dev` | Start local dev server (`wrangler dev`) |
| `npm run typecheck` | TypeScript type check (no emit) |
| `npm run deploy` | Deploy to Cloudflare Workers |
| `npm run db:migrate:local` | Apply D1 migrations locally |
| `npm run db:migrate:remote` | Apply D1 migrations to production |

## Project Structure

```
api/
  src/
    index.ts            # Workers entry point (Hono app, export default)
    env.ts              # Shared Env/Variables/AppContext types
    config/
      pricing.ts        # Provider pricing & keyword detection
    middleware/         # Hono middleware (cors, logging, content-type, error handler)
    models/
      types.ts          # TypeScript domain types
    routes/             # Route handlers (health, projects, providers)
    services/
      analysis-service.ts    # Core analysis engine (pure, sync)
      project-service.ts     # All CRUD via D1 (async)
      provider-service.ts    # Provider config lookups
      validation-service.ts  # Input validation
    utils/              # AppError, pagination, sort helpers
  migrations/
    0001_schema.sql     # D1 table definitions
    0002_seed.sql       # Demo project seed data
  wrangler.toml
  package.json
  tsconfig.json
eco-extension/          # VSCode extension (see eco-extension/)
```

## Architecture Notes

- The D1 database binding (`DB`) flows through `c.env.DB` — passed as the first argument to every service function
- Services are stateless async functions; no module-level state
- JSON columns store arrays/objects (files, callSites, graph, summary, etc.)
- `deleteProject` manually cascades: deletes suggestions → endpoints → scans → project in a `db.batch()`
- `analyzeApiCalls` in `analysis-service.ts` is pure synchronous logic — no DB access
- `crypto.randomUUID()` is used as a global (no import needed in Workers runtime)

## Rate Limiting & Payload Limits

- **Payload cap**: `apiCalls` arrays are capped at 2000 items — enforced in `validation-service.ts` for both `POST /projects` and `POST /projects/:id/scans`. Returns 422 if exceeded.
- **Scan rate limit**: `POST /projects/:id/scans` is limited to **10 scans per 60 seconds per project**, enforced via a Cloudflare KV counter in `middleware/rate-limit.ts`. Returns 429 if exceeded.
- KV binding name: `KV` (configured in `wrangler.toml` under `[[kv_namespaces]]`)

## D1 Schema

Tables: `projects`, `scans`, `endpoints`, `suggestions`
- See [api/migrations/0001_schema.sql](api/migrations/0001_schema.sql) for full schema
- Numeric costs stored as `REAL`; arrays/objects stored as JSON `TEXT`
