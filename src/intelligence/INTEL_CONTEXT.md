# Intelligence Layer — Implementation Context

The intelligence layer lives at `src/intelligence/` and transforms raw scanner output into a structured, ranked, and exportable AI Review Pack. It is a pure TypeScript computation layer with no VSCode, browser, or webview dependencies.

## Pipeline overview

```
ApiCallInput[] + LocalWasteFinding[]
        │
        ▼
   builder.ts  →  RepoIntelligenceSnapshot
        │
        ▼
   scorer.ts   →  ScoredSnapshot
        │
        ▼
  clusters.ts  →  ReviewCluster[]
        │
        ▼
compression.ts →  CompressedCluster[]
        │
        ▼
   export.ts   →  ExportedContext  →  markdown / JSON
```

---

## Files

| File | Role |
|---|---|
| `types.ts` | Shared interface contracts — do not change without team sync |
| `builder.ts` | Normalizes scanner output into a validated graph (`RepoIntelligenceSnapshot`) |
| `scorer.ts` | Scores every file on 3 signals and produces a ranked `ScoredSnapshot` |
| `clusters.ts` | Groups high-priority files into `ReviewCluster[]` with related files and a review question |
| `compression.ts` | Converts clusters to `CompressedCluster[]` — human-readable summaries + code snippets |
| `export.ts` | Builds `ExportedContext` and renders markdown or JSON output |
| `finding-dedupe.ts` | Context-aware deduplication utility shared by clusters and compression |
| `file-signals.ts` | Path classifiers: test, generated, analysis-tooling, deprioritized |
| `provider-normalization.ts` | Canonical provider ID registry and junk-provider filtering |
| `cost-utils.ts` | `estimateLocalMonthlyCost()` — called by `compression.ts` to populate file- and cluster-level cost estimates |
| `path-utils.ts` | Shared path helpers |
| `mocks/mockSnapshot.ts` | Shared `RepoIntelligenceSnapshot` fixture (5 files, 10 calls, 6 findings, 3 providers) for tests and dev |

---

## types.ts

Defines every interface contract used across the pipeline. Nothing is inferred at runtime — all types are explicit.

**Core graph nodes:**
- `FileNode` — file path, arrays of `apiCallIds`, `findingIds`, `providers[]`
- `ApiCallNode` — line, provider, method, url, library, costModel, frequencyClass, batchCapable, cacheCapable, streaming, isMiddleware, crossFileOrigin
- `FindingNode` — type (SuggestionType), severity, confidence, description, evidence[]
- `ProviderNode` — fileIds, apiCallIds, findingIds, urls, costModels aggregated across the repo

**Snapshot:**
- `RepoIntelligenceSnapshot` — `createdAt`, `repoRoot?`, record maps for files/apiCalls/findings/providers, `totalFilesScanned`

**Scoring:**
- `FileScores` — `importance`, `costLeak`, `reliabilityRisk`, `aiReviewPriority` (all 0–10)
- `ScoredFile` — filePath, fileId, scores, `reasons[]` (up to 5 explainable strings)
- `ScoredSnapshot` — snapshot, `scoredFiles[]` (sorted by priority), `rankedProviders[]`, `rankedFindings[]`

**Clustering:**
- `RelatedFile` — filePath, relationship description
- `ReviewCluster` — id, primaryFile (ScoredFile), relatedFiles[], topFindings[], providers[], `estimatedMonthlyCost`, reviewQuestion

**Export shapes:**
- `FileSummary` — filePath, description (2 sentences max), providers, topRisks[], estimatedMonthlyCost, whyItMatters (1 sentence)
- `CompressedSnippet` — filePath, startLine, endLine, code, label
- `CompressedCluster` — primarySummary, relatedSummaries[], findings[], snippets[], providers, reviewQuestion
- `ExportedContext` — meta (projectName, generatedAt, totalFiles, totalClusters, providers, contextProviders?), summary (topFiles[], keyRisks[]), clusters[]

---

## builder.ts

**Entry point:** `buildRepoIntelligenceSnapshot(input)` / alias `buildSnapshot(input)`

**Input:** `{ apiCalls: ApiCallInput[], findings: LocalWasteFinding[], repoRoot?, totalFilesScanned? }`

**What it does:**
1. Normalizes file paths (backslashes → forward slashes, strips leading `./`)
2. Groups calls and findings by file
3. Creates `FileNode` records for every file that appears in either collection
4. Generates stable `ApiCallNode` IDs using FNV-1a hashing over method, url, provider, library, methodSignature, costModel, frequencyClass, capability flags, and crossFileOrigin
5. Links findings to their nearest API call by line distance (for provider attribution)
6. Builds `ProviderNode` aggregates — files, calls, findings, urls, costModels are all sorted deterministically
7. Validates all cross-references before returning — throws on duplicate IDs, broken references, or provider drift in file nodes

**ID format:** `filePath:line:fingerprint` for API calls; `finding:filePath:line:type:fingerprint:index` for findings (or the finding's own `.id` if provided)

---

## scorer.ts

**Entry point:** `scoreRepoIntelligence(snapshot)` / alias `scoreSnapshot(snapshot)`

**Three raw signals (computed per file, then normalized 0–10 relative to the max across all files):**

| Signal | Formula |
|---|---|
| `importance` | `calls.length × 2 + findings.length × 2 + realProviders.length × 1.5 + highFrequencyCallCount × 2` |
| `costLeak` | `frequencyWeightTotal + repeatedCallCount + uncachedCacheCapableCount × 2 + costLeakFindingWeight` |
| `reliabilityRisk` | `reliabilitySeverityWeight + reliabilityFindingTypeWeight + highFrequencyWithoutEvidenceCount × 2 + (findings.length ≥ 2 ? 2 : 0)` |

**Frequency cost weights:** `unbounded-loop` = 3, `parallel` = 2, `polling` = 2, `bounded-loop` = 1

**Cost leak finding types:** `cache`, `batch`, `unbatched_parallel`, `n_plus_one`, `redundancy` (weighted by severity: high=3, medium=2, low=1)

**Reliability finding types:** `rate_limit` (+3), `concurrency_control` (+3)

**`aiReviewPriority` formula:**
```
priority = importance × 0.3 + costLeak × 0.3 + reliabilityRisk × 0.25 + priorityBonus
```
Priority bonuses: multiple providers (+0.8), high-confidence findings (confidence ≥ 0.85, +0.7)

**Deprioritization multipliers applied after priority calculation:**
- Test files (`*.test.*`, `*.spec.*`, `__tests__/`, etc.): × 0.05
- Deprioritized context files (dist/, build/, `src/scanner/patterns/`, `src/ast/call-visitor.ts`): × 0.1

**`reasons[]`** — up to 5 explainable strings, sorted by weight. Candidates include: call count, high-frequency call count, provider count, specific frequency class, finding severity, repeated calls, cache-capable without cache, reliability findings, high-confidence findings.

**`rankedProviders`** — sorted by file count, then call count, then finding count.

**`rankedFindings`** — sorted by `severity × confidence`, then filePath, then line.

---

## clusters.ts

**Entry point:** `buildReviewClusters(scored)`

**Primary file selection:**
- Up to 5 files (`MAX_PRIMARY_FILES = 5`)
- Prefers runtime files (excludes test and deprioritized context files)
- Falls back to non-test files, then all files if needed
- Selected from the top of `scoredFiles[]` (already sorted by `aiReviewPriority` descending)

**Related file selection per cluster (2–5 files):**

Candidates are classified into three buckets: `runtime`, `tooling` (scanner/AST pattern files), `test`.

Match tiers (evaluated in order):
1. **Exact match — repeated pattern:** shares a repeated endpoint key (`provider|method|url` seen ≥ 2× in both files) → score 60 + overlap × 5
2. **Exact match — endpoint pattern:** shares any endpoint key → score 50 + overlap × 4
3. **Broad match — same provider:** → score 40 + shared count × 3
4. **Broad match — same directory:** → score 30
5. **Broad match — same module prefix:** → score 20
6. **Fallback — proximity in priority rank:** → score 5 + (10 − rankDistance)

Tooling files only qualify via exact match (not broad match); fallback adds broad match for tooling. Test files are last resort. Selection prefers runtime strong → tooling strong → runtime fallback → tooling fallback → test strong → test fallback.

**Finding deduplication:**
Findings are deduped by context key: `filePath::type::line::description::evidence::method::url::provider::library::originFile::originFunction`. The highest-severity × confidence version wins duplicates.

**Cluster overlap merging:**
If two clusters share > 50% of their files, only the higher-priority one is kept.

**Review questions** — generated by `buildReviewQuestion()`, always action-oriented:
- Unbounded-loop: `"Check whether [Provider] calls inside unbounded loops can be batched, cached, or guarded with tighter limits."`
- Parallel fanout: `"Check whether [Provider] parallel API fanout can be batched, cached, or guarded with tighter limits."`
- Polling: `"Check whether [Provider] polling traffic can be batched, cached, or guarded with tighter limits."`
- Rate-limit finding: `"Check whether [Provider] requests in this path need explicit rate limiting or backoff safeguards."`
- Concurrency-control finding: `"Check whether [Provider] calls in this path need tighter concurrency control or queueing."`
- Repeated calls: `"Check whether repeated [Provider] API calls in this file can be deduplicated or consolidated."`
- Cache-capable without cache: `"Check whether cache-capable [Provider] calls in this file should be cached before adding more traffic."`
- Fallback: `"Check whether the highest-priority [Provider] path in this file needs batching, safeguards, or request cleanup."`

---

## compression.ts

**Entry point:** `compressClusters(clusters, snapshot)`

Converts each `ReviewCluster` into a `CompressedCluster` ready for export.

**`FileSummary` generation (`buildFileSummary`):**

`description` (max 2 sentences) — context-aware, prioritized:
1. High-frequency class present → calls count + provider phrase + frequency type
2. Repeated endpoint keys → repeats count + call count
3. Cache-capable without cache finding → call count + cache-capable note
4. Multiple providers → provider count
5. Findings → call + finding count
6. Fallback → simple call count

`whyItMatters` (max 1 sentence) — distinguishes test vs runtime files:
- Unbounded loop → "strong review target" (runtime) / "mainly useful for reproducing behavior" (test)
- Parallel fanout → "burst load and retry pressure" (runtime)
- Polling → "steady-state request volume" (runtime)
- Repeated keys, cache gaps, rate-limit, concurrency, multi-provider, finding concentration — each has specific language

`topRisks` (max 3) — ordered: high-frequency > repeated calls > cache gap > rate-limit > concurrency-control. Softened to "Potential X" when there are no confirmed findings (heuristic-only signals).

**Finding compression:**
- Deduped by context key (same as clusters), deduplicated further by `FINDING_TITLE_BY_TYPE` (one entry per title), max 5
- Titles: `rate_limit` → "Rate-limit risk", `concurrency_control` → "Concurrency-control gap", `cache` → "Missing caching", `redundancy` → "Repeated API pattern", `n_plus_one` → "N+1 risk", `batch` → "Batching opportunity"
- `estimatedMonthlyCost` is always null (finding-level cost is not defined)

**Snippet extraction:**
- Anchors are collected from API call lines (primary priority 1, related priority 3) and finding lines (primary priority 2, related priority 4)
- Radius: ± 3 lines around each anchor
- Ranges within 2 lines of each other are merged
- Max 5 snippets per cluster
- Snippets are read from disk using `snapshot.repoRoot` as base; silently skipped if unreadable
- Labels: `"API call inside loop"`, `"Parallel API call"`, `"Polling API path"`, `"Cacheable call without cache"`, `"Repeated API pattern"`, `"Relevant API call"`, `"Relevant test helper context"`, etc.

---

## export.ts

**Entry points:** `buildExportContext(clusters, snapshot, scored, options?)`, `formatAsMarkdown(context)`, `formatAsJSON(context)`

**`buildExportContext`:**
- `meta.projectName` — `path.basename(snapshot.repoRoot ?? process.cwd())`
- `meta.providers` — from snapshot provider keys + all API call providers, filtered to real provider IDs
- `meta.contextProviders` — providers inferred from file paths visible in the rendered context (matches `src/chat/providers/*.ts` and `src/scanner/patterns/provider-*.ts` patterns); omitted if equal to `meta.providers`
- `summary.topFiles` — top 5 non-test, non-deprioritized `scoredFiles[]`, with `whyItMatters` sourced from `CompressedCluster` summaries (falls back to `normalizeFallbackReason` from scorer `reasons[0]`)
- `summary.keyRisks` — aggregated and deduplicated across all cluster risks + findings. Sorted by frequency, then by priority order: unbounded loop > parallel > polling > repeated calls > rate-limit > missing cache. Capped at 5. Confirmed risks take precedence over "Potential" variants.

**`formatAsMarkdown`** — renders:
```
# ReCost Scan — {projectName}
## Summary
## Key Risks
## Top Files
---
## Cluster N — {primaryFile}
### Why this matters
### Providers
### Top Risks
### Findings
### Related Files
### Snippets
```
Provider section per cluster shows: "Detected in cluster", "Detected in primary file", "Added by related files" (when different), "Primary file identity" (from file path only, when applicable).

**`formatAsJSON`** — `JSON.stringify(context, null, 2)`

---

## finding-dedupe.ts

Shared deduplication utility used by both `clusters.ts` and `compression.ts`.

**`dedupeFindings(findings, compare, keyFn)`** — generic, keeps the best (lowest `compare` result) among findings sharing the same key.

**`makeFindingDedupeKey(finding)`** — `filePath::type::line::normalizedDescription::normalizedEvidence`

**`makeFindingContextDedupeKey(finding, signal)`** — extends the base key with nearest-call context: `method::url::provider::library::originFile::originFunction`. Used when an `ApiCallNode` signal is available.

---

## file-signals.ts

Path classifiers returning booleans:

- `isTestLikeFilePath` — matches `src/test/`, `__tests__/`, `test/`, `tests/`, `*.test.*`, `*.spec.*`
- `isGeneratedLikeFilePath` — matches `dashboard-dist/`, `dist/`, `dist-test/`, `build/`, `coverage/`, hashed asset files
- `isAnalysisToolingFilePath` — matches `src/scanner/patterns/` and `src/ast/call-visitor.ts`
- `isDeprioritizedContextFilePath` — `isGeneratedLikeFilePath || isAnalysisToolingFilePath`

---

## provider-normalization.ts

**`normalizeProviderId(value)`** — trims, lowercases, normalizes separators, applies canonical aliases (e.g. `"open-ai"` → `"openai"`, `"x-ai"` → `"xai"`). Returns null for paths, node: imports, or values with illegal characters.

**`isRealProviderId(value)`** — returns true only if the normalized ID is in the 25-entry `VALID_PROVIDER_IDS` allowlist and does not match junk patterns (node built-ins, test framework names).

Valid provider IDs: `openai`, `anthropic`, `gemini`, `cohere`, `mistral`, `stripe`, `paypal`, `aws`, `aws-bedrock`, `aws-s3`, `aws-api-gateway`, `aws-lambda`, `vertex-ai`, `supabase`, `firebase`, `firestore`, `xai`, `perplexity`, `openrouter`, `groq`, `deepseek`, `algolia`, `segment`, `github`, `google-maps`, `local-openai-compatible`

**`filterRealProviders(values)` / `collectRealProviders(values)`** — dedupes and returns sorted real provider IDs from a mixed array.

---

## mocks/mockSnapshot.ts

Shared fixture: `mockSnapshot` — a `RepoIntelligenceSnapshot` used by unit tests and local dev tooling.

Dataset: 5 files, 10 API calls, 6 findings, 3 providers (openai × 5 calls, anthropic × 2, stripe × 3). Covers: unbounded-loop, bounded-loop, conditional, single frequency classes; per_token, per_transaction, per_request cost models; n_plus_one, cache, rate_limit, redundancy finding types.

**Do not use in production paths.**

---

## Known gaps

- **`estimatedMonthlyCost`** is populated at the file and cluster level via `estimateLocalMonthlyCost()` from `cost-utils.ts`. Individual finding-level cost remains `null` — no per-finding formula is defined.
