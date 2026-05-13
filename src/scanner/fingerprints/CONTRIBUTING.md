# Contributing to the Fingerprint Registry

The fingerprint registry is the single source of truth for provider data in the ReCost scanner: SDK method patterns, HTTP endpoints, cost models, pricing, and hostname mappings. All of this data lives in per-provider JSON files — no code changes are needed to add a new provider.

---

## Quick Start — Adding a New Provider

### 1. Create the JSON file

Create `src/scanner/fingerprints/{provider-id}.json`. Use lowercase kebab-case for the filename, matching the `provider` field inside (e.g., `sendgrid.json` for `"provider": "sendgrid"`).

### 2. Fill in the schema

```json
{
  "schemaVersion": "1.0.0",
  "provider": "sendgrid",
  "displayName": "SendGrid",
  "languages": ["javascript", "typescript", "python"],
  "packages": ["@sendgrid/mail"],
  "hosts": [
    { "pattern": "api.sendgrid.com" },
    { "pattern": "(^|\\.)sendgrid\\.com$", "isRegex": true }
  ],
  "methods": [
    {
      "pattern": "mail.send",
      "httpMethod": "POST",
      "endpoint": "https://api.sendgrid.com/v3/mail/send",
      "costModel": "per_transaction",
      "fixedFee": 0.0001,
      "description": "Send an email via SendGrid Mail Send API"
    }
  ]
}
```

### 3. Register the import in `index.ts`

In `src/scanner/fingerprints/index.ts`, add your import and include it in the appropriate export array:

- **`ALL_PROVIDERS`** — if your provider has SDK methods, pricing, and language support (AI, billing, etc.)
- **`HOST_MAP_PROVIDERS`** — if you only need hostname → provider ID resolution (no SDK methods)

```typescript
// In index.ts
import sendgrid from "./sendgrid.json";

// For a full provider (has methods):
export const ALL_PROVIDERS: ProviderFingerprint[] = [
  // ...existing entries,
  sendgrid,
] as ProviderFingerprint[];
```

For a host-only grouped file (no methods), add it to `HOST_MAP_PROVIDERS` instead.

### 4. Run tests

```bash
npm run test:scanner
```

All tests must pass before submitting.

### 5. Submit a PR

Open a pull request against `main` with the title `feat(registry): add {Provider} fingerprints`.

---

## Schema Reference

All fields are defined in [`types.ts`](./types.ts).

### Top-level fields

| Field | Type | Required | Description |
|---|---|---|---|
| `schemaVersion` | `string` | ✓ | Always `"1.0.0"` |
| `provider` | `string` | ✓ | Machine-readable ID, lowercase kebab-case (e.g. `"aws-bedrock"`) |
| `displayName` | `string` | ✓ | Human-readable name shown in the UI (e.g. `"AWS Bedrock"`) |
| `languages` | `Language[]` | ✓ | SDK languages supported. Use `[]` for host-only files |
| `packages` | `string[]` | ✓ | NPM/pip/etc. package names. Use `[]` for host-only files |
| `hosts` | `HostPattern[]` | ✓ | Hostname patterns for this provider |
| `methods` | `MethodFingerprint[]` | ✓ | SDK method entries. Use `[]` for host-only files |

Valid `Language` values: `"javascript"`, `"typescript"`, `"python"`, `"go"`, `"java"`, `"ruby"`, `"rust"`.

### `HostPattern` fields

| Field | Type | Required | Description |
|---|---|---|---|
| `pattern` | `string` | ✓ | Exact hostname or regex string (see `isRegex`) |
| `isRegex` | `boolean` | — | When `true`, `pattern` is a JS regex (without `//` delimiters). Default: `false` (exact match) |
| `provider` | `string` | — | Override: `lookupHost()` returns this instead of the file's top-level `provider`. Useful in grouped host-map files where multiple providers share one JSON file |

**Regex escaping in JSON**: A regex dot must be `\\.` in JSON (two chars: backslash + dot). Example: `"(^|\\.)sendgrid\\.com$"` compiles to the regex `(^|\.)sendgrid\.com$`.

### `MethodFingerprint` fields

| Field | Type | Required | Description |
|---|---|---|---|
| `pattern` | `string` | one of | SDK method chain without the variable prefix, e.g. `"chat.completions.create"`. Use this OR `urlPathKey` |
| `urlPathKey` | `string` | one of | URL-path segment for raw-`fetch`-only providers, e.g. `"v1/text-to-speech"`. Use this OR `pattern`. See [URL-path fingerprints](#url-path-fingerprints-urlpathkey) below |
| `httpMethod` | `string` | ✓ | HTTP verb: `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `SUBSCRIBE`, or `RPC` |
| `endpoint` | `string` | ✓ | Full URL of the API endpoint, e.g. `"https://api.sendgrid.com/v3/mail/send"` |
| `costModel` | `CostModel` | ✓ | One of `"per_token"`, `"per_transaction"`, `"per_request"`, `"free"` |
| `inputPricePer1M` | `number` | per_token | USD cost per 1M input tokens |
| `outputPricePer1M` | `number` | per_token | USD cost per 1M output tokens |
| `fixedFee` | `number` | per_transaction | Flat USD fee per call (e.g. `0.30` for $0.30) |
| `percentageFee` | `number` | per_transaction | Fractional rate (e.g. `0.029` for 2.9%) |
| `streaming` | `boolean` | — | `true` if this method returns a streaming response |
| `batchCapable` | `boolean` | — | `true` if this method supports batched requests |
| `cacheCapable` | `boolean` | — | `true` if responses can be cached |
| `description` | `string` | — | One-line human-readable description |

Either `pattern` or `urlPathKey` must be set on every method entry — the registry will reject a file where any method has neither.

**Cost model rules:**
- `per_token` — must have `inputPricePer1M`
- `per_transaction` — must have `fixedFee` or `percentageFee` (or both)
- `per_request` — no pricing fields required (usage-based tiers)
- `free` — no pricing fields

### URL-path fingerprints (`urlPathKey`)

For providers commonly called via raw `fetch(...)` (with no SDK method chain), add a method entry with `urlPathKey` instead of `pattern`. The matcher walks longest-key first and falls back to a `_default` entry if you add one. Path matching is segment-aware (matches on `/` boundaries), so `"v1/text-to-speech"` matches `/v1/text-to-speech/voice-abc/stream` but NOT `/api/v1`.

See `elevenlabs.json` for a worked example.

---

## Worked Example — Twilio

Twilio charges per SMS/call unit. Here is a complete file:

```json
{
  "schemaVersion": "1.0.0",
  "provider": "twilio",
  "displayName": "Twilio",
  "languages": ["javascript", "typescript", "python"],
  "packages": ["twilio"],
  "hosts": [
    { "pattern": "(^|\\.)twilio\\.com$", "isRegex": true }
  ],
  "methods": [
    {
      "pattern": "messages.create",
      "httpMethod": "POST",
      "endpoint": "https://api.twilio.com/2010-04-01/Accounts/{AccountSid}/Messages",
      "costModel": "per_transaction",
      "fixedFee": 0.0079,
      "description": "Send an SMS — $0.0079 per outbound segment (US)"
    },
    {
      "pattern": "calls.create",
      "httpMethod": "POST",
      "endpoint": "https://api.twilio.com/2010-04-01/Accounts/{AccountSid}/Calls",
      "costModel": "per_transaction",
      "fixedFee": 0.014,
      "description": "Initiate an outbound call — $0.014/min (US)"
    }
  ]
}
```

Then in `index.ts`:
```typescript
import twilio from "./twilio.json";

export const ALL_PROVIDERS: ProviderFingerprint[] = [
  // ...existing,
  twilio,
] as ProviderFingerprint[];
```

---

## How to Find the Data

**SDK method signatures** — check the official SDK README or GitHub repository. The `pattern` field is the method chain without the client variable (e.g., if users call `client.messages.create(...)`, the pattern is `"messages.create"`).

**Endpoint mappings** — look in the provider's API reference docs. Match the HTTP verb and URL path exactly.

**Pricing** — check the provider's public pricing page. Include a comment in your PR with the source URL and the date you checked. Prices change; it's fine to use the current rate.

---

## Updating an Existing Provider

1. Open the relevant JSON file in `src/scanner/fingerprints/`
2. Add the new method entry to the `methods` array, or update an existing entry's pricing
3. Run `npm run test:scanner` — the schema validation tests will catch malformed entries
4. If you add a new host pattern, add a `lookupHost` test in `src/test/fingerprint-registry.test.ts`

---

## Running Tests

```bash
# Full scanner test suite (includes registry validation + integration tests)
npm run test:scanner
```

All `PASS` lines, no `FAIL` lines.

---

## Review Criteria

Maintainers check for:

- **Schema compliance** — `schemaVersion`, all required fields present, valid `CostModel` and `httpMethod` values
- **Accurate pricing** — prices match the provider's current public pricing page; include the source URL in your PR description
- **Complete method coverage** — all commonly used SDK methods are represented; obscure admin-only methods can be omitted
- **Host patterns** — at least one host pattern so `lookupHost()` resolves the provider correctly
- **No duplicate patterns** — each `pattern` must be unique within a provider file
- **Tests pass** — `npm run test:scanner` green
