/**
 * ast/waste/batch-detector.ts — AST-based batch and N+1 waste detector.
 *
 * Rebuilds batch / N+1 / sequential-await detection from local-waste-detector.ts
 * on top of the structural frequency and registry data produced by the Phase 2
 * AST scanner.
 *
 * Key improvements over the regex approach:
 *  - Loop detection uses AST-derived FrequencyClass (no regex false positives)
 *  - batchCapable flag comes from the fingerprint registry (not action-name guess)
 *  - Sequential-await detection groups by exact provider, not fuzzy resource key
 *  - Parallel fan-out (Promise.all + map) identified structurally via frequency
 *
 * Waste types produced:
 *  - "batch"     — call inside loop that has a batch API alternative, or
 *                  multiple single-provider calls that could be Promise.all'd
 *  - "n_plus_one"— call inside loop with no batch alternative (per-iteration
 *                  individual requests scaling with collection size)
 */
import type { AstCallMatch } from "../ast-scanner";
import type { LocalWasteFinding } from "../../scanner/local-waste-detector";
import type { Severity, SuggestionType } from "../../analysis/types";
import { STDLIB_DENYLIST } from "../../scanner/fingerprints/index";

function isRealProviderMatch(match: AstCallMatch): boolean {
  if (!match.provider) return false;
  if (match.packageName && STDLIB_DENYLIST.has(match.packageName)) return false;
  if (STDLIB_DENYLIST.has(match.provider)) return false;
  return true;
}

// ── Guard patterns (source text window) ──────────────────────────────────────

/** Signals that a batch/bulk mechanism is already in place. */
const BATCH_GUARD =
  /\b(batch|batches|bulk|chunk|upsert|messageBatches|message_batches|flushQueue|enqueue)\b/i;

/** Signals that a concurrency limiter is already guarding the fan-out. */
const CONCURRENCY_GUARD =
  /\b(p-limit|bottleneck|semaphore|mutex|throttle|debounce|concurrency\s*:|limit\s*:|pool)\b/i;

/**
 * Bounded replication fan-out: `Array.from({ length: N })` creates a fixed-size array
 * for parallel calls — the count is intentional (e.g. the API's own `n` param),
 * not a naive map over arbitrary data. Not wasteful in the batch sense.
 */
const BOUNDED_REPLICATION = /Array\.from\s*\(\s*\{/;

// ── File-path heuristics ──────────────────────────────────────────────────────

const TEST_FILE = /(^|\/)(test|tests|spec|stories|storybook|fixtures?|examples?)\//i;
const STARTUP_FILE = /(^|\/)(scripts?|bin|migrations?|seed|bootstrap|cli|init)\//i;
const SMALL_BOUNDED = /\b(length\s*:\s*[1-5]\b|<\s*[1-5]\b|slice\s*\(\s*0\s*,\s*[1-5]\s*\))\b/i;

// ── Helpers ───────────────────────────────────────────────────────────────────

function clamp(v: number): number {
  return Number(Math.max(0, Math.min(1, v)).toFixed(2));
}

function scoreToSeverity(score: number): Severity {
  if (score >= 5) return "high";
  if (score >= 3) return "medium";
  return "low";
}

function hasGuardInWindow(source: string, line: number, pattern: RegExp): boolean {
  if (!source) return false;
  const lines = source.split("\n");
  const idx = line - 1;
  const start = Math.max(0, idx - 8);
  const end = Math.min(lines.length, idx + 9);
  return pattern.test(lines.slice(start, end).join("\n"));
}

function isSmallBounded(source: string, line: number): boolean {
  return hasGuardInWindow(source, line, SMALL_BOUNDED);
}

function dedupeFindings(findings: LocalWasteFinding[]): LocalWasteFinding[] {
  const seen = new Map<string, LocalWasteFinding>();
  for (const f of findings) {
    const key = `${f.type}:${f.affectedFile}:${f.line ?? 0}`;
    const existing = seen.get(key);
    if (!existing || f.confidence > existing.confidence) seen.set(key, f);
  }
  return [...seen.values()];
}

// ── Batch finding (loop + batch alternative exists) ───────────────────────────

// Frequency values where a batch API suggestion is appropriate.
// "polling" is excluded — timer-driven repetition is a rate-limit concern.
const BATCH_LOOP_FREQS = new Set(["bounded-loop", "unbounded-loop", "parallel"]);

function detectBatch(
  match: AstCallMatch,
  source: string,
  filePath: string,
  isTestLike: boolean
): LocalWasteFinding | null {
  // Calibration: only fire for loop/parallel contexts; polling → rate-limit detector.
  if (!isRealProviderMatch(match)) return null;
  if (!BATCH_LOOP_FREQS.has(match.frequency)) return null;
  if (!match.batchCapable) return null;
  if (hasGuardInWindow(source, match.line, BATCH_GUARD)) return null;
  // Array.from({ length: N }) is intentional bounded replication (e.g. using the API's
  // own n/count param) — not naive per-item fan-out; skip the batch suggestion.
  if (match.frequency === "parallel" && hasGuardInWindow(source, match.line, BOUNDED_REPLICATION)) return null;

  const evidence: string[] = [
    `Call executes in a "${match.frequency}" context — each iteration makes a separate request.`,
    "This provider offers a batch/bulk API alternative.",
  ];

  const small = isSmallBounded(source, match.line);
  if (small) evidence.push("Loop appears bounded to a small collection (≤5 items).");

  let score = 1;
  if (match.frequency === "unbounded-loop") score += 3;
  else if (match.frequency === "bounded-loop") score += 2;
  else if (match.frequency === "parallel") score += 2; // map fan-out into loop
  else if (match.frequency === "polling") score += 4;
  if (small) score -= 1;
  if (isTestLike) score -= 1;

  let confidence = 0.52 + Math.min(score, 5) * 0.07;
  if (small) confidence -= 0.10;
  if (isTestLike) confidence -= 0.10;
  confidence = clamp(confidence);
  if (confidence < 0.35) return null;

  return {
    id: `local-batch-${filePath}:${match.line}`,
    type: "batch" as SuggestionType,
    severity: scoreToSeverity(score),
    confidence,
    description:
      "Batch-capable API call executes inside a loop — consolidate into a single batch request.",
    affectedFile: filePath,
    line: match.line,
    evidence,
  };
}

// ── N+1 finding (loop, no batch alternative) ──────────────────────────────────

// Frequency values where per-item N+1 scaling is the concern.
// "polling" → rate-limit detector. "parallel" → concurrency detector.
const N_PLUS_ONE_FREQS = new Set(["bounded-loop", "unbounded-loop"]);

function detectNPlusOne(
  match: AstCallMatch,
  source: string,
  filePath: string,
  isTestLike: boolean
): LocalWasteFinding | null {
  // Calibration: only fire for collection iteration loops.
  // Polling and parallel fan-out are handled by other detectors.
  if (!isRealProviderMatch(match)) return null;
  if (!N_PLUS_ONE_FREQS.has(match.frequency)) return null;
  if (match.batchCapable) return null; // batch-detector handles this one
  if (hasGuardInWindow(source, match.line, BATCH_GUARD)) return null;
  if (hasGuardInWindow(source, match.line, CONCURRENCY_GUARD)) return null;

  const evidence: string[] = [
    `Call executes in a "${match.frequency}" context — individual requests scale linearly with collection size.`,
  ];
  if (match.frequency === "unbounded-loop") {
    evidence.push("Loop has no clear upper bound.");
  }

  let score = 2;
  if (match.frequency === "unbounded-loop") score += 2;
  else if (match.frequency === "bounded-loop") score += 1;
  else if (match.frequency === "polling") score += 3;
  if (isSmallBounded(source, match.line)) score -= 1;
  if (isTestLike) score -= 1;

  let confidence = 0.50 + Math.min(score, 5) * 0.07;
  if (hasGuardInWindow(source, match.line, BATCH_GUARD)) confidence -= 0.15;
  if (isTestLike) confidence -= 0.10;
  confidence = clamp(confidence);
  if (confidence < 0.35) return null;

  return {
    id: `local-n_plus_one-${filePath}:${match.line}`,
    type: "n_plus_one" as SuggestionType,
    severity: scoreToSeverity(score),
    confidence,
    description:
      "Loop-driven individual API requests scale linearly with collection size — consider batching or restructuring.",
    affectedFile: filePath,
    line: match.line,
    evidence,
  };
}

// ── Sequential finding (multiple single calls → could be Promise.all'd) ───────

function detectSequential(
  matches: AstCallMatch[],
  source: string,
  filePath: string,
  isTestLike: boolean
): LocalWasteFinding[] {
  const providerMatches = matches.filter(isRealProviderMatch);
  const byBucket = new Map<string, { provider: string; matches: AstCallMatch[] }>();
  for (const m of providerMatches) {
    if (m.frequency !== "single" || m.loopContext) continue;
    if (!m.provider) continue;
    // Bucket by (provider, enclosingFunction): calls in different functions
    // can't be batched together — they execute on independent code paths.
    const fnKey = m.enclosingFunction ?? "<module>";
    const key = `${m.provider}::${fnKey}`;
    const bucket = byBucket.get(key) ?? { provider: m.provider, matches: [] };
    bucket.matches.push(m);
    byBucket.set(key, bucket);
  }

  const findings: LocalWasteFinding[] = [];

  for (const { provider, matches: group } of byBucket.values()) {
    if (group.length < 2) continue;
    // Dedupe by line — cross-file resolver expansion can produce multiple
    // matches at the same call line for one user-written call.
    const uniqueLines = new Set(group.map((m) => m.line));
    if (uniqueLines.size < 2) continue;
    const firstMatch = group[0];
    if (hasGuardInWindow(source, firstMatch.line, CONCURRENCY_GUARD)) continue;
    if (hasGuardInWindow(source, firstMatch.line, BATCH_GUARD)) continue;

    let score = 1 + Math.min(uniqueLines.size - 1, 3);
    if (isTestLike) score -= 1;
    let confidence = 0.45 + Math.min(score, 5) * 0.06;
    if (isTestLike) confidence -= 0.10;
    confidence = clamp(confidence);
    if (confidence < 0.35) continue;

    findings.push({
      id: `local-batch-seq-${filePath}:${firstMatch.line}`,
      type: "batch" as SuggestionType,
      severity: scoreToSeverity(score),
      confidence,
      description: `${uniqueLines.size} sequential ${provider} calls could be fired in parallel with Promise.all to reduce total latency.`,
      affectedFile: filePath,
      line: firstMatch.line,
      evidence: [
        `${uniqueLines.size} independent calls to "${provider}" detected in this file (lines ${[...uniqueLines].sort((a,b)=>a-b).join(", ")}).`,
        "Wrapping independent awaits in Promise.all reduces wall-clock time proportional to the slowest call.",
      ],
    });
  }

  return findings;
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Detect batch and N+1 waste opportunities in a set of AST call matches.
 *
 * @param matches  - Output of `scanSourceWithAst()` for a single file.
 * @param source   - Raw source text (used for guard window scans).
 * @param filePath - Relative or absolute file path.
 * @returns        - `LocalWasteFinding[]` with type "batch" or "n_plus_one".
 */
export function detectBatchWaste(
  matches: AstCallMatch[],
  source: string,
  filePath: string
): LocalWasteFinding[] {
  const isTestLike = TEST_FILE.test(filePath);
  const isStartupLike = STARTUP_FILE.test(filePath);

  const findings: LocalWasteFinding[] = [];

  for (const match of matches) {
    if (isStartupLike && !match.loopContext) continue;

    const batchFinding = detectBatch(match, source, filePath, isTestLike);
    if (batchFinding) findings.push(batchFinding);

    const n1Finding = detectNPlusOne(match, source, filePath, isTestLike);
    if (n1Finding) findings.push(n1Finding);
  }

  // Sequential await detection is cross-match, runs once over all matches.
  const seqFindings = detectSequential(matches, source, filePath, isTestLike);
  findings.push(...seqFindings);

  return dedupeFindings(findings);
}
