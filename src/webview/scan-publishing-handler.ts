import * as vscode from "vscode";
import {
  scanWorkspace,
  detectLocalWastePatterns,
  countScopedWorkspaceFiles,
  getWorkspaceScanFiles,
} from "../scanner/workspace-scanner";
import { createProject, submitScan, getAllEndpoints, getAllSuggestions } from "../api-client";
import type { HostMessage, KeyServiceId } from "../messages";
import type { ApiCallInput, EndpointRecord, Suggestion, ScanSummary } from "../analysis/types";
import { classifyEndpointScope, detectEndpointProvider } from "../scanner/endpoint-classification";
import { classifyPricing, calculateSavings } from "../scan-results";
import { buildSnapshot } from "../intelligence/builder";
import { scoreSnapshot } from "../intelligence/scorer";
import { estimateLocalMonthlyCost } from "../intelligence/cost-utils";
import { buildKeyFingerprint, type PersistedKeyValidationSnapshot } from "../key-management";
import { getOutputChannel } from "../output";

export interface ExportDebugPayload {
  mode: "local-only" | "remote-enriched";
  scannedFiles: string[];
  local: {
    apiCalls: ApiCallInput[];
    localWasteFindings: Awaited<ReturnType<typeof detectLocalWastePatterns>>;
    submittedRemoteApiCalls: ApiCallInput[];
  };
  remote: null | {
    projectId: string;
    scanId: string;
    endpoints: EndpointRecord[];
    suggestions: Suggestion[];
    summary: ScanSummary;
  };
  final: {
    projectId: string;
    scanId: string;
    endpoints: EndpointRecord[];
    suggestions: Suggestion[];
    summary: ScanSummary;
  };
}

export interface ScanPublishingHandlerContext {
  postMessage(message: HostMessage): void;
  context: vscode.ExtensionContext;
  setLastEndpoints(endpoints: EndpointRecord[]): void;
  setLastSuggestions(suggestions: Suggestion[]): void;
  setLastSummary(summary: ScanSummary | null): void;
  setLastApiCalls(calls: ApiCallInput[]): void;
  setLastFindings(findings: Awaited<ReturnType<typeof detectLocalWastePatterns>>): void;
  setProjectId(id: string | null): void;
  getProjectId(): string | null;
  getManualProjectId(): string | null;
  getRcApiKey(): Promise<string | undefined>;
  resolveScanProjectTarget(rcApiKey: string): Promise<{ projectId: string; source: "manual" | "auto" }>;
  getWorkspaceName(): string;
  openKeys(focusServiceId?: KeyServiceId): void;
  setRecostValidationState(snapshot: PersistedKeyValidationSnapshot): Promise<void>;
  clearRecostValidationState(): Promise<void>;
  sendRecostKeyStatusUpdate(): Promise<void>;
  resetChatHistory(): void;
  exportDebugScanResults(payload: ExportDebugPayload): Promise<void>;
}

function normalizeDescription(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

function trimText(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}...`;
}

function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function mapStatusToSuggestionType(status: EndpointRecord["status"]): Suggestion["type"] | null {
  switch (status) {
    case "cacheable":
      return "cache";
    case "batchable":
      return "batch";
    case "redundant":
      return "redundancy";
    case "n_plus_one_risk":
      return "n_plus_one";
    case "rate_limit_risk":
      return "rate_limit";
    default:
      return null;
  }
}

function chooseSeverity(status: EndpointRecord["status"], monthlyCost: number): Suggestion["severity"] {
  if (status === "n_plus_one_risk" || status === "redundant") {
    return monthlyCost >= 100 ? "high" : "medium";
  }
  if (status === "rate_limit_risk") {
    return monthlyCost >= 50 ? "high" : "medium";
  }
  return monthlyCost >= 100 ? "medium" : "low";
}

function confidenceFromEndpointStatus(endpoint: EndpointRecord): number {
  const base =
    endpoint.status === "n_plus_one_risk" ? 0.78 :
    endpoint.status === "redundant" ? 0.72 :
    endpoint.status === "rate_limit_risk" ? 0.7 :
    endpoint.status === "cacheable" ? 0.66 :
    endpoint.status === "batchable" ? 0.66 :
    0.55;
  const perRequestBoost = endpoint.callSites.some((site) => site.frequency === "per-request") ? 0.07 : 0;
  return clampConfidence(base + perRequestBoost);
}

function buildAggressiveDescription(endpoint: EndpointRecord, type: Suggestion["type"]): string {
  const firstSite = endpoint.callSites[0];
  const location = firstSite ? ` (${firstSite.file}:${firstSite.line})` : "";
  switch (type) {
    case "cache":
      return `Potential caching opportunity detected for \`${endpoint.method} ${endpoint.url}\`${location}. This endpoint appears cacheable; consider adding response caching with explicit TTL and cache invalidation rules to reduce repeated requests and cost.`;
    case "batch":
      return `Potential batching opportunity detected for \`${endpoint.method} ${endpoint.url}\`${location}. This endpoint appears in a pattern that may benefit from request batching or bulk-fetch patterns to reduce request volume.`;
    case "redundancy":
      return `Potential redundant API usage detected for \`${endpoint.method} ${endpoint.url}\`${location}. Multiple call paths may be invoking equivalent requests; consider deduping in-flight requests and consolidating repeated fetches.`;
    case "n_plus_one":
      return `Potential N+1 API pattern detected for \`${endpoint.method} ${endpoint.url}\`${location}. Review loop-driven request behavior and replace with prefetch/batch patterns where possible.`;
    case "rate_limit":
      return `Potential rate-limit risk detected for \`${endpoint.method} ${endpoint.url}\`${location}. Add throttling/backoff and request coalescing to reduce burst frequency and avoid provider limits.`;
    default:
      return `Potential optimization opportunity detected for \`${endpoint.method} ${endpoint.url}\`${location}.`;
  }
}

function buildAggressiveSuggestions(
  endpoints: EndpointRecord[],
  suggestions: Suggestion[],
  localFindings: Awaited<ReturnType<typeof detectLocalWastePatterns>>
): Suggestion[] {
  const existing = new Set<string>();
  for (const suggestion of suggestions) {
    for (const endpointId of suggestion.affectedEndpoints) {
      existing.add(`${endpointId}:${suggestion.type}`);
    }
  }

  function normalizePath(p: string): string {
    return p.replace(/\\/g, "/").replace(/^\.\//, "");
  }

  const coveredByWaste = new Set<string>();
  for (const finding of localFindings) {
    coveredByWaste.add(`${finding.type}:${normalizePath(finding.affectedFile)}`);
  }

  const extras: Suggestion[] = [];
  for (const endpoint of endpoints) {
    const type = mapStatusToSuggestionType(endpoint.status);
    if (!type) continue;

    const dedupeKey = `${endpoint.id}:${type}`;
    if (existing.has(dedupeKey)) continue;

    if (endpoint.scope === "internal") continue;

    const suppressedByWaste = endpoint.files.some((f) =>
      coveredByWaste.has(`${type}:${normalizePath(f)}`)
    );
    if (suppressedByWaste) continue;

    const severity = chooseSeverity(endpoint.status, endpoint.monthlyCost);
    extras.push({
      id: `local-${endpoint.id}-${type}`,
      projectId: endpoint.projectId,
      scanId: endpoint.scanId,
      type,
      severity,
      affectedEndpoints: [endpoint.id],
      affectedFiles: endpoint.files,
      estimatedMonthlySavings: calculateSavings(type, severity, endpoint.monthlyCost),
      description: buildAggressiveDescription(endpoint, type),
      codeFix: "",
      source: "local-rule",
      confidence: confidenceFromEndpointStatus(endpoint),
      evidence: endpoint.callSites.slice(0, 3).map((site) => `Observed callsite: ${site.file}:${site.line}`),
      pricingClass: classifyPricing([endpoint.costModel]),
    });
  }

  return [...suggestions, ...extras];
}

const PROXIMITY_THRESHOLD_LINES = 25;

function findClosestEndpoint(
  finding: { affectedFile: string; line?: number },
  fileEndpoints: EndpointRecord[]
): EndpointRecord | null {
  if (!finding.line || fileEndpoints.length === 0) return null;

  let closest: EndpointRecord | null = null;
  let closestDistance = Infinity;

  for (const ep of fileEndpoints) {
    if (ep.monthlyCost === 0 && ep.callSites.every(s => s.library === "route-def")) continue;

    for (const site of ep.callSites) {
      if (site.file !== finding.affectedFile) continue;
      const distance = Math.abs(site.line - finding.line);
      if (distance < closestDistance) {
        closestDistance = distance;
        closest = ep;
      }
    }
  }

  return closestDistance <= PROXIMITY_THRESHOLD_LINES ? closest : null;
}

function mergeLocalWasteFindings(
  baseSuggestions: Suggestion[],
  localFindings: Awaited<ReturnType<typeof detectLocalWastePatterns>>,
  endpoints: EndpointRecord[],
  projectId: string,
  scanId: string
): Suggestion[] {
  const existingByDescAndFile = new Set(
    baseSuggestions.map((s) => `${s.description}::${s.affectedFiles[0] ?? ""}`)
  );

  const locals: Suggestion[] = [];
  for (const finding of localFindings) {
    if (finding.confidence < 0.35) continue;

    const key = `${finding.description}::${finding.affectedFile}`;
    if (existingByDescAndFile.has(key)) continue;
    existingByDescAndFile.add(key);

    const fileEndpoints = endpoints.filter((ep) => ep.files.includes(finding.affectedFile));
    const closestEndpoint = findClosestEndpoint(finding, fileEndpoints);
    const directCost = closestEndpoint?.monthlyCost ?? 0;
    const fileMonthlyCost = fileEndpoints.reduce((sum, ep) => sum + ep.monthlyCost, 0);
    const baselineCost = directCost > 0
      ? directCost
      : fileMonthlyCost > 0
      ? fileMonthlyCost
      : 0;
    const estimatedMonthlySavings = calculateSavings(finding.type, finding.severity, baselineCost);
    const pricingClass = classifyPricing(fileEndpoints.map((ep) => ep.costModel));

    locals.push({
      id: finding.id,
      projectId,
      scanId,
      type: finding.type,
      severity: finding.severity,
      affectedEndpoints: fileEndpoints.map((ep) => ep.id),
      affectedFiles: [finding.affectedFile],
      targetLine: finding.line,
      estimatedMonthlySavings,
      description: finding.description,
      codeFix: "",
      source: "local-rule",
      confidence: finding.confidence,
      evidence: finding.evidence,
      pricingClass,
    });
  }

  return [...baseSuggestions, ...locals];
}

// Silence unused-helper warnings while keeping the helpers available for future
// callers of mergeLocalWasteFindings or buildAggressiveSuggestions that may need them.
void normalizeDescription;
void trimText;

const GENERIC_DYNAMIC_TOKENS = new Set(["endpoint", "url", "path", "uri", "route"]);
const OUTBOUND_LIBRARIES = new Set([
  "fetch",
  "axios",
  "got",
  "superagent",
  "ky",
  "requests",
  "http",
  "HttpClient",
  "$http",
  "openai",
]);

function isHighConfidenceEndpointUrl(url: string): boolean {
  if (!url) return false;
  if (/^https?:\/\//i.test(url)) return true;
  if (url.startsWith("/")) return true;
  if (/\$\{\s*(endpoint|url|path|uri|route)\s*\}/i.test(url)) return false;
  const dynamic = url.match(/^<dynamic:([^>]+)>$/i);
  if (!dynamic) return false;
  const token = dynamic[1].trim().toLowerCase();
  if (GENERIC_DYNAMIC_TOKENS.has(token)) return false;
  if (/base[_-]?url/.test(token)) return false;
  return /base[_-]?url|api|endpoint/i.test(token);
}

function shouldSubmitRemote(call: ApiCallInput): boolean {
  if (!call.library || !OUTBOUND_LIBRARIES.has(call.library)) return false;
  return isHighConfidenceEndpointUrl(call.url);
}

function shouldIncludeSynthetic(call: ApiCallInput): boolean {
  if (!isHighConfidenceEndpointUrl(call.url)) return false;
  if (call.library === "route-def" || call.library === "api-helper") return call.url.startsWith("/");
  return true;
}

function normalizePathParams(url: string): string {
  return url
    .replace(/\$\{\s*[^}]+\s*\}/g, ":param")
    .replace(/<[^>]+>/g, ":param")
    .replace(/\{[^}]+\}/g, ":param");
}

function stripQueryAndHash(url: string): string {
  const queryIdx = url.indexOf("?");
  const hashIdx = url.indexOf("#");
  const cutAt =
    queryIdx >= 0 && hashIdx >= 0 ? Math.min(queryIdx, hashIdx) :
    queryIdx >= 0 ? queryIdx :
    hashIdx >= 0 ? hashIdx :
    -1;
  return cutAt >= 0 ? url.slice(0, cutAt) : url;
}

function canonicalizeEndpointUrl(url: string): string {
  const stripped = stripQueryAndHash(url.trim());
  return normalizePathParams(stripped);
}

function isDynamicPlaceholderUrl(url: string): boolean {
  return /^<dynamic:[^>]+>$/i.test(url.trim());
}

function buildEndpointKey(method: string, url: string): string {
  return `${method.toUpperCase()} ${canonicalizeEndpointUrl(url)}`;
}

function pickDisplayUrl(current: string, candidate: string): string {
  const currentCanonical = canonicalizeEndpointUrl(current);
  const candidateCanonical = canonicalizeEndpointUrl(candidate);

  const score = (value: string): number => {
    let s = 0;
    if (!isDynamicPlaceholderUrl(value)) s += 3;
    if (value === stripQueryAndHash(value)) s += 2;
    if (value.includes(":param")) s += 1;
    if (value.includes("/")) s += 1;
    return s;
  };

  const currentScore = score(currentCanonical);
  const candidateScore = score(candidateCanonical);
  return candidateScore > currentScore ? candidateCanonical : currentCanonical;
}

const FREQUENCY_SEVERITY: Record<string, number> = {
  polling: 6,
  "unbounded-loop": 5,
  parallel: 4,
  "bounded-loop": 3,
  conditional: 2,
  "cache-guarded": 1,
  single: 0,
};

function pickMostSevereFrequency(a: string | undefined, b: string | undefined): string | undefined {
  if (!a && !b) return undefined;
  if (!a) return b;
  if (!b) return a;
  return (FREQUENCY_SEVERITY[a] ?? 0) >= (FREQUENCY_SEVERITY[b] ?? 0) ? a : b;
}

function mergeRemoteAndLocalEndpoints(
  remote: EndpointRecord[],
  localCalls: ApiCallInput[],
  projectId: string,
  scanId: string
): EndpointRecord[] {
  const merged = remote.map((endpoint) => ({
    ...endpoint,
    scope: endpoint.scope ?? classifyEndpointScope(endpoint.url),
  }));
  const byMethodUrl = new Map<string, EndpointRecord>();
  for (const endpoint of merged) {
    byMethodUrl.set(buildEndpointKey(endpoint.method, endpoint.url), endpoint);
  }

  const syntheticByMethodUrl = new Map<string, EndpointRecord>();
  for (const call of localCalls) {
    if (!shouldIncludeSynthetic(call)) continue;
    const key = buildEndpointKey(call.method, call.url);
    if (byMethodUrl.has(key)) {
      const endpoint = byMethodUrl.get(key)!;
      endpoint.url = pickDisplayUrl(endpoint.url, call.url);
      if (!endpoint.files.includes(call.file)) {
        endpoint.files.push(call.file);
      }
      const hasSite = endpoint.callSites.some(
        (site) => site.file === call.file && site.line === call.line && site.library === call.library
      );
      if (!hasSite) {
        endpoint.callSites.push({
          file: call.file,
          line: call.line,
          library: call.library ?? "",
          frequency: call.frequency,
          frequencyClass: call.frequencyClass,
          crossFileOrigin: call.crossFileOrigin ?? null,
        });
      }
      if (!endpoint.methodSignature && call.methodSignature) endpoint.methodSignature = call.methodSignature;
      if (!endpoint.costModel && call.costModel) endpoint.costModel = call.costModel;
      endpoint.frequencyClass = pickMostSevereFrequency(endpoint.frequencyClass, call.frequencyClass);
      if (call.batchCapable) endpoint.batchCapable = true;
      if (call.cacheCapable) endpoint.cacheCapable = true;
      if (call.streaming) endpoint.streaming = true;
      if (call.isMiddleware) endpoint.isMiddleware = true;
      if (call.crossFileOrigin) {
        endpoint.crossFileOrigins = endpoint.crossFileOrigins ?? [];
        endpoint.crossFileOrigins.push(call.crossFileOrigin);
      }
      continue;
    }

    if (!syntheticByMethodUrl.has(key)) {
      const canonicalUrl = canonicalizeEndpointUrl(call.url);
      const provider = call.provider ?? detectEndpointProvider(canonicalUrl);
      const callsPerDay = call.frequency === "per-request" ? 100 : call.library === "route-def" ? 0 : 1;
      syntheticByMethodUrl.set(key, {
        id: `local-${scanId}-${syntheticByMethodUrl.size + 1}`,
        projectId,
        scanId,
        provider,
        method: call.method,
        url: canonicalUrl,
        scope: classifyEndpointScope(canonicalUrl),
        files: [call.file],
        callSites: [{
          file: call.file,
          line: call.line,
          library: call.library ?? "",
          frequency: call.frequency,
          frequencyClass: call.frequencyClass,
          crossFileOrigin: call.crossFileOrigin ?? null,
        }],
        callsPerDay,
        monthlyCost: estimateLocalMonthlyCost(provider, callsPerDay, call.methodSignature) ?? 0,
        status:
          call.frequency === "per-request"
            ? "n_plus_one_risk"
            : call.library === "route-def"
            ? "normal"
            : "normal",
        methodSignature: call.methodSignature,
        costModel: call.costModel,
        frequencyClass: call.frequencyClass,
        batchCapable: call.batchCapable,
        cacheCapable: call.cacheCapable,
        streaming: call.streaming,
        isMiddleware: call.isMiddleware,
        crossFileOrigins: call.crossFileOrigin ? [call.crossFileOrigin] : undefined,
      });
      continue;
    }

    const synthetic = syntheticByMethodUrl.get(key)!;
    synthetic.url = pickDisplayUrl(synthetic.url, call.url);
    synthetic.scope = classifyEndpointScope(synthetic.url);
    synthetic.provider = call.provider ?? detectEndpointProvider(synthetic.url);
    if (!synthetic.files.includes(call.file)) {
      synthetic.files.push(call.file);
    }
    const hasSite = synthetic.callSites.some(
      (site) => site.file === call.file && site.line === call.line && site.library === call.library
    );
    if (!hasSite) {
      synthetic.callSites.push({
        file: call.file,
        line: call.line,
        library: call.library ?? "",
        frequency: call.frequency,
        frequencyClass: call.frequencyClass,
        crossFileOrigin: call.crossFileOrigin ?? null,
      });
    }
    if (call.frequency === "per-request") {
      synthetic.status = "n_plus_one_risk";
      synthetic.callsPerDay = Math.max(synthetic.callsPerDay, 100);
    }
    if (!synthetic.methodSignature && call.methodSignature) synthetic.methodSignature = call.methodSignature;
    if (!synthetic.costModel && call.costModel) synthetic.costModel = call.costModel;
    synthetic.frequencyClass = pickMostSevereFrequency(synthetic.frequencyClass, call.frequencyClass);
    if (call.batchCapable) synthetic.batchCapable = true;
    if (call.cacheCapable) synthetic.cacheCapable = true;
    if (call.streaming) synthetic.streaming = true;
    if (call.isMiddleware) synthetic.isMiddleware = true;
    if (call.crossFileOrigin) {
      synthetic.crossFileOrigins = synthetic.crossFileOrigins ?? [];
      synthetic.crossFileOrigins.push(call.crossFileOrigin);
    }
  }

  return [...merged, ...syntheticByMethodUrl.values()]
    .filter((ep) => ep.scope !== "internal");
}

export class ScanPublishingHandler {
  constructor(private readonly ctx: ScanPublishingHandlerContext) {}

  public async handleStartScan() {
    await vscode.commands.executeCommand("setContext", "recost.scanning", true);
    try {
      this.ctx.resetChatHistory();
      const scannedFiles = (await getWorkspaceScanFiles()).map((file) => file.relativePath);

      const apiCalls = await scanWorkspace((progress) => {
        this.ctx.postMessage({
          type: "scanProgress",
          stage: "scanning",
          file: progress.file,
          fileIndex: progress.fileIndex,
          fileTotal: progress.fileTotal,
        });
      });

      this.ctx.postMessage({ type: "scanProgress", stage: "analyzing" });
      this.ctx.postMessage({ type: "scanProgress", stage: "detecting" });
      const localWasteFindings = await detectLocalWastePatterns();
      this.ctx.setLastApiCalls(apiCalls);
      this.ctx.setLastFindings(localWasteFindings);
      this.ctx.postMessage({ type: "scanProgress", stage: "resolving" });

      if (process.env.RECOST_INTELLIGENCE_DEBUG === "1") {
        const totalFilesScanned = await countScopedWorkspaceFiles();
        const snapshot = buildSnapshot({
          apiCalls,
          findings: localWasteFindings,
          totalFilesScanned,
        });
        const scored = scoreSnapshot(snapshot);
        const ch = getOutputChannel();
        for (const file of scored.scoredFiles.slice(0, 5)) {
          ch.appendLine(
            `[intelligence] ${file.filePath} | priority=${file.scores.aiReviewPriority.toFixed(2)} | ` +
              `importance=${file.scores.importance.toFixed(2)} | ` +
              `costLeak=${file.scores.costLeak.toFixed(2)} | ` +
              `reliabilityRisk=${file.scores.reliabilityRisk.toFixed(2)} | ` +
              `reasons=${file.reasons.join("; ")}`
          );
        }
      }

      this.ctx.postMessage({ type: "scanComplete" });

      const publishLocalOnlyResults = (localProjectId: string, localScanId: string) => {
        const endpoints = mergeRemoteAndLocalEndpoints([], apiCalls, localProjectId, localScanId);
        const aggressiveSuggestions = buildAggressiveSuggestions(endpoints, [], localWasteFindings);
        const mergedSuggestions = mergeLocalWasteFindings(
          aggressiveSuggestions,
          localWasteFindings,
          endpoints,
          localProjectId,
          localScanId
        );
        const summary: ScanSummary = {
          totalEndpoints: endpoints.length,
          totalCallsPerDay: endpoints.reduce((sum, ep) => sum + ep.callsPerDay, 0),
          totalMonthlyCost: endpoints.reduce((sum, ep) => sum + ep.monthlyCost, 0),
          highRiskCount: mergedSuggestions.filter((s) => s.severity === "high").length,
        };

        const externalEndpoints = endpoints.filter((ep) => ep.scope !== "internal");
        this.ctx.setLastEndpoints(externalEndpoints);
        this.ctx.setLastSuggestions(mergedSuggestions);
        this.ctx.setLastSummary({ ...summary, totalEndpoints: externalEndpoints.length });
        this.ctx.postMessage({
          type: "scanResults",
          endpoints: externalEndpoints,
          suggestions: mergedSuggestions,
          summary: { ...summary, totalEndpoints: externalEndpoints.length },
        });
        void this.ctx.exportDebugScanResults({
          mode: "local-only",
          scannedFiles,
          local: {
            apiCalls,
            localWasteFindings,
            submittedRemoteApiCalls: [],
          },
          remote: null,
          final: {
            projectId: localProjectId,
            scanId: localScanId,
            endpoints,
            suggestions: mergedSuggestions,
            summary,
          },
        });
      };

      if (apiCalls.length === 0) {
        this.ctx.setLastEndpoints([]);
        this.ctx.setLastSuggestions([]);
        const emptySummary: ScanSummary = {
          totalEndpoints: 0,
          totalCallsPerDay: 0,
          totalMonthlyCost: 0,
          highRiskCount: 0,
        };
        this.ctx.setLastSummary(emptySummary);
        this.ctx.postMessage({
          type: "scanResults",
          endpoints: [],
          suggestions: [],
          summary: emptySummary,
        });
        void this.ctx.exportDebugScanResults({
          mode: "local-only",
          scannedFiles,
          local: {
            apiCalls,
            localWasteFindings,
            submittedRemoteApiCalls: [],
          },
          remote: null,
          final: {
            projectId: "local",
            scanId: `local-${Date.now()}`,
            endpoints: [],
            suggestions: [],
            summary: emptySummary,
          },
        });
        return;
      }

      const manualProjectId = this.ctx.getManualProjectId();
      let rcApiKey = await this.ctx.getRcApiKey();
      if (!rcApiKey) {
        publishLocalOnlyResults(manualProjectId ?? this.ctx.getProjectId() ?? "local", `local-${Date.now()}`);
        this.ctx.postMessage({
          type: "scanNotification",
          message: "No ReCost API key — showing local results only. Add a key in Keys to enable remote sync.",
        });
        return;
      }
      const remoteApiCalls = apiCalls
        .filter(shouldSubmitRemote)
        .map((call) => ({
          ...call,
          provider: call.provider ?? detectEndpointProvider(canonicalizeEndpointUrl(call.url)) ?? "unknown",
        }))
        .filter((call) => call.provider !== "unknown");
      if (remoteApiCalls.length === 0) {
        publishLocalOnlyResults(manualProjectId ?? this.ctx.getProjectId() ?? "local", `local-${Date.now()}`);
        return;
      }

      publishLocalOnlyResults(manualProjectId ?? this.ctx.getProjectId() ?? "local", `local-${Date.now()}`);

      try {
        const projectTarget = await this.ctx.resolveScanProjectTarget(rcApiKey);
        let projectId = projectTarget.projectId;
        let scanResult;
        try {
          scanResult = await submitScan(projectId, remoteApiCalls, rcApiKey);
        } catch (err: unknown) {
          if ((err as { status?: number }).status === 404 && projectTarget.source === "auto") {
            const freshId = await createProject(this.ctx.getWorkspaceName(), rcApiKey);
            this.ctx.setProjectId(freshId);
            projectId = freshId;
            await this.ctx.context.globalState.update("recost.projectId", freshId);
            scanResult = await submitScan(projectId, remoteApiCalls, rcApiKey);
          } else {
            throw err;
          }
        }

        const [remoteEndpoints, suggestions] = await Promise.all([
          getAllEndpoints(projectId, scanResult.scanId, rcApiKey),
          getAllSuggestions(projectId, scanResult.scanId, rcApiKey),
        ]);
        const taggedRemoteSuggestions = suggestions.map((s) => ({ ...s, source: s.source ?? "remote" }));

        const endpoints = mergeRemoteAndLocalEndpoints(remoteEndpoints, apiCalls, projectId, scanResult.scanId);
        const externalEndpoints = endpoints.filter((ep) => ep.scope !== "internal");
        this.ctx.setLastEndpoints(externalEndpoints);
        const aggressiveSuggestions = buildAggressiveSuggestions(endpoints, taggedRemoteSuggestions, localWasteFindings);
        const mergedSuggestions = mergeLocalWasteFindings(
          aggressiveSuggestions,
          localWasteFindings,
          endpoints,
          projectId,
          scanResult.scanId
        );
        this.ctx.setLastSuggestions(mergedSuggestions);
        this.ctx.setLastSummary({ ...scanResult.summary, totalEndpoints: externalEndpoints.length });

        this.ctx.postMessage({
          type: "scanResults",
          endpoints: externalEndpoints,
          suggestions: mergedSuggestions,
          summary: {
            ...scanResult.summary,
            totalEndpoints: externalEndpoints.length,
          },
        });
        void this.ctx.exportDebugScanResults({
          mode: "remote-enriched",
          scannedFiles,
          local: {
            apiCalls,
            localWasteFindings,
            submittedRemoteApiCalls: remoteApiCalls,
          },
          remote: {
            projectId,
            scanId: scanResult.scanId,
            endpoints: remoteEndpoints,
            suggestions,
            summary: scanResult.summary,
          },
          final: {
            projectId,
            scanId: scanResult.scanId,
            endpoints,
            suggestions: mergedSuggestions,
            summary: {
              ...scanResult.summary,
              totalEndpoints: Math.max(scanResult.summary.totalEndpoints, endpoints.length),
            },
          },
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : "Remote analysis failed";
        const status = (err as { status?: number }).status;
        const authLikeFailure =
          status === 401 ||
          (status === 403 && /invalid|unauthori[sz]ed|forbidden|auth/i.test(message));

        if (authLikeFailure) {
          const rcKey = await this.ctx.getRcApiKey();
          if (rcKey) {
            await this.ctx.setRecostValidationState({
              state: "invalid",
              message,
              lastCheckedAt: new Date().toISOString(),
              keyFingerprint: buildKeyFingerprint(rcKey),
            });
          } else {
            await this.ctx.clearRecostValidationState();
          }
          await this.ctx.sendRecostKeyStatusUpdate();
          this.ctx.openKeys("recost");
        }
        publishLocalOnlyResults(manualProjectId ?? this.ctx.getProjectId() ?? "local", `local-${Date.now()}`);
        if (status === 404 && manualProjectId) {
          this.ctx.postMessage({
            type: "scanNotification",
            message: `Project ID ${manualProjectId} was not found. Keeping the saved manual Project ID and showing local results.`,
          });
          return;
        }
        if (err instanceof Error && err.message === "fetch failed") {
          this.ctx.postMessage({
            type: "scanNotification",
            message: "Could not reach ReCost server. Showing local results.",
          });
        }
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Unknown error during scan";
      this.ctx.postMessage({ type: "error", message });
    } finally {
      await vscode.commands.executeCommand("setContext", "recost.scanning", false);
    }
  }
}
