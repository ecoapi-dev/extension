/**
 * ast/waste/cache-detector.ts — AST-based cache waste detector.
 *
 * Rebuilds the cache waste detection from local-waste-detector.ts on top of
 * the structural frequency and provider data produced by the Phase 2 AST
 * scanner instead of regex text-window heuristics.
 *
 * Key improvements over the regex approach:
 *  - Loop/polling/parallel detection uses the AST-derived FrequencyClass
 *    (no false positives from comments or string literals)
 *  - Provider and cacheCapable flags come from the fingerprint registry
 *  - Redundant call detection groups by exact methodChain, not a fuzzy key
 *  - Hot-path detection uses the AST-derived isMiddleware flag
 */
import type { AstCallMatch } from "../ast-scanner";
import type { LocalWasteFinding } from "../../scanner/local-waste-detector";
import type { Severity, SuggestionType } from "../../analysis/types";

// ── Guards ────────────────────────────────────────────────────────────────────

/**
 * Patterns that indicate a cache lookup is already in place.
 * Applied to the ~8 source lines *preceding* the call site.
 */
const CACHE_GUARD_WINDOW =
  /\b(cache\.get\b|cache\.has\b|\.get\(|map\.has\(|memo\[|redis\.get\b|memcached\.get\b|useQuery\b|queryClient\b|staleTime\b|swr\b)\b/i;

const WRITE_HTTP_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const WRITE_CHAIN_PATTERN =
  /\b(create|insert|update|delete|submit|mutat|upload|stream|run|send|publish|write)\b/i;

// ── File-path heuristics ──────────────────────────────────────────────────────

const HOT_PATH_FILE = /(^|\/)(api|routes?|handlers?|pages|app|server|controllers?)\//i;
const STARTUP_FILE = /(^|\/)(scripts?|bin|migrations?|seed|bootstrap|cli|init)\//i;
const TEST_FILE = /(^|\/)(test|tests|spec|stories|storybook|fixtures?|examples?)\//i;

// ── Method-chain heuristics ───────────────────────────────────────────────────

const AUTH_CHAIN = /\b(getUser|getSession|auth|authorization|accessToken|session|refreshSession|verify|authenticate)\b/i;
const CONFIG_CHAIN = /\b(getConfig|loadConfig|config|processEnv|featureFlag|secret|getSecret)\b/i;

// ── Helpers ───────────────────────────────────────────────────────────────────

function clamp(v: number): number {
  return Number(Math.max(0, Math.min(1, v)).toFixed(2));
}

function scoreToSeverity(score: number): Severity {
  if (score >= 5) return "high";
  if (score >= 3) return "medium";
  return "low";
}

/**
 * Method chains that are universal HTTP entry points — they carry no resource
 * identity on their own, so two calls with the same chain but different URLs
 * are NOT redundant. For these, the redundancy bucket key must include the
 * endpoint URL.
 */
const UNIVERSAL_HTTP_CHAIN = /^(?:fetch|axios(?:\.[a-z]+)?|got|ky|superagent(?:\.[a-z]+)?|requests(?:\.[a-z]+)?)$/i;

function chainKey(match: AstCallMatch): string {
  if (UNIVERSAL_HTTP_CHAIN.test(match.methodChain)) {
    // Raw HTTP method chains carry no resource identity — bucket per URL so
    // distinct endpoints don't collapse into one redundancy bucket. Include the
    // HTTP method too: `chainCount` is built from all matches (write-likes are
    // skipped later), so without method in the key a POST /x mutation would
    // inflate the count and falsely mark a sibling GET /x as redundant.
    const httpMethod = (match.method ?? "").toUpperCase();
    return `${match.methodChain}::${httpMethod}::${match.endpoint ?? ""}`;
  }
  return match.methodChain;
}

/**
 * Check whether any of the ~8 source lines before `line` (1-based) contain a
 * recognisable cache-lookup pattern. Falls back gracefully if `source` is empty.
 */
function hasCacheGuardInPrecedingLines(source: string, line: number): boolean {
  if (!source) return false;
  const lines = source.split("\n");
  const idx = line - 1; // 1-based → 0-based
  const start = Math.max(0, idx - 8);
  const window = lines.slice(start, idx + 1).join("\n");
  return CACHE_GUARD_WINDOW.test(window);
}

/**
 * Returns true for write-like calls that are unlikely to benefit from caching.
 *
 * Priority:
 *  1. cacheCapable=true → never write-like (registry is authoritative)
 *  2. Explicit GET HTTP method → not write-like
 *  3. Explicit write HTTP method (POST/PUT/PATCH/DELETE) → write-like
 *  4. No HTTP method available → fall back to chain pattern heuristic
 */
function isWriteLike(match: AstCallMatch): boolean {
  if (match.cacheCapable) return false;
  const httpMethod = (match.method ?? "").toUpperCase();
  if (httpMethod === "GET") return false;
  if (WRITE_HTTP_METHODS.has(httpMethod)) return true;
  // No explicit HTTP method — fall back to method-chain heuristic.
  return WRITE_CHAIN_PATTERN.test(match.methodChain);
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

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Detect cache waste opportunities in a set of AST call matches.
 *
 * @param matches  - Output of `scanSourceWithAst()` for a single file.
 * @param source   - Raw source text of the file (used only for cache-guard
 *                   window scan; may be empty string to skip that check).
 * @param filePath - Relative or absolute file path (used for finding IDs and
 *                   file-type classification).
 * @returns        - `LocalWasteFinding[]` in the same format as the regex
 *                   waste detector, ready to be merged with its output.
 */
export function detectCacheWaste(
  matches: AstCallMatch[],
  source: string,
  filePath: string
): LocalWasteFinding[] {
  const isTestLike = TEST_FILE.test(filePath);
  const isStartupLike = STARTUP_FILE.test(filePath);
  const isHotPathFile = HOT_PATH_FILE.test(filePath);

  // Count occurrences of each methodChain for redundancy detection.
  // For universal HTTP chains (fetch/axios/etc.) the bucket is keyed by URL
  // as well, since the chain alone has no resource identity.
  const chainCount = new Map<string, number>();
  for (const m of matches) {
    const key = chainKey(m);
    chainCount.set(key, (chainCount.get(key) ?? 0) + 1);
  }

  const findings: LocalWasteFinding[] = [];

  for (const match of matches) {
    // Skip write-like calls — cache suggestions don't apply to mutations.
    if (isWriteLike(match)) continue;

    // Calibration finding: polling-frequency calls are intentionally fetching
    // fresh data — caching the result would defeat the purpose of polling.
    // These are flagged (correctly) by the rate_limit detector instead.
    if (match.frequency === "polling") continue;

    // ── Guard check ───────────────────────────────────────────────────────────

    // The AST frequency-analyzer already detects cache-guarded conditionals
    // (if (!cache.has(key))) structurally. Fall back to text window for patterns
    // the AST doesn't model (e.g. Redis gets on the line above, not in an if).
    const isGuarded =
      match.frequency === "cache-guarded" ||
      hasCacheGuardInPrecedingLines(source, match.line);

    if (isGuarded) continue;

    // ── Signal collection ─────────────────────────────────────────────────────

    const inLoop = match.loopContext; // parallel | bounded/unbounded loop
    const hotPath = match.isMiddleware === true || isHotPathFile;
    const occurrences = chainCount.get(chainKey(match)) ?? 1;
    const redundant = occurrences >= 2;
    const isAuthConfig =
      AUTH_CHAIN.test(match.methodChain) || CONFIG_CHAIN.test(match.methodChain);

    // Must meet at least one trigger condition.
    if (!inLoop && !hotPath && !redundant && !isAuthConfig) continue;

    // Calibration finding: pure parallel fan-out (Promise.all) without a
    // redundancy or hot-path signal is deliberate concurrent work, not a
    // cache miss. Only flag if another signal is present.
    if (match.frequency === "parallel" && !hotPath && !redundant && !isAuthConfig) continue;

    // Suppress startup-file calls that have no other signal — these are likely
    // one-time initialisation and are fine without caching.
    if (isStartupLike && !hotPath && !inLoop) continue;

    // ── Evidence ──────────────────────────────────────────────────────────────

    const evidence: string[] = [];
    if (inLoop) {
      evidence.push(
        `Call executes in a "${match.frequency}" context — result not cached across iterations.`
      );
    }
    if (hotPath) {
      evidence.push(
        match.isMiddleware
          ? "Call is inside middleware and runs on every request."
          : "Call appears in a hot-path route or handler file."
      );
    }
    if (redundant) {
      evidence.push(
        `Same method chain (${match.methodChain}) occurs ${occurrences}× in this file without visible dedup.`
      );
    }
    if (isAuthConfig) {
      evidence.push(
        "Auth or config lookup could be memoized or hoisted to startup."
      );
    }

    // ── Scoring ───────────────────────────────────────────────────────────────
    // Calibration notes:
    //  - "polling" skipped entirely (see above)
    //  - "parallel" alone is not a cache miss; score it lower than a true loop
    //  - redundancy-only findings (no loop, no hot-path) get a lower base

    let score = 1;
    if (match.frequency === "unbounded-loop") score += 3;
    else if (match.frequency === "bounded-loop") score += 2;
    else if (match.frequency === "parallel") score += 1; // deliberate fan-out; lower urgency
    // Contextual bonuses.
    if (hotPath) score += 1;
    if (redundant) score += 1;
    if (isAuthConfig) score += 1;
    // Penalties.
    if (isTestLike || isStartupLike) score -= 1;

    // ── Confidence ────────────────────────────────────────────────────────────

    let confidence = 0.48 + Math.min(score, 5) * 0.07;
    if (match.cacheCapable) confidence += 0.08; // registry confirms this is cacheable
    if (isTestLike || isStartupLike) confidence -= 0.10;
    confidence = clamp(confidence);

    if (confidence < 0.35) continue;

    findings.push({
      id: `local-cache-${filePath}:${match.line}`,
      type: "cache" as SuggestionType,
      severity: scoreToSeverity(score),
      confidence,
      description:
        "Read-like API call appears without nearby caching or request-dedup safeguards.",
      affectedFile: filePath,
      line: match.line,
      evidence,
    });
  }

  return dedupeFindings(findings);
}
