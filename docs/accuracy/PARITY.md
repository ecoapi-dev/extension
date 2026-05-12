# AST ↔ Regex Parity — Documented Divergences

Tracked under [issue #76](https://github.com/recost-dev/extension/issues/76). The
parity test in `src/test/parity.test.ts` runs both detection paths against
`src/test/fixtures/parity/`, normalises results to `(provider, method, line)`
tuples, and fails on any divergence not listed below.

## How to use this list

- Adding a fixture: place it under `src/test/fixtures/parity/`. If both paths
  are expected to detect the same calls, no entry is needed.
- A divergence the test surfaces is either a bug (fix it) or a documented
  intentional difference (add an entry below). The first option is preferred.
- Entries are parsed by `parseAllowlist()` in `src/test/parity.ts` from the
  fenced YAML block. Keep that block as the single source of truth.

## Allowlist

```yaml
- file: wrapped-call.ts
  reason: AST follows wrapper functions back to the SDK call; regex sees only the wrapper invocation by name.
  astOnly: true
```
