import path from "path";
import type { ApiCallMatch } from "./patterns/types";
import { getLoopDepth, matchNormalizedLine } from "./patterns";
import type { Severity, SuggestionType } from "../analysis/types";
import type { FrequencyClass } from "../ast/frequency-analyzer";

const HTTP_CALL_HINT =
  /\b(fetch|axios|got|superagent|ky|requests|http\.|\$http|openai|responses|completions|embeddings|moderations|vector_stores|vectorStores|assistants|threads|realtime|uploads|batches|containers|skills|videos|evals|images|audio|files|models|anthropic|claude|gemini|genai|bedrock|vertex|cohere|mistral|stripe|graphql|apollo|urql|relay|supabase|firebase|trpc|grpc)\b/i;

const CACHE_GUARD = /\b(cache|memo|memoize|singleflight|dedupe|deduping|swr|react-query|queryClient|staleTime|ttl|etag|cache-control|cacheControl|persistedQuery|revalidate)\b/i;
const BATCH_GUARD = /\b(batch|batches|bulk|chunk|upsert|messageBatches|message_batches|flushQueue|enqueue)\b/i;
const CONCURRENCY_GUARD = /\b(p-limit|bottleneck|semaphore|mutex|queue|throttle|debounce|concurrency\s*:|limit\s*:|pool)\b/i;
const RETRY_GUARD = /\b(backoff|jitter|retryAfter|exponential|sleep\(|delay\(|retryDelay)\b/i;
const IDEMPOTENCY_GUARD = /\b(idempotency|idempotencyKey|requestId|correlationId|dedupeKey|uniqueKey)\b/i;
const EXPLICIT_GUARD = /\b(devOnly|NODE_ENV|featureFlag|maxItems|maxBatch|cap|guard|unsubscribe|teardown|cleanup)\b/i;
const HOT_PATH_PATTERN = /\b(router|app)\.(get|post|put|patch|delete)\(|@[\w.]+\.(get|post|put|patch|delete)\(|webhook|cron|schedule|queue|worker|useEffect|loader|action|onSnapshot|onValue|subscribe|requestSubscription|refetchInterval|setInterval\(/i;
const POLLING_PATTERN = /\b(setInterval|poll|polling|refetchInterval)\b/i;
const PROMISE_ALL_PATTERN = /\bPromise\.all(?:Settled)?\b/i;
const MAP_FANOUT_PATTERN = /\b(map|forEach|flatMap|reduce)\s*\(/i;
const ARRAY_FANOUT_PATTERN = /\bArray\.from\(\{\s*length\s*:\s*(\d+|[A-Za-z_]\w*)/i;
const RETRY_PATTERN = /\b(retry|attempt|retries|retrying)\b/i;
const AUTH_LOOKUP_PATTERN = /\b(getUser|getSession|auth\.|authorization|accessToken|session|refreshSession)\b/i;
const CONFIG_LOOKUP_PATTERN = /\b(getConfig|loadConfig|config\.|process\.env|featureFlag|flagClient|secret)\b/i;
const CLIENT_INIT_PATTERN = /new\s+(OpenAI|Anthropic|CohereClient|Mistral|Stripe|VertexAI|GoogleGenAI|Agent|ApolloClient|QueryClient)\s*\(/g;
const TEST_FILE_PATTERN = /(^|\/)(test|tests|spec|stories|storybook|fixtures?|examples?)\//i;
const STARTUP_FILE_PATTERN = /(^|\/)(scripts|bin|migrations?|seed|bootstrap|cli)\//i;
const SMALL_BOUNDED_PATTERN = /\b(length\s*:\s*[1-5]\b|<\s*[1-5]\b|slice\(\s*0\s*,\s*[1-5]\s*\))\b/i;
const JS_TS_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

const CACHE_TYPES = new Set(["query", "select", "get", "retrieve", "list", "content", "download"]);
const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const READ_METHODS = new Set(["GET"]);

export interface LocalWasteFinding {
  id: string;
  type: SuggestionType;
  severity: Severity;
  confidence: number;
  /** Structural risk score from the detector (pre-cost). Feeds deriveSeverity(); the
   *  `severity` field is now provisional/structural and overridden at Suggestion build. */
  riskScore: number;
  description: string;
  affectedFile: string;
  line?: number;
  evidence: string[];
}

interface MatchedCallSite {
  line: number;
  match: ApiCallMatch;
  windowText: string;
  loopDepth: number;
  promiseAll: boolean;
  mapFanout: boolean;
  arrayFanout: boolean;
  hotPath: boolean;
  polling: boolean;
  retryNearby: boolean;
  cacheGuard: boolean;
  batchGuard: boolean;
  concurrencyGuard: boolean;
  retryGuard: boolean;
  idempotencyGuard: boolean;
  explicitGuard: boolean;
  authLookup: boolean;
  configLookup: boolean;
  smallBounded: boolean;
  repeatedResourceCount: number;
  isRead: boolean;
  isWrite: boolean;
  isSubscription: boolean;
  isTestLike: boolean;
  isStartupLike: boolean;
}

function clampConfidence(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return Number(value.toFixed(2));
}

function buildResourceKey(match: ApiCallMatch): string {
  return [
    match.provider ?? "unknown",
    match.resource ?? match.endpoint ?? "unknown",
    match.action ?? "",
    match.method ?? "",
  ].join("|");
}

function classifyCallKind(match: ApiCallMatch): Pick<MatchedCallSite, "isRead" | "isWrite" | "isSubscription"> {
  const method = (match.method ?? "").toUpperCase();
  const action = (match.action ?? "").toLowerCase();
  const isSubscription = method === "SUBSCRIBE" || Boolean(match.streaming) || /subscription|listener/.test(action);
  if (isSubscription) {
    return { isRead: false, isWrite: false, isSubscription: true };
  }
  const isRead =
    READ_METHODS.has(method) ||
    CACHE_TYPES.has(action) ||
    Boolean(match.cacheCapable && !WRITE_METHODS.has(method));
  const isWrite =
    WRITE_METHODS.has(method) ||
    /create|insert|update|delete|submit|mutat|upload|stream|run|send/.test(action);
  return { isRead, isWrite, isSubscription: false };
}

function getWindow(lines: string[], lineIndex: number, radius = 8): string {
  const start = Math.max(0, lineIndex - radius);
  const end = Math.min(lines.length, lineIndex + radius + 1);
  return lines.slice(start, end).join("\n");
}

// #112: guard regexes (CACHE_GUARD/BATCH_GUARD/...) must not be tripped by the
// bare words "cache"/"batch" appearing in comments. Strip line + block comments
// before testing guards; all other signals keep using the raw window text.
function stripComments(windowText: string): string {
  return windowText
    .replace(/\/\*[\s\S]*?\*\//g, " ")   // block comments
    .replace(/(?<![:/])\/\/[^\n]*/g, " ")  // // line comments, not https://
    .replace(/(^|\s)#[^\n]*/g, "$1 ");    // # line comments (python)
}

function extractCallSites(relativePath: string, lines: string[]): MatchedCallSite[] {
  const rawMatches: Array<{ line: number; match: ApiCallMatch }> = [];
  const seen = new Set<string>();

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    let matches = matchNormalizedLine(line);
    if (matches.length === 0 && HTTP_CALL_HINT.test(line)) {
      const multiLine = lines.slice(lineIndex, Math.min(lines.length, lineIndex + 6)).join("\n");
      matches = matchNormalizedLine(multiLine);
    }

    for (const match of matches) {
      const key = `${lineIndex}:${match.provider ?? ""}:${match.endpoint ?? ""}:${match.action ?? ""}:${match.rawMatch ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rawMatches.push({ line: lineIndex + 1, match });
    }
  }

  const countByResource = new Map<string, number>();
  for (const candidate of rawMatches) {
    const key = buildResourceKey(candidate.match);
    countByResource.set(key, (countByResource.get(key) ?? 0) + 1);
  }

  return rawMatches.map(({ line, match }) => {
    const windowText = getWindow(lines, line - 1);
    const guardWindowText = stripComments(windowText);
    const callKind = classifyCallKind(match);
    return {
      line,
      match,
      windowText,
      loopDepth: getLoopDepth(lines, line - 1),
      promiseAll: PROMISE_ALL_PATTERN.test(windowText),
      mapFanout: MAP_FANOUT_PATTERN.test(windowText),
      arrayFanout: ARRAY_FANOUT_PATTERN.test(windowText),
      hotPath: HOT_PATH_PATTERN.test(windowText) || /(^|\/)(api|routes?|handlers?|pages|app)\//i.test(relativePath),
      polling: POLLING_PATTERN.test(windowText),
      retryNearby: RETRY_PATTERN.test(windowText),
      cacheGuard: CACHE_GUARD.test(guardWindowText),
      batchGuard: BATCH_GUARD.test(guardWindowText),
      concurrencyGuard: CONCURRENCY_GUARD.test(guardWindowText),
      retryGuard: RETRY_GUARD.test(guardWindowText),
      idempotencyGuard: IDEMPOTENCY_GUARD.test(guardWindowText),
      explicitGuard: EXPLICIT_GUARD.test(guardWindowText),
      authLookup: AUTH_LOOKUP_PATTERN.test(windowText),
      configLookup: CONFIG_LOOKUP_PATTERN.test(windowText),
      smallBounded: SMALL_BOUNDED_PATTERN.test(windowText),
      repeatedResourceCount: countByResource.get(buildResourceKey(match)) ?? 1,
      isTestLike: TEST_FILE_PATTERN.test(relativePath),
      isStartupLike: STARTUP_FILE_PATTERN.test(relativePath),
      ...callKind,
    };
  });
}

/**
 * Derive a FrequencyClass from a regex-based MatchedCallSite (no AST available).
 * Used to enrich severity scoring with frequency semantics.
 */
function siteFrequencyClass(site: MatchedCallSite): FrequencyClass {
  if (site.polling) return "polling";
  if (site.promiseAll) return "parallel";
  if (site.loopDepth > 1) return "unbounded-loop";
  if (site.loopDepth === 1 || site.mapFanout || site.arrayFanout) return "bounded-loop";
  if (site.cacheGuard) return "cache-guarded";
  return "single";
}

function baseScore(site: MatchedCallSite): number {
  let score = 1;
  const fc = siteFrequencyClass(site);
  // Frequency-aware base scoring
  if (fc === "polling") score += 4;          // timer loops run indefinitely
  else if (fc === "parallel") score += 2;    // Promise.all fan-out
  else if (fc === "unbounded-loop") score += 3;
  else if (fc === "bounded-loop") score += 2;
  // Legacy depth-based adjustments (kept for overlap cases like nested loops)
  if (site.loopDepth > 1) score += 1;
  if (site.hotPath) score += 1;
  if (site.repeatedResourceCount >= 2) score += 1;
  if (site.retryNearby && !site.retryGuard) score += 1;
  if (site.isSubscription) score += 1;
  if (site.smallBounded) score -= 1;
  if (site.explicitGuard) score -= 1;
  if (site.isTestLike || site.isStartupLike) score -= 1;
  return score;
}

function scoreToSeverity(score: number): Severity {
  if (score >= 5) return "high";
  if (score >= 3) return "medium";
  return "low";
}

function scoreToConfidence(score: number, site: MatchedCallSite, matchedCapability = false): number {
  let confidence = 0.48;
  confidence += Math.min(score, 5) * 0.07;
  if (matchedCapability) confidence += 0.08;
  if (site.cacheGuard || site.batchGuard || site.concurrencyGuard || site.retryGuard || site.idempotencyGuard) confidence -= 0.18;
  if (site.smallBounded) confidence -= 0.1;
  if (site.isTestLike || site.isStartupLike) confidence -= 0.1;
  return clampConfidence(confidence);
}

function pushEvidence(evidence: string[], condition: boolean, message: string): void {
  if (condition) evidence.push(message);
}

function makeFinding(
  relativePath: string,
  line: number,
  type: SuggestionType,
  description: string,
  score: number,
  confidence: number,
  evidence: string[]
): LocalWasteFinding | null {
  if (confidence < 0.35) return null;
  return {
    id: `local-${type}-${relativePath}:${line}`,
    type,
    severity: scoreToSeverity(score),
    confidence,
    riskScore: score,
    description,
    affectedFile: relativePath,
    line,
    evidence,
  };
}

function detectCacheFinding(relativePath: string, site: MatchedCallSite): LocalWasteFinding | null {
  const ext = path.extname(relativePath).toLowerCase();
  if (!JS_TS_EXTENSIONS.has(ext)) return null;
  if (!site.isRead || site.cacheGuard) return null;
  const queryWithoutPersisted = site.match.kind === "graphql" && !!site.match.inferredCostRisk?.includes("missing-persisted-query-hint");
  const repeatedLookup = site.authLookup || site.configLookup || site.repeatedResourceCount >= 2;
  if (!queryWithoutPersisted && !repeatedLookup && !site.hotPath && site.loopDepth === 0) return null;

  const evidence: string[] = [];
  pushEvidence(evidence, site.repeatedResourceCount >= 2, "Repeated reads hit the same provider/resource in this file.");
  pushEvidence(evidence, site.authLookup, "Auth/session lookup is near the outbound call.");
  pushEvidence(evidence, site.configLookup, "Config or feature-flag lookup is near the outbound call.");
  pushEvidence(evidence, site.hotPath, "Call appears inside a request/effect/subscription hot path.");
  pushEvidence(evidence, queryWithoutPersisted, "GraphQL query does not show persisted-query caching hints.");
  const score = baseScore(site) + (site.hotPath ? 1 : 0) + (queryWithoutPersisted ? 1 : 0) - (site.isWrite ? 2 : 0);
  const confidence = scoreToConfidence(score, site, Boolean(site.match.cacheCapable || queryWithoutPersisted || site.isRead));
  return makeFinding(
    relativePath,
    site.line,
    "cache",
    "Repeated read-like API work appears without nearby caching or request dedupe safeguards.",
    score,
    confidence,
    evidence
  );
}

function detectBatchFinding(relativePath: string, site: MatchedCallSite): LocalWasteFinding | null {
  const ext = path.extname(relativePath).toLowerCase();
  if (!JS_TS_EXTENSIONS.has(ext)) return null;
  const batchCapableHint =
    Boolean(site.match.batchCapable) ||
    /embed|embedding|responses|messages|generatecontent|select|query/i.test(site.match.action ?? "");
  if (site.batchGuard || !batchCapableHint) return null;
  if (!(site.loopDepth > 0 || site.promiseAll || site.mapFanout || site.repeatedResourceCount >= 3)) return null;

  const evidence: string[] = [];
  pushEvidence(evidence, site.loopDepth > 0, "Call executes inside a loop.");
  pushEvidence(evidence, site.promiseAll || site.mapFanout, "Parallel collection fanout is nearby.");
  pushEvidence(evidence, site.repeatedResourceCount >= 3, "The same provider/resource is called repeatedly.");
  const score = baseScore(site) + 1 - (site.smallBounded ? 1 : 0) - (site.isWrite ? 1 : 0);
  const confidence = scoreToConfidence(score, site, batchCapableHint);
  return makeFinding(
    relativePath,
    site.line,
    "batch",
    "Repeated batch-capable API work appears inside loop or fanout code without visible bulk/batch handling.",
    score,
    confidence,
    evidence
  );
}

// Inline-parallel: the endpoint itself accepts an n/count parameter (a
// registry-only signal, e.g. DALL·E `images.generate`), so fanning out one
// request per item is wasteful. Mirrors the AST inline-parallel detector for
// the regex-only path (RECOST_DISABLE_AST=1). Distinct from `detectBatchFinding`
// — uses an `inline_parallel` id so it never collapses with a batch finding.
function detectInlineParallelFinding(relativePath: string, site: MatchedCallSite): LocalWasteFinding | null {
  const ext = path.extname(relativePath).toLowerCase();
  if (!JS_TS_EXTENSIONS.has(ext)) return null;
  if (!site.match.inlineParallelCapable) return null;
  if (site.batchGuard) return null;
  if (!(site.loopDepth > 0 || site.promiseAll || site.mapFanout || site.arrayFanout)) return null;

  const evidence: string[] = [];
  pushEvidence(evidence, site.loopDepth > 0, "Call executes inside a loop.");
  pushEvidence(
    evidence,
    site.promiseAll || site.mapFanout || site.arrayFanout,
    "Parallel collection fanout issues one request per item."
  );
  evidence.push("This endpoint accepts an n/count parameter that returns multiple results from a single request.");
  const score = baseScore(site) + 1 - (site.smallBounded ? 1 : 0);
  const confidence = scoreToConfidence(score, site, true);
  if (confidence < 0.35) return null;
  return {
    id: `local-inline_parallel-${relativePath}:${site.line}`,
    type: "unbatched_parallel" as SuggestionType,
    severity: scoreToSeverity(score),
    confidence,
    riskScore: score,
    description:
      "This endpoint accepts an n/count parameter — request multiple results in a single call instead of issuing one request per item.",
    affectedFile: relativePath,
    line: site.line,
    evidence,
  };
}

function detectRedundancyFinding(relativePath: string, site: MatchedCallSite, clientInitCount: number): LocalWasteFinding | null {
  const ext = path.extname(relativePath).toLowerCase();
  if (!JS_TS_EXTENSIONS.has(ext)) return null;
  const repeatedLookup = site.authLookup || site.configLookup;
  const clientChurn = clientInitCount >= 2 && site.hotPath;
  if (!repeatedLookup && !clientChurn && site.repeatedResourceCount < 3) return null;
  if (site.cacheGuard && site.repeatedResourceCount < 3 && !repeatedLookup) return null;

  const evidence: string[] = [];
  pushEvidence(evidence, repeatedLookup, "Auth/session/config work is repeated near outbound calls.");
  pushEvidence(evidence, clientChurn, "Multiple SDK or transport client initializations appear in a hot path.");
  pushEvidence(evidence, site.repeatedResourceCount >= 3, "The same provider/resource appears multiple times in one file.");
  const score = baseScore(site) + (clientChurn ? 1 : 0);
  const confidence = scoreToConfidence(score, site, repeatedLookup || clientChurn);
  return makeFinding(
    relativePath,
    site.line,
    "redundancy",
    "Repeated lookup or client setup work appears near outbound API calls and is likely causing avoidable duplicate effort.",
    score,
    confidence,
    evidence
  );
}

function detectNPlusOneFinding(relativePath: string, site: MatchedCallSite): LocalWasteFinding | null {
  const ext = path.extname(relativePath).toLowerCase();
  if (!JS_TS_EXTENSIONS.has(ext)) return null;
  if (site.batchGuard || site.concurrencyGuard) return null;
  if (!(site.loopDepth > 0 || (site.promiseAll && site.mapFanout))) return null;

  const evidence: string[] = [];
  pushEvidence(evidence, site.loopDepth > 0, "Outbound call occurs inside a loop.");
  pushEvidence(evidence, site.loopDepth > 1, "Nested loop context increases fanout risk.");
  pushEvidence(evidence, site.promiseAll && site.mapFanout, "Promise.all fanout over a collection is nearby.");
  pushEvidence(evidence, site.hotPath, "The fanout appears on a hot path.");
  const score = baseScore(site) + 1;
  const confidence = scoreToConfidence(score, site, true);
  return makeFinding(
    relativePath,
    site.line,
    "n_plus_one",
    "Loop-driven outbound API work appears likely to scale linearly with collection size.",
    score,
    confidence,
    evidence
  );
}

function detectRateLimitFinding(relativePath: string, site: MatchedCallSite): LocalWasteFinding | null {
  const ext = path.extname(relativePath).toLowerCase();
  if (!JS_TS_EXTENSIONS.has(ext)) return null;
  if (site.retryGuard && site.concurrencyGuard && !site.polling) return null;
  const bursty = site.polling || site.retryNearby || (site.hotPath && (site.promiseAll || site.mapFanout)) || site.isSubscription;
  if (!bursty) return null;

  const evidence: string[] = [];
  pushEvidence(evidence, site.polling, "Polling or timer-driven behavior is near the call.");
  pushEvidence(evidence, site.retryNearby, "Retry logic is near the call.");
  pushEvidence(evidence, site.isWrite, "Write-like operations are more sensitive to duplicate retries.");
  pushEvidence(evidence, site.isSubscription, "Subscription/listener patterns can multiply live traffic.");
  pushEvidence(evidence, site.retryGuard, "Backoff or retry pacing was detected, reducing confidence.");
  const score = baseScore(site) + (site.isWrite ? 1 : 0) + (site.polling ? 1 : 0) - (site.retryGuard ? 1 : 0) - (site.concurrencyGuard ? 1 : 0);
  const confidence = scoreToConfidence(score, site, bursty);
  return makeFinding(
    relativePath,
    site.line,
    "rate_limit",
    "Traffic amplification patterns suggest burst or retry behavior that may trigger provider rate limits.",
    score,
    confidence,
    evidence
  );
}

function detectConcurrencyFinding(relativePath: string, site: MatchedCallSite): LocalWasteFinding | null {
  const ext = path.extname(relativePath).toLowerCase();
  if (!JS_TS_EXTENSIONS.has(ext)) return null;
  if (site.concurrencyGuard) return null;
  const uncontrolled =
    (site.promiseAll && (site.mapFanout || site.arrayFanout || site.loopDepth > 0)) ||
    (site.isSubscription && site.repeatedResourceCount >= 2) ||
    (site.polling && site.hotPath);
  if (!uncontrolled) return null;

  const evidence: string[] = [];
  pushEvidence(evidence, site.promiseAll, "Promise.all is used near the outbound call.");
  pushEvidence(evidence, site.mapFanout || site.arrayFanout, "Collection fanout appears uncontrolled.");
  pushEvidence(evidence, site.isSubscription, "Listener/subscription registration can multiply concurrency.");
  pushEvidence(evidence, site.polling && site.hotPath, "Polling occurs on a hot path without visible concurrency controls.");
  const score = baseScore(site) + 1;
  const confidence = scoreToConfidence(score, site, true);
  return makeFinding(
    relativePath,
    site.line,
    "concurrency_control",
    "Outbound work appears to fan out without visible concurrency limits or queueing safeguards.",
    score,
    confidence,
    evidence
  );
}

function dedupeFindings(findings: Array<LocalWasteFinding | null>): LocalWasteFinding[] {
  const deduped = new Map<string, LocalWasteFinding>();
  for (const finding of findings) {
    if (!finding) continue;
    // Key on the detector-specific id so distinct detectors at the same site
    // stay separate — batch (`local-batch-…`) emits type "batch"; inline-parallel
    // (`local-inline_parallel-…`) now emits type "unbatched_parallel" and is
    // keyed on its own id, so it never collapses with a batch finding.
    // Fall back to type:file:line if an id is missing.
    const key = finding.id || `${finding.type}:${finding.affectedFile}:${finding.line ?? 0}`;
    const existing = deduped.get(key);
    if (!existing || finding.confidence > existing.confidence) {
      deduped.set(key, finding);
    }
  }
  return [...deduped.values()];
}

export function detectLocalWasteFindingsInText(relativePath: string, text: string): LocalWasteFinding[] {
  const lines = text.split("\n");
  const callSites = extractCallSites(relativePath, lines);
  const clientInitCount = (text.match(CLIENT_INIT_PATTERN) ?? []).length;
  const findings: Array<LocalWasteFinding | null> = [];

  for (const site of callSites) {
    findings.push(detectCacheFinding(relativePath, site));
    findings.push(detectBatchFinding(relativePath, site));
    findings.push(detectInlineParallelFinding(relativePath, site));
    findings.push(detectRedundancyFinding(relativePath, site, clientInitCount));
    findings.push(detectNPlusOneFinding(relativePath, site));
    findings.push(detectRateLimitFinding(relativePath, site));
    findings.push(detectConcurrencyFinding(relativePath, site));
  }

  return dedupeFindings(findings);
}
