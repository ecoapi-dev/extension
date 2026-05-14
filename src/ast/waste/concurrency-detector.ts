/**
 * ast/waste/concurrency-detector.ts — AST-based rate-limit and concurrency detector.
 *
 * Rebuilds rate-limit risk and concurrency waste detection from
 * local-waste-detector.ts on top of the structural frequency and registry data
 * produced by the Phase 2 AST scanner.
 *
 * Key improvements over the regex approach:
 *  - Polling detection uses AST-derived FrequencyClass ("polling") — no false
 *    positives from comments or variable names containing "setInterval"
 *  - Unbounded concurrency detected structurally via frequency === "parallel"
 *  - Retry storm detection uses source window + AST frequency context
 *  - Event amplification detects high-frequency DOM/Node events near API calls
 *  - Guard detection (backoff, concurrency limiters) uses source text windows
 *
 * Waste types produced:
 *  - "rate_limit"         — polling without backoff, retry storm, event amplification
 *  - "concurrency_control"— unbounded parallel fan-out without a limiter
 */
import type { AstCallMatch } from "../ast-scanner";
import type { LocalWasteFinding } from "../../scanner/local-waste-detector";
import type { Severity, SuggestionType } from "../../analysis/types";

// ── Guard patterns (source text window ±8 lines) ─────────────────────────────

/** Exponential backoff / retry pacing signals. */
const BACKOFF_GUARD =
  /\b(backoff|jitter|retryAfter|exponential|sleep\s*\(|delay\s*\(|retryDelay|retryAfterMs)\b/i;

/** Concurrency limiters / throttles that protect fan-out. */
const CONCURRENCY_GUARD =
  /\b(p-limit|bottleneck|semaphore|mutex|throttle|debounce|concurrency\s*:|limit\s*:|pool)\b/i;

/** Retry / attempt patterns in surrounding code. */
const RETRY_PATTERN =
  /\b(retry|attempt|retries|retrying|onRetry|maxRetries|maxAttempts)\b/i;

/** High-frequency DOM / Node.js event names that can fire many times per second. */
const HIGH_FREQ_EVENT =
  /\b(scroll|input|keydown|keyup|keypress|mousemove|touchmove|resize|pointermove|wheel|dragover|message|data|chunk)\b/i;

/**
 * Event listener registration patterns.
 * Note: no trailing \b — patterns ending in \( are non-word chars, so a
 * trailing word-boundary anchor would never match.
 */
const EVENT_LISTENER =
  /\b(addEventListener|addListener|EventEmitter|useEffect|fromEvent)\s*\(|\.on\s*\(/i;

// ── File-path heuristics ──────────────────────────────────────────────────────

const TEST_FILE = /(^|\/)(test|tests|spec|stories|storybook|fixtures?|examples?)\//i;
const STARTUP_FILE = /(^|\/)(scripts?|bin|migrations?|seed|bootstrap|cli|init)\//i;
const HOT_PATH_FILE = /(^|\/)(api|routes?|handlers?|pages|app|server|controllers?)\//i;

// ── Helpers ───────────────────────────────────────────────────────────────────

function clamp(v: number): number {
  return Number(Math.max(0, Math.min(1, v)).toFixed(2));
}

function scoreToSeverity(score: number): Severity {
  if (score >= 5) return "high";
  if (score >= 3) return "medium";
  return "low";
}

function windowText(source: string, line: number, radius = 8): string {
  if (!source) return "";
  const lines = source.split("\n");
  const idx = line - 1;
  return lines.slice(Math.max(0, idx - radius), Math.min(lines.length, idx + radius + 1)).join("\n");
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

// ── 1. Polling without backoff ────────────────────────────────────────────────

function detectPolling(
  match: AstCallMatch,
  source: string,
  filePath: string,
  isTestLike: boolean
): LocalWasteFinding | null {
  if (match.frequency !== "polling") return null;

  const win = windowText(source, match.line);
  const hasBackoff = BACKOFF_GUARD.test(win);
  const hasConcurrency = CONCURRENCY_GUARD.test(win);

  if (hasBackoff && hasConcurrency) return null; // fully guarded

  const evidence: string[] = [
    "Call executes inside a timer-driven polling context (setInterval / setImmediate).",
  ];
  if (!hasBackoff) {
    evidence.push("No exponential backoff or jitter detected — failures can cause retry storms.");
  }
  if (!hasConcurrency) {
    evidence.push("No concurrency control detected — overlapping timer ticks can fan out requests.");
  }
  if (match.isMiddleware) {
    evidence.push("Polling occurs inside middleware, multiplying per-request cost.");
  }

  let score = 4; // polling is inherently high-risk
  if (!hasBackoff) score += 1;
  if (!hasConcurrency) score += 1;
  if (match.isMiddleware) score += 1;
  if (hasBackoff) score -= 1;
  if (hasConcurrency) score -= 1;
  if (isTestLike) score -= 1;

  let confidence = 0.55 + Math.min(score, 5) * 0.06;
  if (hasBackoff) confidence -= 0.12;
  if (hasConcurrency) confidence -= 0.08;
  if (isTestLike) confidence -= 0.10;
  confidence = clamp(confidence);
  if (confidence < 0.35) return null;

  return {
    id: `local-rate_limit-poll-${filePath}:${match.line}`,
    type: "rate_limit" as SuggestionType,
    severity: scoreToSeverity(score),
    confidence,
    description:
      "API call inside a polling timer without exponential backoff risks hitting provider rate limits.",
    affectedFile: filePath,
    line: match.line,
    evidence,
  };
}

// ── 2. Unbounded concurrency (Promise.all fan-out) ────────────────────────────

function detectUnboundedConcurrency(
  match: AstCallMatch,
  source: string,
  filePath: string,
  isTestLike: boolean,
  isHotPath: boolean
): LocalWasteFinding | null {
  if (match.frequency !== "parallel") return null;
  if (match.batchCapable === true) return null; // let batch detector handle it

  const win = windowText(source, match.line);
  if (CONCURRENCY_GUARD.test(win)) return null;

  const evidence: string[] = [
    "Call executes inside a Promise.all / Promise.allSettled fan-out with no concurrency limiter.",
    "If the input array is large, this can fire many simultaneous requests and trigger rate limits.",
  ];
  if (isHotPath) {
    evidence.push("Fan-out occurs on a hot path — each request can spawn many parallel API calls.");
  }

  let score = 3;
  if (isHotPath) score += 1;
  if (isTestLike) score -= 1;

  let confidence = 0.50 + Math.min(score, 5) * 0.07;
  if (isTestLike) confidence -= 0.10;
  confidence = clamp(confidence);
  if (confidence < 0.35) return null;

  return {
    id: `local-concurrency_control-${filePath}:${match.line}`,
    type: "concurrency_control" as SuggestionType,
    severity: scoreToSeverity(score),
    confidence,
    description:
      "Unbounded parallel API fan-out without a concurrency limiter risks saturating provider rate limits.",
    affectedFile: filePath,
    line: match.line,
    evidence,
  };
}

// ── 3. Retry storm ────────────────────────────────────────────────────────────

function detectRetryStorm(
  match: AstCallMatch,
  source: string,
  filePath: string,
  isTestLike: boolean
): LocalWasteFinding | null {
  // Only flag non-polling calls — polling is handled separately above.
  if (match.frequency === "polling") return null;

  const win = windowText(source, match.line);
  if (!RETRY_PATTERN.test(win)) return null;       // no retry logic nearby
  if (BACKOFF_GUARD.test(win)) return null;         // backoff already present
  if (CONCURRENCY_GUARD.test(win)) return null;     // concurrency guard present

  const evidence: string[] = [
    "Retry logic detected near the API call without exponential backoff or delay.",
    "Immediate retries on failure can cause burst traffic that worsens rate limit errors.",
  ];
  if (match.isMiddleware) {
    evidence.push("Retry is inside middleware — affects every request.");
  }

  let score = 3;
  if (match.loopContext) score += 1; // retry inside a loop is worse
  if (match.isMiddleware) score += 1;
  if (isTestLike) score -= 1;

  let confidence = 0.48 + Math.min(score, 5) * 0.07;
  if (isTestLike) confidence -= 0.10;
  confidence = clamp(confidence);
  if (confidence < 0.35) return null;

  return {
    id: `local-rate_limit-retry-${filePath}:${match.line}`,
    type: "rate_limit" as SuggestionType,
    severity: scoreToSeverity(score),
    confidence,
    description:
      "Retry logic near an API call lacks backoff — immediate retries can cascade into a rate limit storm.",
    affectedFile: filePath,
    line: match.line,
    evidence,
  };
}

// ── 4. Event amplification ────────────────────────────────────────────────────

function detectEventAmplification(
  match: AstCallMatch,
  source: string,
  filePath: string,
  isTestLike: boolean
): LocalWasteFinding | null {
  // Look for high-frequency event listeners in the window around the call.
  const win = windowText(source, match.line);
  if (!EVENT_LISTENER.test(win)) return null;
  if (!HIGH_FREQ_EVENT.test(win)) return null;
  if (CONCURRENCY_GUARD.test(win)) return null; // debounce/throttle already present

  const evidence: string[] = [
    "API call appears near a high-frequency event listener (scroll, input, mousemove, etc.).",
    "Without debouncing or throttling, every event fires an API request.",
  ];
  if (match.streaming) {
    evidence.push("Streaming / subscription call inside an event handler multiplies active connections.");
  }

  let score = 3;
  if (match.streaming) score += 1;
  if (isTestLike) score -= 1;

  let confidence = 0.46 + Math.min(score, 5) * 0.07;
  if (isTestLike) confidence -= 0.10;
  confidence = clamp(confidence);
  if (confidence < 0.35) return null;

  return {
    id: `local-rate_limit-event-${filePath}:${match.line}`,
    type: "rate_limit" as SuggestionType,
    severity: scoreToSeverity(score),
    confidence,
    description:
      "API call inside a high-frequency event handler without debouncing or throttling.",
    affectedFile: filePath,
    line: match.line,
    evidence,
  };
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Detect rate-limit and concurrency waste in a set of AST call matches.
 *
 * @param matches  - Output of `scanSourceWithAst()` for a single file.
 * @param source   - Raw source text (used for guard and pattern window scans).
 * @param filePath - Relative or absolute file path.
 * @returns        - `LocalWasteFinding[]` with type "rate_limit" or
 *                   "concurrency_control".
 */
export function detectConcurrencyWaste(
  matches: AstCallMatch[],
  source: string,
  filePath: string
): LocalWasteFinding[] {
  const isTestLike = TEST_FILE.test(filePath);
  const isStartupLike = STARTUP_FILE.test(filePath);
  const isHotPath = HOT_PATH_FILE.test(filePath);

  const findings: LocalWasteFinding[] = [];

  for (const match of matches) {
    if (isStartupLike && match.frequency === "single" && !match.loopContext) continue;

    const pollingFinding = detectPolling(match, source, filePath, isTestLike);
    if (pollingFinding) findings.push(pollingFinding);

    const concFinding = detectUnboundedConcurrency(match, source, filePath, isTestLike, isHotPath);
    if (concFinding) findings.push(concFinding);

    const retryFinding = detectRetryStorm(match, source, filePath, isTestLike);
    if (retryFinding) findings.push(retryFinding);

    const eventFinding = detectEventAmplification(match, source, filePath, isTestLike);
    if (eventFinding) findings.push(eventFinding);
  }

  return dedupeFindings(findings);
}
