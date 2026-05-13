# D. Measurement

You cannot improve what you don't measure. Every other item in this directory is a feel-good fix without a benchmark to prove it actually moved precision or recall.

---

## D1. Labeled benchmark corpus + CI precision/recall gate

### Problem
Today, "did this PR improve accuracy?" is answered by:
- Running the scanner on whatever repo is open in VS Code.
- Eyeballing whether the output "looks right."
- Shipping if no test fails.

This is how you ship regressions that no one notices until users churn. There is no number that says "the scanner is 87% accurate today, this PR makes it 91%."

### Target behavior
A labeled benchmark of real repos, hand-annotated with expected detections and expected findings. CI runs the scanner against the corpus on every PR and fails if precision or recall drops.

### Corpus selection
Pick 5–10 real, public repos that exercise different surfaces of the scanner:

| Repo | Surface tested |
|---|---|
| `langchain-ai/langchain` (small subset) | Heavy OpenAI + many providers, wrapper-rich |
| `vercel/ai` examples | Modern TS + Vercel AI SDK |
| `openai/openai-cookbook` (selected files) | Canonical OpenAI usage |
| `stripe-samples/*` (one or two) | Stripe SDK patterns |
| A Bedrock demo | AWS SDK + non-SDK fetch |
| A Django/Flask app with mixed providers | Python coverage |
| A simple Express app | Generic-HTTP coverage |
| A barrel-heavy TS monorepo | Re-export resolution |
| A repo with dynamic URLs | Constant-fold testing |
| A repo with deep wrapper chains | Multi-hop resolution |

Keep each fixture small (10–50 files) to keep scan times CI-acceptable.

### Annotation format
For each repo, a `expected.json` file lists:

```json
{
  "endpoints": [
    {
      "file": "src/ai/openai.ts",
      "function": "complete",
      "provider": "openai",
      "method": "chat.completions.create",
      "must_detect": true
    },
    ...
  ],
  "findings": [
    {
      "file": "src/ai/openai.ts",
      "function": "fetchAll",
      "type": "n_plus_one",
      "is_true_positive": true
    },
    ...
  ]
}
```

Annotations are the ground truth. The benchmark runner produces actual output and compares.

### Metrics
For each repo and overall:
- **Detection precision** = (correctly detected endpoints) / (all detected endpoints)
- **Detection recall** = (correctly detected endpoints) / (expected endpoints)
- **Provider attribution accuracy** = (correctly attributed) / (detected with provider)
- **Finding precision** = (true-positive findings) / (all findings)
- **Finding recall** = (true-positive findings) / (expected findings)

### CI integration
- `npm run benchmark` runs the corpus, outputs a JSON report.
- A GitHub Actions workflow runs it on every PR.
- Baseline metrics live in `benchmark/baseline.json`, committed.
- The workflow fails if precision OR recall drops by more than 1 percentage point vs baseline (configurable threshold).
- When a PR legitimately improves metrics, the author updates `baseline.json` as part of the change.

### Acceptance criteria
- [ ] At least 5 repos in the corpus, hand-labeled.
- [ ] `npm run benchmark` produces a metrics report.
- [ ] CI workflow runs on every PR.
- [ ] Baseline committed; current metrics published in this doc once measured.
- [ ] Regression gate prevents merging PRs that drop precision/recall.

### Initial baseline (measured 2026-05-13)

| Metric | Value |
|---|---|
| Detection precision | 29.89% |
| Detection recall | 42.62% |
| Provider attribution accuracy | 79.59% |
| Finding precision | 7.14% |
| Finding recall | 33.33% |

Baseline committed in `benchmark/baseline.json`. PRs that drop any metric by > 1pp fail CI.

### Files
- New: `benchmark/` directory with fixtures + `expected.json` per fixture.
- New: `benchmark/runner.ts` — runs scanner, compares to expected, outputs metrics.
- New: `.github/workflows/benchmark.yml` — CI runner.
- New: `benchmark/baseline.json` — committed baseline metrics.

### Non-goals
- Not a replacement for unit tests. Unit tests verify a function does what it says; the benchmark verifies the *system* hits real-world repos correctly.
- Not 100% coverage. The corpus is a sample, not exhaustive. Picked to exercise the dimensions that matter (provider variety, wrapper depth, dynamic URLs, multi-language).

### Why this is item D, not item Z
This is the foundation. Every fix in A and C should reference its impact on these metrics. Without D, nothing else is measurable.

---
