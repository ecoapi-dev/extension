import type { SuggestionType } from "../analysis/types";
import type {
  ApiCallNode,
  FileScores,
  FindingNode,
  ProviderNode,
  RepoIntelligenceSnapshot,
  ScoredFile,
  ScoredSnapshot,
} from "./types";
import { isDeprioritizedContextFilePath, isTestLikeFilePath } from "./file-signals";
import { isRecostFixtureFile } from "../scanner/file-discovery";
import { collectRealProviders } from "./provider-normalization";

const HIGH_FREQUENCY_CLASSES = new Set(["unbounded-loop", "parallel", "polling"]);
const RELIABILITY_FINDING_TYPES = new Set(["rate_limit", "concurrency_control"]);
const COST_LEAK_FINDING_TYPES = new Set(["cache", "batch", "unbatched_parallel", "n_plus_one", "redundancy"]);
const SEVERITY_WEIGHT: Record<FindingNode["severity"], number> = { high: 3, medium: 2, low: 1 };
const FREQUENCY_COST_WEIGHT: Record<string, number> = {
  "unbounded-loop": 3,
  parallel: 2,
  polling: 2,
  "bounded-loop": 1,
};
const HIGH_CONFIDENCE_THRESHOLD = 0.85;
const TEST_FILE_PRIORITY_MULTIPLIER = 0.05;
const CONTEXT_NOISE_FILE_PRIORITY_MULTIPLIER = 0.1;

let _includeTestFiles = false;
export function setIncludeTestFiles(value: boolean): void {
  _includeTestFiles = value;
}

interface RawScoreSignals {
  importance: number;
  costLeak: number;
  reliabilityRisk: number;
}

function roundScore(value: number): number {
  return Math.round(value * 10) / 10;
}

function normalizeScore(raw: number, max: number): number {
  if (max <= 0) return 0;
  return Math.min(10, Math.max(0, roundScore((raw / max) * 10)));
}

function getApiCalls(snapshot: RepoIntelligenceSnapshot, ids: string[]): ApiCallNode[] {
  return ids.map((id) => snapshot.apiCalls[id]).filter(Boolean);
}

function getFindings(snapshot: RepoIntelligenceSnapshot, ids: string[]): FindingNode[] {
  return ids.map((id) => snapshot.findings[id]).filter(Boolean);
}

function getHighFrequencyCallCount(calls: ApiCallNode[]): number {
  return calls.filter((call) => call.frequencyClass && HIGH_FREQUENCY_CLASSES.has(call.frequencyClass)).length;
}

function buildCallKey(call: ApiCallNode): string {
  return `${call.provider ?? "unknown"}|${call.method}|${call.url}`;
}

function getRepeatedCallCount(calls: ApiCallNode[]): number {
  const counts = new Map<string, number>();
  for (const call of calls) {
    const key = buildCallKey(call);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  let repeatedCallCount = 0;
  for (const count of counts.values()) {
    if (count >= 2) repeatedCallCount += count;
  }
  return repeatedCallCount;
}

function getFrequencyWeightTotal(calls: ApiCallNode[]): number {
  return calls.reduce((sum, call) => sum + (call.frequencyClass ? (FREQUENCY_COST_WEIGHT[call.frequencyClass] ?? 0) : 0), 0);
}

function countFindingsByType(findings: FindingNode[], type: SuggestionType): number {
  return findings.filter((finding) => finding.type === type).length;
}

function hasReliabilityFinding(findings: FindingNode[]): boolean {
  return findings.some((finding) => RELIABILITY_FINDING_TYPES.has(finding.type));
}

function computeRawSignals(snapshot: RepoIntelligenceSnapshot, fileId: string): RawScoreSignals {
  const file = snapshot.files[fileId];
  const calls = getApiCalls(snapshot, file.apiCallIds);
  const findings = getFindings(snapshot, file.findingIds);
  const realProviders = collectRealProviders(calls.map((call) => call.provider));
  const highFrequencyCallCount = getHighFrequencyCallCount(calls);
  const repeatedCallCount = getRepeatedCallCount(calls);
  const cacheFindingCount = countFindingsByType(findings, "cache");
  const uncachedCacheCapableCount = calls.filter((call) => call.cacheCapable).length > 0 && cacheFindingCount === 0
    ? calls.filter((call) => call.cacheCapable).length
    : 0;
  const costLeakFindingWeight = findings.reduce((sum, finding) => {
    if (!COST_LEAK_FINDING_TYPES.has(finding.type)) return sum;
    return sum + SEVERITY_WEIGHT[finding.severity];
  }, 0);
  const reliabilitySeverityWeight = findings.reduce((sum, finding) => sum + SEVERITY_WEIGHT[finding.severity], 0);
  const reliabilityFindingTypeWeight = findings.reduce((sum, finding) => {
    if (finding.type === "rate_limit") return sum + 3;
    if (finding.type === "concurrency_control") return sum + 3;
    return sum;
  }, 0);
  const highFrequencyWithoutEvidenceCount = hasReliabilityFinding(findings) ? 0 : highFrequencyCallCount;

  return {
    importance:
      calls.length * 2 +
      findings.length * 2 +
      realProviders.length * 1.5 +
      highFrequencyCallCount * 2,
    costLeak:
      getFrequencyWeightTotal(calls) +
      repeatedCallCount +
      uncachedCacheCapableCount * 2 +
      costLeakFindingWeight,
    reliabilityRisk:
      reliabilitySeverityWeight +
      reliabilityFindingTypeWeight +
      highFrequencyWithoutEvidenceCount * 2 +
      (findings.length >= 2 ? 2 : 0),
  };
}

function pushReason(reasons: string[], reason: string): void {
  if (!reason || reasons.includes(reason) || reasons.length >= 5) return;
  reasons.push(reason);
}

interface ReasonCandidate {
  reason: string;
  weight: number;
}

function buildReasons(snapshot: RepoIntelligenceSnapshot, fileId: string): string[] {
  const file = snapshot.files[fileId];
  const calls = getApiCalls(snapshot, file.apiCallIds);
  const findings = getFindings(snapshot, file.findingIds);
  const realProviders = collectRealProviders(calls.map((call) => call.provider));
  const reasons: string[] = [];
  const highFrequencyCallCount = getHighFrequencyCallCount(calls);
  const repeatedCallCount = getRepeatedCallCount(calls);
  const highSeverityFindingCount = findings.filter((finding) => finding.severity === "high").length;
  const reliabilityFindingCount = findings.filter((finding) => RELIABILITY_FINDING_TYPES.has(finding.type)).length;
  const cacheCapableWithoutCacheCount =
    countFindingsByType(findings, "cache") === 0 ? calls.filter((call) => call.cacheCapable).length : 0;
  const candidates: ReasonCandidate[] = [];

  if (calls.length > 0) {
    candidates.push({ reason: `${calls.length} API calls`, weight: calls.length });
  }
  if (highFrequencyCallCount > 0) {
    candidates.push({ reason: `${highFrequencyCallCount} high-frequency calls`, weight: highFrequencyCallCount + 3 });
  }
  if (realProviders.length > 1) {
    candidates.push({ reason: "Uses multiple providers", weight: 5 });
  } else if (realProviders.length === 1) {
    candidates.push({ reason: `Uses provider ${realProviders[0]}`, weight: 2 });
  }
  if (calls.some((call) => call.frequencyClass === "unbounded-loop")) {
    candidates.push({ reason: "Contains unbounded-loop traffic", weight: 6 });
  } else if (calls.some((call) => call.frequencyClass === "parallel")) {
    candidates.push({ reason: "Contains parallel traffic", weight: 5 });
  } else if (calls.some((call) => call.frequencyClass === "polling")) {
    candidates.push({ reason: "Contains polling traffic", weight: 5 });
  } else if (calls.some((call) => call.frequencyClass === "bounded-loop")) {
    candidates.push({ reason: "Contains bounded-loop traffic", weight: 3 });
  }
  if (highSeverityFindingCount > 0) {
    candidates.push({ reason: `${highSeverityFindingCount} high-severity findings`, weight: highSeverityFindingCount + 4 });
  } else if (findings.length > 0) {
    candidates.push({ reason: `${findings.length} findings`, weight: findings.length + 1 });
  }
  if (repeatedCallCount >= 2) {
    candidates.push({ reason: "Repeated API calls in one file", weight: repeatedCallCount + 2 });
  }
  if (cacheCapableWithoutCacheCount > 0) {
    candidates.push({
      reason: "Cache-capable calls without cache finding",
      weight: cacheCapableWithoutCacheCount + 2,
    });
  }
  if (reliabilityFindingCount > 0) {
    candidates.push({ reason: `${reliabilityFindingCount} reliability findings`, weight: reliabilityFindingCount + 2 });
  }
  if (findings.some((finding) => finding.confidence >= HIGH_CONFIDENCE_THRESHOLD)) {
    candidates.push({ reason: "Has high-confidence findings", weight: 2 });
  }

  candidates
    .sort((a, b) => b.weight - a.weight || a.reason.localeCompare(b.reason))
    .forEach((candidate) => pushReason(reasons, candidate.reason));

  return reasons;
}

function sortProviders(providers: ProviderNode[]): ProviderNode[] {
  return [...providers].sort((a, b) => {
    return (
      b.fileIds.length - a.fileIds.length ||
      b.apiCallIds.length - a.apiCallIds.length ||
      b.findingIds.length - a.findingIds.length ||
      a.name.localeCompare(b.name)
    );
  });
}

function sortFindings(findings: FindingNode[]): FindingNode[] {
  return [...findings].sort((a, b) => {
    const scoreA = SEVERITY_WEIGHT[a.severity] * a.confidence;
    const scoreB = SEVERITY_WEIGHT[b.severity] * b.confidence;
    return (
      scoreB - scoreA ||
      a.filePath.localeCompare(b.filePath) ||
      (a.line ?? 0) - (b.line ?? 0) ||
      a.id.localeCompare(b.id)
    );
  });
}

function computePriorityBonus(file: ScoredFile, findings: FindingNode[]): number {
  let bonus = 0;
  if (file.reasons.includes("Uses multiple providers")) bonus += 0.8;
  if (findings.some((finding) => finding.confidence >= HIGH_CONFIDENCE_THRESHOLD)) bonus += 0.7;
  return bonus;
}

export function scoreRepoIntelligence(snapshot: RepoIntelligenceSnapshot): ScoredSnapshot {
  const fileIds = Object.keys(snapshot.files).sort();
  const rawByFile = new Map<string, RawScoreSignals>();

  let maxImportance = 0;
  let maxCostLeak = 0;
  let maxReliabilityRisk = 0;

  for (const fileId of fileIds) {
    const raw = computeRawSignals(snapshot, fileId);
    rawByFile.set(fileId, raw);
    maxImportance = Math.max(maxImportance, raw.importance);
    maxCostLeak = Math.max(maxCostLeak, raw.costLeak);
    maxReliabilityRisk = Math.max(maxReliabilityRisk, raw.reliabilityRisk);
  }

  const scoredFiles: ScoredFile[] = fileIds.map((fileId) => {
    const file = snapshot.files[fileId];
    const findings = getFindings(snapshot, file.findingIds);
    const raw = rawByFile.get(fileId)!;
    const scoredFile: ScoredFile = {
      filePath: file.filePath,
      fileId,
      scores: {
        importance: normalizeScore(raw.importance, maxImportance),
        costLeak: normalizeScore(raw.costLeak, maxCostLeak),
        reliabilityRisk: normalizeScore(raw.reliabilityRisk, maxReliabilityRisk),
        aiReviewPriority: 0,
      },
      reasons: buildReasons(snapshot, fileId),
    };

    const priority = Math.min(
      10,
      roundScore(
        scoredFile.scores.importance * 0.3 +
        scoredFile.scores.costLeak * 0.3 +
        scoredFile.scores.reliabilityRisk * 0.25 +
        computePriorityBonus(scoredFile, findings)
      )
    );
    // NOTE: isTestLikeFilePath only matches directory-based or .test./.spec. patterns.
    // A recost-mock-calls.ts at the repo root would NOT match isTestLikeFilePath,
    // so the fixture check must be explicit and independent of isTestLikeFilePath.
    const priorityMultiplier =
      isRecostFixtureFile(scoredFile.filePath)
        ? (_includeTestFiles ? 1 : TEST_FILE_PRIORITY_MULTIPLIER)
        : isTestLikeFilePath(scoredFile.filePath)
        ? TEST_FILE_PRIORITY_MULTIPLIER
        : isDeprioritizedContextFilePath(scoredFile.filePath)
        ? CONTEXT_NOISE_FILE_PRIORITY_MULTIPLIER
        : 1;
    scoredFile.scores.aiReviewPriority = roundScore(priority * priorityMultiplier);

    return scoredFile;
  }).sort((a, b) => {
    return b.scores.aiReviewPriority - a.scores.aiReviewPriority || a.filePath.localeCompare(b.filePath);
  });

  return {
    snapshot,
    scoredFiles,
    rankedProviders: sortProviders(Object.values(snapshot.providers)),
    rankedFindings: sortFindings(Object.values(snapshot.findings)),
  };
}

export function scoreSnapshot(snapshot: RepoIntelligenceSnapshot): ScoredSnapshot {
  return scoreRepoIntelligence(snapshot);
}
