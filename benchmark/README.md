# Benchmark

Hand-labeled accuracy gate for the scanner. Fails CI when precision or recall drops > 1pp.

## Quick start

```bash
# Smoke (no clone, fast):
npm run benchmark:smoke

# Full (requires extension-benchmark cloned as sibling dir):
git clone https://github.com/recost-dev/extension-benchmark.git ../extension-benchmark
npm run benchmark
```

## Layout

- `runner.ts` — orchestrates per-fixture scan + metric computation. Reads `--fixtures <dir>` (default `../extension-benchmark`).
- `metrics.ts` — pure precision/recall math.
- `schema.ts` — `expected.json` types + validator.
- `report.ts` — console + markdown report formatting.
- `baseline.json` — committed metric baseline. Gate compares current run vs this.
- `_smoke/` — tiny in-repo fixture for runner development.

## CI

`.github/workflows/benchmark.yml` runs on every PR. It reads `.benchmark-fixtures-sha` (repo root), clones `extension-benchmark` at that SHA, then runs `npm run benchmark`.

## Adding a fixture

Fixtures live in `extension-benchmark`, not here. To add one:

1. Open a PR in `recost-dev/extension-benchmark` with a new `<slug>/src/...`, `<slug>/expected.json`, `<slug>/FIXTURE.md`.
2. Once merged, bump `.benchmark-fixtures-sha` in `extension`.
3. Run `npm run benchmark -- --update-baseline` locally and commit `baseline.json` if the new fixture changed it.

## Updating the baseline

When a PR legitimately improves accuracy:

```bash
npm run benchmark -- --update-baseline
git add benchmark/baseline.json
```

Commit the new baseline in the same PR as the code change. Explain why in the PR description.
