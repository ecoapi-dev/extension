import * as fs from "fs/promises";
import path from "node:path";

import type { SuggestionType } from "../analysis/types";
import type {
  ApiCallNode,
  CompressedCluster,
  CompressedSnippet,
  FileNode,
  FileSummary,
  FindingNode,
  RepoIntelligenceSnapshot,
  ReviewCluster,
} from "./types";
import { estimateLocalMonthlyCost } from "./cost-utils";
import { dedupeFindings, makeFindingContextDedupeKey } from "./finding-dedupe";
import { isTestLikeFilePath } from "./file-signals";
import { filterRealProviders, normalizeProviderId } from "./provider-normalization";

const MAX_EXPORT_TOKENS = 4000;
const SNIPPET_RADIUS = 3;
const SNIPPET_MERGE_GAP = 2;
const MAX_FINDINGS = 5;
const MAX_SNIPPETS = 5;
const MAX_TOP_RISKS = 3;

const HIGH_FREQUENCY_ORDER = ["unbounded-loop", "parallel", "polling"] as const;
const HIGH_FREQUENCY_RISK_LABEL: Record<(typeof HIGH_FREQUENCY_ORDER)[number], string> = {
  "unbounded-loop": "Unbounded loop API calls",
  parallel: "Parallel API fanout",
  polling: "Polling API traffic",
};
const HIGH_FREQUENCY_POTENTIAL_RISK_LABEL: Record<(typeof HIGH_FREQUENCY_ORDER)[number], string> = {
  "unbounded-loop": "Potential unbounded loop API calls",
  parallel: "Potential parallel API fanout",
  polling: "Potential polling API traffic",
};
const FINDING_TITLE_BY_TYPE: Record<SuggestionType, string> = {
  rate_limit: "Rate-limit risk",
  concurrency_control: "Concurrency-control gap",
  cache: "Missing caching",
  redundancy: "Repeated API pattern",
  n_plus_one: "N+1 risk",
  batch: "Batching opportunity",
};
const FINDING_LABEL_BY_TYPE: Partial<Record<SuggestionType, string>> = {
  rate_limit: "Rate-limit finding",
  concurrency_control: "Concurrency-control finding",
  cache: "Cacheable call without cache",
  redundancy: "Repeated API pattern",
};
const SEVERITY_WEIGHT: Record<FindingNode["severity"], number> = { high: 3, medium: 2, low: 1 };

interface FileContext {
  file: FileNode;
  apiCalls: ApiCallNode[];
  findings: FindingNode[];
  providers: string[];
  repeatedKeys: Set<string>;
}

interface SnippetAnchor {
  filePath: string;
  line: number;
  priority: number;
  label: string;
}

interface SnippetRange {
  filePath: string;
  startLine: number;
  endLine: number;
  label: string;
  priority: number;
}

function buildEndpointKey(call: ApiCallNode): string {
  return `${call.provider ?? "unknown"}|${call.method}|${call.url}`;
}

function getDistinctProviders(apiCalls: ApiCallNode[]): string[] {
  return filterRealProviders(apiCalls.map((call) => call.provider));
}

function getRepeatedKeys(apiCalls: ApiCallNode[]): Set<string> {
  const counts = new Map<string, number>();
  for (const call of apiCalls) {
    const key = buildEndpointKey(call);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const repeated = new Set<string>();
  for (const [key, count] of counts.entries()) {
    if (count >= 2) repeated.add(key);
  }
  return repeated;
}

function buildFileContext(snapshot: RepoIntelligenceSnapshot, filePath: string): FileContext {
  const file = snapshot.files[filePath] ?? {
    id: filePath,
    filePath,
    apiCallIds: [],
    findingIds: [],
    providers: [],
  };
  const apiCalls = file.apiCallIds.map((id) => snapshot.apiCalls[id]).filter(Boolean);
  const findings = dedupeFindings(
    file.findingIds.map((id) => snapshot.findings[id]).filter(Boolean),
    compareFindings,
    (finding) => makeFindingContextDedupeKey(finding, getNearestCallSignal(apiCalls, finding))
  );

  return {
    file,
    apiCalls,
    findings,
    providers: getDistinctProviders(apiCalls),
    repeatedKeys: getRepeatedKeys(apiCalls),
  };
}

function getNearestCallSignal(apiCalls: ApiCallNode[], finding: FindingNode) {
  if (finding.line === null || apiCalls.length === 0) return null;
  let nearest: ApiCallNode | null = null;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const apiCall of apiCalls) {
    const distance = Math.abs(apiCall.line - finding.line);
    if (distance < nearestDistance) {
      nearest = apiCall;
      nearestDistance = distance;
    }
  }
  if (!nearest) return null;
  return {
    line: nearest.line,
    method: nearest.method,
    url: nearest.url,
    provider: normalizeProviderId(nearest.provider),
    library: nearest.library,
    originFile: nearest.crossFileOrigin?.file ?? null,
    originFunction: nearest.crossFileOrigin?.functionName ?? null,
  };
}

function countSentences(value: string): number {
  const matches = value.match(/[.!?](?:\s|$)/g);
  return matches ? matches.length : value.trim() ? 1 : 0;
}

function ensureMaxSentences(value: string, maxSentences: number): string {
  const parts = value
    .split(/(?<=[.!?])\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.slice(0, maxSentences).join(" ");
}

function lowerCaseFirst(value: string): string {
  if (!value) return value;
  return `${value.charAt(0).toLowerCase()}${value.slice(1)}`;
}

function getHighFrequencyRisk(context: FileContext): string | null {
  for (const frequencyClass of HIGH_FREQUENCY_ORDER) {
    if (context.apiCalls.some((call) => call.frequencyClass === frequencyClass)) {
      return HIGH_FREQUENCY_RISK_LABEL[frequencyClass];
    }
  }
  return null;
}

function hasCacheableWithoutCache(context: FileContext): boolean {
  const hasCacheFinding = context.findings.some((finding) => finding.type === "cache");
  return context.apiCalls.some((call) => call.cacheCapable) && !hasCacheFinding;
}

function getTopRisks(context: FileContext): string[] {
  const risks: string[] = [];
  const pushRisk = (risk: string): void => {
    if (!risk || risks.includes(risk) || risks.length >= MAX_TOP_RISKS) return;
    risks.push(risk);
  };

  const highFrequencyRisk = getHighFrequencyRisk(context);
  const hasHeuristicOnlySignals = context.findings.length === 0;
  if (highFrequencyRisk) {
    const softenedHighFrequencyRisk =
      hasHeuristicOnlySignals
        ? HIGH_FREQUENCY_POTENTIAL_RISK_LABEL[
            HIGH_FREQUENCY_ORDER.find((frequencyClass) =>
              context.apiCalls.some((call) => call.frequencyClass === frequencyClass)
            ) ?? "polling"
          ]
        : highFrequencyRisk;
    pushRisk(softenedHighFrequencyRisk);
  }
  if (context.repeatedKeys.size > 0) {
    pushRisk(hasHeuristicOnlySignals ? "Potential repeated endpoint calls" : "Repeated endpoint calls");
  }
  if (hasCacheableWithoutCache(context)) {
    pushRisk(hasHeuristicOnlySignals ? "Potential missing caching on hot path" : "Missing caching on hot path");
  }
  if (context.findings.some((finding) => finding.type === "rate_limit")) pushRisk("Rate-limit risk");
  if (context.findings.some((finding) => finding.type === "concurrency_control")) pushRisk("Concurrency-control gap");

  if (risks.length === 0 && context.findings.length > 0) {
    for (const finding of context.findings) {
      pushRisk(FINDING_TITLE_BY_TYPE[finding.type]);
    }
  }

  if (risks.length === 0 && context.apiCalls.length > 0) {
    pushRisk(hasHeuristicOnlySignals ? "Potential relevant API path" : "Relevant API path");
  }

  return risks.slice(0, MAX_TOP_RISKS);
}

function getDescription(context: FileContext): string {
  const isTestFile = isTestLikeFilePath(context.file.filePath);
  if (context.apiCalls.length === 0 && context.findings.length > 0) {
    return isTestFile
      ? `This test file has ${context.findings.length} review finding${context.findings.length === 1 ? "" : "s"} without a matched API call node.`
      : `This file has ${context.findings.length} review finding${context.findings.length === 1 ? "" : "s"} without a matched API call node.`;
  }

  if (context.apiCalls.length === 0) {
    return "This file has no detected API activity in the current snapshot.";
  }

  const highFrequencyRisk = getHighFrequencyRisk(context);
  if (highFrequencyRisk) {
    const providerPhrase =
      context.providers.length > 1 ? ` across ${context.providers.length} providers` :
      context.providers.length === 1 ? ` against ${context.providers[0]}` :
      "";
    const sentence = isTestFile
      ? `This test file exercises ${context.apiCalls.length} API call${context.apiCalls.length === 1 ? "" : "s"}${providerPhrase} and shows ${lowerCaseFirst(highFrequencyRisk)}.`
      : `This file contains ${context.apiCalls.length} API call${context.apiCalls.length === 1 ? "" : "s"}${providerPhrase} and shows ${lowerCaseFirst(highFrequencyRisk)}.`;
    return ensureMaxSentences(
      sentence,
      2
    );
  }

  if (context.repeatedKeys.size > 0) {
    return ensureMaxSentences(
      `${isTestFile ? "This test file" : "This file"} repeats ${context.repeatedKeys.size} endpoint pattern${context.repeatedKeys.size === 1 ? "" : "s"} across ${context.apiCalls.length} API call${context.apiCalls.length === 1 ? "" : "s"}.`,
      2
    );
  }

  if (hasCacheableWithoutCache(context)) {
    return ensureMaxSentences(
      `${isTestFile ? "This test file" : "This file"} has ${context.apiCalls.length} API call${context.apiCalls.length === 1 ? "" : "s"} and cache-capable reads without a matching cache finding.`,
      2
    );
  }

  if (context.providers.length > 1) {
    return ensureMaxSentences(
      `${isTestFile ? "This test file" : "This file"} touches ${context.providers.length} real providers in one request path.`,
      2
    );
  }

  if (context.findings.length > 0) {
    return ensureMaxSentences(
      `${isTestFile ? "This test file" : "This file"} combines ${context.apiCalls.length} API call${context.apiCalls.length === 1 ? "" : "s"} with ${context.findings.length} surfaced finding${context.findings.length === 1 ? "" : "s"}.`,
      2
    );
  }

  return `${isTestFile ? "This test file" : "This file"} contains ${context.apiCalls.length} API call${context.apiCalls.length === 1 ? "" : "s"} in a focused request path.`;
}

function getWhyItMatters(context: FileContext): string {
  const isTestFile = isTestLikeFilePath(context.file.filePath);
  const highFrequencyRisk = getHighFrequencyRisk(context);
  const distinctFindingTypes = new Set(context.findings.map((finding) => finding.type)).size;
  const distinctEndpoints = new Set(context.apiCalls.map((call) => `${call.method}|${call.url}`)).size;
  if (highFrequencyRisk === "Unbounded loop API calls") {
    return isTestFile
      ? "This test file exercises unbounded-loop request patterns and is mainly useful for reproducing behavior."
      : "This file runs repeated API work inside an unbounded loop, so it is a strong review target.";
  }
  if (highFrequencyRisk === "Parallel API fanout") {
    return isTestFile
      ? "This test file exercises parallel request fanout and is mainly useful for reproducing edge-case behavior."
      : "This file fans out API calls in parallel, which can raise burst load and retry pressure.";
  }
  if (highFrequencyRisk === "Polling API traffic") {
    return isTestFile
      ? "This test file exercises repeated polling behavior and may help validate safeguards."
      : "This file polls an API path repeatedly, which can raise steady-state request volume.";
  }
  if (context.repeatedKeys.size > 0) {
    return isTestFile
      ? `This test file repeats ${context.repeatedKeys.size} endpoint pattern${context.repeatedKeys.size === 1 ? "" : "s"} and may help reproduce duplicate-call behavior.`
      : `This file repeats ${context.repeatedKeys.size} endpoint pattern${context.repeatedKeys.size === 1 ? "" : "s"}, which can amplify request volume.`;
  }
  if (hasCacheableWithoutCache(context)) {
    return isTestFile
      ? "This test file includes cache-capable reads without cache evidence, so it may be useful for validating cache behavior."
      : "This file makes cache-capable reads without cache evidence, so it may be doing avoidable repeated work.";
  }
  if (context.findings.some((finding) => finding.type === "rate_limit")) {
    return isTestFile
      ? "This test file surfaces rate-limit-related signals that may help reproduce guardrail gaps."
      : "This file surfaces rate-limit signals around API calls and should be reviewed for guardrails.";
  }
  if (context.findings.some((finding) => finding.type === "concurrency_control")) {
    return isTestFile
      ? "This test file surfaces concurrency-control signals that may help reproduce queueing or limiter behavior."
      : "This file surfaces concurrency-control signals around API calls and should be checked for limiter gaps.";
  }
  if (context.providers.length > 1 && distinctEndpoints > 1) {
    return isTestFile
      ? `This test file covers ${context.providers.length} providers in one path and may help with integration debugging.`
      : `This file coordinates ${context.providers.length} providers across ${distinctEndpoints} API paths, so it is a useful integration review point.`;
  }
  if (context.findings.length > 0 && distinctFindingTypes > 1) {
    return isTestFile
      ? `This test file collects ${context.findings.length} distinct surfaced finding${context.findings.length === 1 ? "" : "s"} in one place.`
      : `This file concentrates ${context.findings.length} surfaced findings in one place, which makes it a focused cleanup target.`;
  }
  if (context.findings.length > 0) {
    return isTestFile
      ? `This test file surfaces ${context.findings.length} review finding${context.findings.length === 1 ? "" : "s"} and is mainly useful for reproducing them.`
      : `This file has ${context.findings.length} surfaced review finding${context.findings.length === 1 ? "" : "s"} and merits a targeted review.`;
  }
  return isTestFile
    ? "This test file touches an API path and may help reproduce cluster behavior."
    : "This file contains an API path in the current cluster, but the evidence here is still limited.";
}

const FREQUENCY_MULTIPLIER: Record<string, number> = {
  "unbounded-loop": 10,
  polling: 8,
  parallel: 3,
  "bounded-loop": 3,
  conditional: 0.5,
  "cache-guarded": 0.1,
  single: 1,
};

function estimateCallsPerDay(calls: ApiCallNode[]): number {
  return calls.reduce((sum, call) => {
    const mult = (call.frequencyClass ? FREQUENCY_MULTIPLIER[call.frequencyClass] : null) ?? 1;
    return sum + 100 * mult;
  }, 0);
}

function sumCosts(summaries: Array<{ estimatedMonthlyCost: number | null }>): number | null {
  const values = summaries.map((s) => s.estimatedMonthlyCost).filter((v): v is number => v !== null);
  return values.length > 0 ? values.reduce((a, b) => a + b, 0) : null;
}

function buildFileSummary(filePath: string, snapshot: RepoIntelligenceSnapshot): FileSummary {
  const context = buildFileContext(snapshot, filePath);
  const provider = context.providers[0] ?? null;
  const callsPerDay = estimateCallsPerDay(context.apiCalls);
  // A7: In mixed-provider clusters, pair the chosen provider with one of its
  // own calls so method/url align with the provider used for pricing.
  const representativeCall = provider
    ? (context.apiCalls.find((call) => normalizeProviderId(call.provider) === provider) ?? context.apiCalls[0])
    : context.apiCalls[0];
  const methodSig = representativeCall?.method ?? undefined;
  // A7: pass the matching call's URL so URL-path lookup can resolve pricing
  // when there is no SDK method chain (raw fetch).
  const url = representativeCall?.url ?? undefined;
  return {
    filePath,
    description: ensureMaxSentences(getDescription(context), 2),
    providers: context.providers,
    topRisks: getTopRisks(context),
    estimatedMonthlyCost: provider ? (estimateLocalMonthlyCost(provider, callsPerDay, methodSig, url) ?? null) : null,
    whyItMatters: ensureMaxSentences(getWhyItMatters(context), 1),
  };
}

function compareFindings(a: FindingNode, b: FindingNode): number {
  const scoreA = SEVERITY_WEIGHT[a.severity] * a.confidence;
  const scoreB = SEVERITY_WEIGHT[b.severity] * b.confidence;
  return scoreB - scoreA || a.filePath.localeCompare(b.filePath) || (a.line ?? 0) - (b.line ?? 0) || a.id.localeCompare(b.id);
}

function normalizeFindingDescription(description: string): string {
  const normalized = description.trim().replace(/\s+/g, " ");
  if (!normalized) return "Review this finding.";
  return normalized.endsWith(".") ? normalized : `${normalized}.`;
}

function compressFindings(findings: FindingNode[], snapshot: RepoIntelligenceSnapshot): CompressedCluster["findings"] {
  const compressed = dedupeFindings(
    [...findings],
    compareFindings,
    (finding) => {
      const file = snapshot.files[finding.filePath];
      const apiCalls = file?.apiCallIds.map((id) => snapshot.apiCalls[id]).filter(Boolean) ?? [];
      return makeFindingContextDedupeKey(finding, getNearestCallSignal(apiCalls, finding));
    }
  )
    .sort(compareFindings)
    .map((finding) => ({
      title: FINDING_TITLE_BY_TYPE[finding.type],
      severity: finding.severity,
      description: normalizeFindingDescription(finding.description),
      estimatedMonthlyCost: null,
    }));

  const byTitle = new Map<string, CompressedCluster["findings"][number]>();
  for (const finding of compressed) {
    if (byTitle.has(finding.title)) continue;
    byTitle.set(finding.title, finding);
    if (byTitle.size >= MAX_FINDINGS) break;
  }

  return [...byTitle.values()];
}

function buildApiCallLabel(call: ApiCallNode, repeatedKeys: Set<string>): string {
  const isTestFile = isTestLikeFilePath(call.filePath);
  if (call.frequencyClass === "unbounded-loop" || call.frequencyClass === "bounded-loop") {
    return "API call inside loop";
  }
  if (call.frequencyClass === "parallel") {
    return "Parallel API call";
  }
  if (call.frequencyClass === "polling") {
    return "Polling API path";
  }
  if (isTestFile) {
    if (repeatedKeys.has(buildEndpointKey(call))) {
      return "Repeated API pattern";
    }
    return "Relevant test helper context";
  }
  if (call.cacheCapable) {
    return "Cacheable call without cache";
  }
  if (repeatedKeys.has(buildEndpointKey(call))) {
    return "Repeated API pattern";
  }
  return "Relevant API call";
}

function buildFindingLabel(finding: FindingNode): string {
  if (isTestLikeFilePath(finding.filePath) && finding.type === "cache") {
    return "Relevant test helper context";
  }
  return FINDING_LABEL_BY_TYPE[finding.type] ?? "Relevant API call";
}

function compareAnchors(a: SnippetAnchor, b: SnippetAnchor): number {
  return a.priority - b.priority || a.filePath.localeCompare(b.filePath) || a.line - b.line || a.label.localeCompare(b.label);
}

function buildSnippetAnchors(cluster: ReviewCluster, snapshot: RepoIntelligenceSnapshot): SnippetAnchor[] {
  const anchors: SnippetAnchor[] = [];
  const pushAnchor = (anchor: SnippetAnchor): void => {
    anchors.push(anchor);
  };
  const primaryContext = buildFileContext(snapshot, cluster.primaryFile.filePath);
  for (const call of primaryContext.apiCalls) {
    pushAnchor({
      filePath: call.filePath,
      line: call.line,
      priority: 1,
      label: buildApiCallLabel(call, primaryContext.repeatedKeys),
    });
  }
  for (const finding of primaryContext.findings) {
    if (finding.line === null) continue;
    pushAnchor({
      filePath: finding.filePath,
      line: finding.line,
      priority: 2,
      label: buildFindingLabel(finding),
    });
  }

  for (const relatedFile of cluster.relatedFiles) {
    const context = buildFileContext(snapshot, relatedFile.filePath);
    for (const call of context.apiCalls) {
      pushAnchor({
        filePath: call.filePath,
        line: call.line,
        priority: 3,
        label: buildApiCallLabel(call, context.repeatedKeys),
      });
    }
    for (const finding of context.findings) {
      if (finding.line === null) continue;
      pushAnchor({
        filePath: finding.filePath,
        line: finding.line,
        priority: 4,
        label: buildFindingLabel(finding),
      });
    }
  }

  return anchors.sort(compareAnchors);
}

function shouldMergeRanges(existing: SnippetRange, candidate: SnippetRange): boolean {
  if (existing.filePath !== candidate.filePath) return false;
  return candidate.startLine <= existing.endLine + SNIPPET_MERGE_GAP && candidate.endLine >= existing.startLine - SNIPPET_MERGE_GAP;
}

function mergeSnippetRanges(anchors: SnippetAnchor[]): SnippetRange[] {
  const ranges: SnippetRange[] = [];

  for (const anchor of anchors) {
    const candidate: SnippetRange = {
      filePath: anchor.filePath,
      startLine: Math.max(1, anchor.line - SNIPPET_RADIUS),
      endLine: Math.max(1, anchor.line + SNIPPET_RADIUS),
      label: anchor.label,
      priority: anchor.priority,
    };

    const existing = ranges.find((range) => shouldMergeRanges(range, candidate));
    if (!existing) {
      ranges.push(candidate);
      continue;
    }

    existing.startLine = Math.min(existing.startLine, candidate.startLine);
    existing.endLine = Math.max(existing.endLine, candidate.endLine);
    if (candidate.priority < existing.priority || (candidate.priority === existing.priority && candidate.label < existing.label)) {
      existing.label = candidate.label;
      existing.priority = candidate.priority;
    }
  }

  return ranges.sort((a, b) => a.priority - b.priority || a.filePath.localeCompare(b.filePath) || a.startLine - b.startLine);
}

async function readSnippet(range: SnippetRange, snapshot: RepoIntelligenceSnapshot): Promise<CompressedSnippet | null> {
  const absolutePath = path.resolve(snapshot.repoRoot ?? process.cwd(), range.filePath);
  let source: string;

  try {
    source = await fs.readFile(absolutePath, "utf8");
  } catch {
    return null;
  }

  const lines = source.split("\n");
  if (lines.length === 0) return null;

  const startIndex = Math.max(0, range.startLine - 1);
  const endIndex = Math.min(lines.length - 1, range.endLine - 1);
  const snippetLines = lines.slice(startIndex, endIndex + 1);
  const code = snippetLines.join("\n").trim();
  if (!code) return null;

  return {
    filePath: range.filePath,
    startLine: startIndex + 1,
    endLine: endIndex + 1,
    code,
    label: range.label,
  };
}

async function extractSnippets(cluster: ReviewCluster, snapshot: RepoIntelligenceSnapshot): Promise<CompressedSnippet[]> {
  const anchors = buildSnippetAnchors(cluster, snapshot);
  const mergedRanges = mergeSnippetRanges(anchors).slice(0, MAX_SNIPPETS);

  const readResults = await Promise.all(mergedRanges.map((range) => readSnippet(range, snapshot)));
  const snippets: CompressedSnippet[] = [];

  for (const snippet of readResults) {
    if (!snippet) continue;
    snippets.push(snippet);
    if (snippets.length >= MAX_SNIPPETS) break;
  }

  return snippets;
}

function estimateTokens(clusters: CompressedCluster[]): number {
  return Math.ceil(JSON.stringify(clusters).length / 4);
}

function trimToTokenBudget(clusters: CompressedCluster[]): CompressedCluster[] {
  if (estimateTokens(clusters) <= MAX_EXPORT_TOKENS) return clusters;

  // Pass 1: reduce snippets 5 → 3
  let trimmed = clusters.map((c) => ({ ...c, snippets: c.snippets.slice(0, 3) }));
  if (estimateTokens(trimmed) <= MAX_EXPORT_TOKENS) return trimmed;

  // Pass 2: reduce snippets 3 → 1
  trimmed = trimmed.map((c) => ({ ...c, snippets: c.snippets.slice(0, 1) }));
  if (estimateTokens(trimmed) <= MAX_EXPORT_TOKENS) return trimmed;

  // Pass 3: reduce findings 6 → 3
  trimmed = trimmed.map((c) => ({ ...c, findings: c.findings.slice(0, 3) }));
  if (estimateTokens(trimmed) <= MAX_EXPORT_TOKENS) return trimmed;

  // Pass 4: drop lowest-priority clusters (keep min 2)
  while (trimmed.length > 2 && estimateTokens(trimmed) > MAX_EXPORT_TOKENS) {
    trimmed = trimmed.slice(0, -1);
  }
  return trimmed;
}

export async function compressClusters(
  clusters: ReviewCluster[],
  snapshot: RepoIntelligenceSnapshot
): Promise<CompressedCluster[]> {
  const result = await Promise.all(
    clusters.map(async (cluster) => {
      const primarySummary = buildFileSummary(cluster.primaryFile.filePath, snapshot);
      const relatedSummaries = cluster.relatedFiles.map((relatedFile) => buildFileSummary(relatedFile.filePath, snapshot));
      return {
        id: cluster.id,
        primarySummary,
        relatedSummaries,
        findings: compressFindings(cluster.topFindings, snapshot),
        snippets: await extractSnippets(cluster, snapshot),
        providers: filterRealProviders(cluster.providers),
        estimatedMonthlyCost: sumCosts([primarySummary, ...relatedSummaries]),
        reviewQuestion: cluster.reviewQuestion,
      };
    })
  );
  return trimToTokenBudget(result);
}
