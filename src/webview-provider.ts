import * as vscode from "vscode";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import {
  scanWorkspace,
  detectLocalWastePatterns,
  readWorkspaceFileExcerpt,
  countScopedWorkspaceFiles,
  getWorkspaceScanFiles,
} from "./scanner/workspace-scanner";
import { createProject, findProjectByName, submitScan, getAllEndpoints, getAllSuggestions, validateProjectId } from "./api-client";
import { buildSystemPrompt } from "./chat/prompts";
import {
  buildProviderOptions,
  executeChat,
  findModelMetadata,
  getDefaultChatSelection,
  getProviderAdapter,
  ChatAdapterError,
  type ChatProviderId,
  type NormalizedChatMessage,
  type NormalizedChatRequest,
} from "./chat";
import type { WebviewMessage, HostMessage, KeyServiceId, KeyStatusSummary, ProjectIdStatusSummary } from "./messages";
import type { ApiCallInput, EndpointRecord, Suggestion, ScanSummary } from "./analysis/types";
import { runSimulation, StaticDataSource } from "./simulator";
import type { SimulatorInput } from "./simulator/types";
import { classifyEndpointScope, detectEndpointProvider } from "./scanner/endpoint-classification";
import { classifyPricing, calculateSavings } from "./scan-results";
import { buildSnapshot } from "./intelligence/builder";
import { scoreSnapshot } from "./intelligence/scorer";
import { buildReviewClusters } from "./intelligence/clusters";
import { compressClusters } from "./intelligence/compression";
import { buildExportContext, formatAsMarkdown } from "./intelligence/export";
import { estimateLocalMonthlyCost } from "./intelligence/cost-utils";
import {
  buildKeyFingerprint,
  buildKeyStatusSummary,
  getKeyService,
  listKeyServices,
  maskKeyPreview,
  readStoredSecret,
  resolveCurrentKeyValue,
  validateServiceKey,
  type PersistedKeyValidationSnapshot,
} from "./key-management";
import { resolveWorkspaceFilePathSafely } from "./workspace-file-access";
import { getOutputChannel } from "./output";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

interface AiFinding {
  type: Suggestion["type"];
  severity: Suggestion["severity"];
  confidence: number;
  description: string;
  affectedFile: string;
  targetLine?: number;
  evidence: string[];
}

interface AiPromptFile {
  path: string;
  snippet: string;
  startLine: number;
  endLine: number;
}

interface AiReviewInput {
  files: AiPromptFile[];
  summary: ScanSummary | null;
  endpoints: Array<{
    id: string;
    method: string;
    url: string;
    status: EndpointRecord["status"];
    monthlyCost: number;
    files: string[];
  }>;
  suggestions: Array<{
    type: Suggestion["type"];
    severity: Suggestion["severity"];
    description: string;
    affectedFiles: string[];
  }>;
}

async function resolveWorkspaceFileSafely(
  workspaceFolder: vscode.WorkspaceFolder,
  file: string
): Promise<vscode.Uri | null> {
  const resolvedPath = await resolveWorkspaceFilePathSafely(workspaceFolder.uri.fsPath, file);
  return resolvedPath ? vscode.Uri.file(resolvedPath) : null;
}

export async function collectLocalScanData(
  onProgress?: (progress: {
    file: string;
    fileIndex: number;
    fileTotal: number;
  }) => void
): Promise<{
  apiCalls: ApiCallInput[];
  findings: Awaited<ReturnType<typeof detectLocalWastePatterns>>;
  totalFilesScanned: number;
}> {
  // Run sequentially: scanWorkspace initializes the AST parser (web-tree-sitter WASM)
  // first, so detectLocalWastePatterns can reuse the already-initialized parser
  // without racing on grammar loading — critical for VSIX where node_modules is absent.
  const apiCalls = await scanWorkspace(onProgress);
  const findings = await detectLocalWastePatterns();
  const totalFilesScanned = await countScopedWorkspaceFiles();

  return { apiCalls, findings, totalFilesScanned };
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

  // Build a set of (type, file) pairs already covered by the waste detector.
  // Aggressive suggestions for these will be suppressed so the richer finding wins.
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

    // Skip internal endpoints — they have no cost implications
    if (endpoint.scope === "internal") continue;

    // If the waste detector already covers this type for any of this endpoint's files,
    // suppress the aggressive suggestion — the waste detector finding has richer evidence.
    const suppressedByWaste = endpoint.files.some((f) =>
      coveredByWaste.has(`${type}:${normalizePath(f)}`)
    );
    if (suppressedByWaste) continue;

    extras.push({
      id: `local-${endpoint.id}-${type}`,
      projectId: endpoint.projectId,
      scanId: endpoint.scanId,
      type,
      severity: chooseSeverity(endpoint.status, endpoint.monthlyCost),
      affectedEndpoints: [endpoint.id],
      affectedFiles: endpoint.files,
      estimatedMonthlySavings: calculateSavings(type, "medium", endpoint.monthlyCost),
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

/**
 * Find the endpoint whose call site is closest to the finding's line number.
 * Only considers call sites within PROXIMITY_THRESHOLD_LINES of the finding.
 * Falls back to null if no close match is found, allowing callers to use
 * file-level cost as a fallback.
 *
 * TODO: Replace line-proximity threshold with function-scope matching once
 * function boundary data is available at this point in the pipeline. Function
 * scope is semantically more accurate — a finding and its triggering call site
 * always share the same function body regardless of line distance.
 */
function findClosestEndpoint(
  finding: { affectedFile: string; line?: number },
  fileEndpoints: EndpointRecord[]
): EndpointRecord | null {
  if (!finding.line || fileEndpoints.length === 0) return null;

  let closest: EndpointRecord | null = null;
  let closestDistance = Infinity;

  for (const ep of fileEndpoints) {
    // Skip route-def endpoints — they have monthlyCost === 0 and would
    // produce misleading $0 savings estimates
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
      : 0; // unknown — no savings estimate
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
  // A naked dynamic base URL token is not an endpoint route.
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
      // Propagate enriched fields to endpoint
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

export interface WebviewMessageHandlers {
  startScan(): Promise<void>;
  runAiReview(): Promise<void>;
  chat(text: string, provider: string, model: string): Promise<void>;
  modelChanged(provider: string, model: string): Promise<void>;
  applyFix(code: string, file: string, line?: number): Promise<void>;
  openFile(file: string, line?: number): Promise<void>;
  openDashboard(): Promise<void>;
  runSimulation(input: SimulatorInput): void | Promise<void>;
  getAllKeyStatuses(): Promise<void>;
  getProjectIdStatus(): Promise<void>;
  setKey(serviceId: KeyServiceId, value: string): Promise<void>;
  clearKey(serviceId: KeyServiceId): Promise<void>;
  setProjectId(value: string): Promise<void>;
  clearProjectId(): Promise<void>;
  testKey(serviceId: KeyServiceId): Promise<void>;
  navigate(screen: string, focusServiceId?: KeyServiceId): void;
  copyAiContext(): Promise<void>;
  log(message: string): void;
}

export type DispatchResult =
  | { status: "ok" }
  | { status: "unknown" }
  | { status: "error"; error: string };

export async function dispatchWebviewMessage(
  message: WebviewMessage,
  handlers: WebviewMessageHandlers
): Promise<DispatchResult> {
  try {
    switch (message.type) {
      case "startScan": await handlers.startScan(); return { status: "ok" };
      case "runAiReview": await handlers.runAiReview(); return { status: "ok" };
      case "chat": await handlers.chat(message.text, message.provider, message.model); return { status: "ok" };
      case "modelChanged": await handlers.modelChanged(message.provider, message.model); return { status: "ok" };
      case "applyFix": await handlers.applyFix(message.code, message.file, message.line); return { status: "ok" };
      case "openFile": await handlers.openFile(message.file, message.line); return { status: "ok" };
      case "openDashboard": await handlers.openDashboard(); return { status: "ok" };
      case "runSimulation": await handlers.runSimulation(message.input); return { status: "ok" };
      case "getAllKeyStatuses": await handlers.getAllKeyStatuses(); return { status: "ok" };
      case "getProjectIdStatus": await handlers.getProjectIdStatus(); return { status: "ok" };
      case "setKey": await handlers.setKey(message.serviceId, message.value); return { status: "ok" };
      case "clearKey": await handlers.clearKey(message.serviceId); return { status: "ok" };
      case "setProjectId": await handlers.setProjectId(message.value); return { status: "ok" };
      case "clearProjectId": await handlers.clearProjectId(); return { status: "ok" };
      case "testKey": await handlers.testKey(message.serviceId); return { status: "ok" };
      case "navigate":
        if (message.screen === "keys") handlers.navigate(message.screen, message.focusServiceId);
        return { status: "ok" };
      case "copyAiContext": await handlers.copyAiContext(); return { status: "ok" };
      default: {
        const _exhaustive: never = message;
        const t = (message as { type?: string }).type ?? "<no-type>";
        handlers.log(`unknown message type: ${t}`);
        void _exhaustive;
        return { status: "unknown" };
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    handlers.log(`webview message handler failed (${(message as { type?: string }).type ?? "?"}): ${msg}`);
    return { status: "error", error: msg };
  }
}

export class ReCostSidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "recost.sidebarView";
  private static readonly KEY_VALIDATION_STATE_STORAGE_KEY = "recost.keyValidationState";
  private static readonly MANUAL_PROJECT_ID_STORAGE_KEY = "recost.manualProjectId";
  private static readonly MANUAL_PROJECT_ID_VALIDATION_STORAGE_KEY = "recost.manualProjectIdValidation";

  private _view?: vscode.WebviewView;
  private readonly context: vscode.ExtensionContext;

  // Scan state
  private lastEndpoints: EndpointRecord[] = [];
  private lastSuggestions: Suggestion[] = [];
  private lastSummary: ScanSummary | null = null;
  private projectId: string | null = null;
  private lastApiCalls: ApiCallInput[] = [];
  private lastFindings: Awaited<ReturnType<typeof detectLocalWastePatterns>> = [];

  // Simulator state (persisted across sessions)
  private savedScenarios: import("./simulator/types").SavedScenario[] = [];

  // Chat state
  private chatHistory: ChatMessage[] = [];
  private readonly outputChannel: vscode.OutputChannel;
  private readonly keyValidationState = new Map<KeyServiceId, PersistedKeyValidationSnapshot>();
  private readonly projectIdCheckingState = new Set<string>();

  private async sendProjectIdStatus(): Promise<void> {
    this.postMessage({ type: "projectIdStatus", status: await this.buildProjectIdStatus() });
  }

  private getWorkspaceScopeKey(): string {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 0) return "no-workspace";
    return folders.map((folder) => folder.uri.toString()).sort().join("|");
  }

  private getScopedProjectIdStorageKey(): string {
    return `${ReCostSidebarProvider.MANUAL_PROJECT_ID_STORAGE_KEY}:${this.getWorkspaceScopeKey()}`;
  }

  private getScopedProjectIdValidationStorageKey(): string {
    return `${ReCostSidebarProvider.MANUAL_PROJECT_ID_VALIDATION_STORAGE_KEY}:${this.getWorkspaceScopeKey()}`;
  }

  private getDebugScanExportPath(): string {
    const workspaceName = this.getWorkspaceName().replace(/[^a-zA-Z0-9._-]/g, "_");
    return path.join(os.tmpdir(), `recost-extension-scan-results-${workspaceName}.json`);
  }

  private async exportDebugScanResults(payload: {
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
  }): Promise<void> {
    const exportPath = this.getDebugScanExportPath();
    const body = {
      exportedAt: new Date().toISOString(),
      workspaceName: this.getWorkspaceName(),
      exportPath,
      ...payload,
    };
    try {
      await fs.writeFile(exportPath, JSON.stringify(body, null, 2), "utf-8");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.outputChannel.appendLine(`[debug-export] Failed to write ${exportPath}: ${message}`);
    }
  }

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
    this.outputChannel = vscode.window.createOutputChannel("ReCost AI Review");
    this.context.subscriptions.push(this.outputChannel);
    this.savedScenarios = (this.context.globalState.get<import("./simulator/types").SavedScenario[]>("recost.simulatorScenarios")) ?? [];
    this.restoreKeyValidationState();
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "dist", "webview")],
    };

    webviewView.webview.html = this.getHtmlForWebview(webviewView.webview);

    const messageSub = webviewView.webview.onDidReceiveMessage(
      (message: WebviewMessage) => { void this.handleMessage(message); }
    );
    this.context.subscriptions.push(messageSub);
    webviewView.onDidDispose(() => messageSub.dispose());

    this.projectId = this.context.globalState.get<string>("recost.projectId") ?? null;
    this.sendChatConfig().catch((e) => getOutputChannel().appendLine(`sendChatConfig failed: ${e instanceof Error ? e.message : String(e)}`));
    this.sendAllKeyStatuses().catch((e) => getOutputChannel().appendLine(`sendAllKeyStatuses failed: ${e instanceof Error ? e.message : String(e)}`));
    this.sendProjectIdStatus().catch((e) => getOutputChannel().appendLine(`sendProjectIdStatus failed: ${e instanceof Error ? e.message : String(e)}`));
  }


  public startScan() {
    this._view?.webview.postMessage({ type: "triggerScan" } as HostMessage);
  }

  public openKeys(focusServiceId?: KeyServiceId) {
    this.postMessage({ type: "navigate", screen: "keys", focusServiceId });
    void this.sendAllKeyStatuses(focusServiceId);
    void this.sendProjectIdStatus();
  }

  public async clearManagedKey(serviceId: KeyServiceId) {
    await this.clearServiceKey(serviceId);
    this.openKeys(serviceId);
  }

  public async saveManagedKey(serviceId: KeyServiceId, value: string) {
    await this.setServiceKey(serviceId, value);
    this.openKeys(serviceId);
  }

  private getSelectedChatProvider(): ChatProviderId {
    return (this.context.globalState.get<string>("recost.selectedChatProvider") as ChatProviderId | undefined)
      ?? getDefaultChatSelection().provider;
  }

  private getSelectedChatModel(): string {
    return this.context.globalState.get<string>("recost.selectedChatModel") ?? getDefaultChatSelection().model;
  }

  private getKeyServiceIdForProvider(providerId: string): KeyServiceId | undefined {
    return listKeyServices().find((service) => service.providerId === providerId)?.serviceId;
  }

  private async getStoredProviderApiKey(providerId: string): Promise<string | undefined> {
    const serviceId = this.getKeyServiceIdForProvider(providerId);
    if (!serviceId) return undefined;
    return readStoredSecret(getKeyService(serviceId), this.context.secrets);
  }

  private async sendChatConfig(providerId = this.getSelectedChatProvider(), model = this.getSelectedChatModel()) {
    this.postMessage({
      type: "chatConfig",
      providers: buildProviderOptions(),
      selectedProvider: providerId,
      selectedModel: model,
    });
  }

  public postMessage(message: HostMessage) {
    this._view?.webview.postMessage(message);
  }

  private getManualProjectId(): string | null {
    const scopedKey = this.getScopedProjectIdStorageKey();
    const scopedValue = this.context.workspaceState.get<string>(scopedKey);
    const value =
      scopedValue
      ?? this.context.workspaceState.get<string>(ReCostSidebarProvider.MANUAL_PROJECT_ID_STORAGE_KEY);
    const trimmed = value?.trim();
    return trimmed ? trimmed : null;
  }

  private async setManualProjectId(value: string): Promise<void> {
    const trimmed = value.trim();
    await this.context.workspaceState.update(this.getScopedProjectIdStorageKey(), trimmed || undefined);
    await this.context.workspaceState.update(ReCostSidebarProvider.MANUAL_PROJECT_ID_STORAGE_KEY, undefined);
  }

  private async clearManualProjectId(): Promise<void> {
    await this.context.workspaceState.update(this.getScopedProjectIdStorageKey(), undefined);
    await this.context.workspaceState.update(ReCostSidebarProvider.MANUAL_PROJECT_ID_STORAGE_KEY, undefined);
  }

  private async clearProjectIdValidationState(): Promise<void> {
    await this.context.workspaceState.update(this.getScopedProjectIdValidationStorageKey(), undefined);
    await this.context.workspaceState.update(ReCostSidebarProvider.MANUAL_PROJECT_ID_VALIDATION_STORAGE_KEY, undefined);
  }

  private async setProjectIdValidationState(snapshot: {
    projectId: string;
    state: "valid" | "invalid";
    message?: string;
    lastCheckedAt: string;
    keyFingerprint: string;
  }): Promise<void> {
    await this.context.workspaceState.update(this.getScopedProjectIdValidationStorageKey(), snapshot);
    await this.context.workspaceState.update(ReCostSidebarProvider.MANUAL_PROJECT_ID_VALIDATION_STORAGE_KEY, undefined);
  }

  private async getProjectIdValidationSnapshot(projectId: string): Promise<{
    projectId: string;
    state: "valid" | "invalid";
    message?: string;
    lastCheckedAt: string;
    keyFingerprint: string;
  } | undefined> {
    const snapshot = this.context.workspaceState.get<{
      projectId: string;
      state: "valid" | "invalid";
      message?: string;
      lastCheckedAt: string;
      keyFingerprint: string;
    }>(this.getScopedProjectIdValidationStorageKey())
      ?? this.context.workspaceState.get<{
        projectId: string;
        state: "valid" | "invalid";
        message?: string;
        lastCheckedAt: string;
        keyFingerprint: string;
      }>(ReCostSidebarProvider.MANUAL_PROJECT_ID_VALIDATION_STORAGE_KEY);
    if (!snapshot || snapshot.projectId !== projectId) {
      return undefined;
    }

    const recostKey = await resolveCurrentKeyValue(getKeyService("recost"), this.context.secrets);
    if (!recostKey || snapshot.keyFingerprint !== buildKeyFingerprint(recostKey)) {
      await this.clearProjectIdValidationState();
      return undefined;
    }

    return snapshot;
  }

  private async buildProjectIdStatus(): Promise<ProjectIdStatusSummary> {
    const projectId = this.getManualProjectId();
    if (!projectId) {
      return { value: null, state: "missing" };
    }

    if (this.projectIdCheckingState.has(projectId)) {
      return { value: projectId, state: "checking" };
    }

    const recostKey = await resolveCurrentKeyValue(getKeyService("recost"), this.context.secrets);
    if (!recostKey) {
      return {
        value: projectId,
        state: "invalid",
        message: "ReCost API key is required to validate the Project ID.",
      };
    }

    const snapshot = await this.getProjectIdValidationSnapshot(projectId);
    if (!snapshot) {
      return {
        value: projectId,
        state: "invalid",
        message: "Project ID has not been validated yet.",
      };
    }

    return {
      value: projectId,
      state: snapshot.state,
      message: snapshot.message,
      lastCheckedAt: snapshot.lastCheckedAt,
    };
  }

  private async validateManualProjectId(): Promise<void> {
    const projectId = this.getManualProjectId();
    if (!projectId) {
      await this.clearProjectIdValidationState();
      await this.sendProjectIdStatus();
      return;
    }

    const recostKey = await resolveCurrentKeyValue(getKeyService("recost"), this.context.secrets);
    if (!recostKey) {
      await this.clearProjectIdValidationState();
      await this.sendProjectIdStatus();
      return;
    }

    this.projectIdCheckingState.add(projectId);
    await this.sendProjectIdStatus();

    const lastCheckedAt = new Date().toISOString();
    try {
      await validateProjectId(projectId, recostKey);
      await this.setProjectIdValidationState({
        projectId,
        state: "valid",
        lastCheckedAt,
        keyFingerprint: buildKeyFingerprint(recostKey),
      });
    } catch (error) {
      const err = error as Error & { status?: number };
      const message =
        err.status === 404
          ? `Project ID ${projectId} was not found.`
          : err.status === 401 || err.status === 403
          ? err.message
          : `Unable to validate Project ID: ${err.message}`;
      await this.setProjectIdValidationState({
        projectId,
        state: "invalid",
        message,
        lastCheckedAt,
        keyFingerprint: buildKeyFingerprint(recostKey),
      });
    } finally {
      this.projectIdCheckingState.delete(projectId);
    }

    await this.sendProjectIdStatus();
  }

  private async resolveScanProjectTarget(
    rcApiKey: string
  ): Promise<{ projectId: string; source: "manual" | "auto" }> {
    const manualProjectId = this.getManualProjectId();
    if (manualProjectId) {
      return { projectId: manualProjectId, source: "manual" };
    }
    return { projectId: await this.getOrCreateProject(rcApiKey), source: "auto" };
  }

  private async buildAllKeyStatuses(): Promise<KeyStatusSummary[]> {
    const services = listKeyServices();
    return Promise.all(
      services.map((service) =>
        this.buildKeyStatus(service)
      )
    );
  }

  private async sendAllKeyStatuses(focusServiceId?: KeyServiceId) {
    this.postMessage({ type: "allKeyStatuses", statuses: await this.buildAllKeyStatuses(), focusServiceId });
  }

  private async sendKeyStatusUpdate(serviceId: KeyServiceId, focusServiceId?: KeyServiceId) {
    const service = getKeyService(serviceId);
    const status = await this.buildKeyStatus(service);
    this.postMessage({ type: "keyStatusUpdated", status, focusServiceId });
  }

  private async clearServiceKey(serviceId: KeyServiceId) {
    const service = getKeyService(serviceId);
    if (service.secretStorageKey) {
      await this.context.secrets.delete(service.secretStorageKey);
    }
    if (serviceId === "openai") {
      await this.context.secrets.delete("recost.openaiApiKey");
    }
    await this.clearValidationState(serviceId);
    await this.sendKeyStatusUpdate(serviceId);
    if (serviceId === "recost") {
      await this.clearProjectIdValidationState();
      await this.sendProjectIdStatus();
    }
  }

  private async setServiceKey(serviceId: KeyServiceId, value: string) {
    const service = getKeyService(serviceId);
    const trimmed = value.trim();
    if (!trimmed) {
      this.postMessage({ type: "keyActionError", serviceId, message: "API key must not be empty." });
      return;
    }
    if (!service.secretStorageKey) {
      this.postMessage({ type: "keyActionError", serviceId, message: `${service.displayName} does not use stored API keys in this extension.` });
      return;
    }
    if (serviceId === "openai" && !/^sk-/.test(trimmed)) {
      this.postMessage({ type: "keyActionError", serviceId, message: 'OpenAI API keys must start with "sk-".' });
      return;
    }
    await this.context.secrets.store(service.secretStorageKey, trimmed);
    if (serviceId === "openai") {
      await this.context.secrets.store("recost.openaiApiKey", trimmed);
    }
    await this.clearValidationState(serviceId);
    await this.sendKeyStatusUpdate(serviceId);
    await this.testServiceKey(serviceId);
    if (serviceId === "recost" && this.getManualProjectId()) {
      await this.validateManualProjectId();
    }
  }

  private async testServiceKey(serviceId: KeyServiceId) {
    const service = getKeyService(serviceId);
    const current = await this.buildKeyStatus(service);
    if (current.source === "missing") {
      this.postMessage({ type: "keyActionError", serviceId, message: `${service.displayName} key is missing.` });
      return;
    }
    this.postMessage({
      type: "keyStatusUpdated",
      status: { ...current, state: "checking", message: undefined },
      focusServiceId: serviceId,
    });
    try {
      const value = await resolveCurrentKeyValue(service, this.context.secrets);
      if (!value) {
        this.postMessage({ type: "keyActionError", serviceId, message: `${service.displayName} key is missing.` });
        return;
      }
      const validation = await validateServiceKey(service, value);
      await this.setValidationState(serviceId, {
        ...validation,
        keyFingerprint: buildKeyFingerprint(value),
      });
      await this.sendKeyStatusUpdate(serviceId, serviceId);
      if (serviceId === "recost") {
        await vscode.commands.executeCommand("setContext", "recost.keyOnline", validation.state === "valid");
      }
    } catch (error) {
      const previous = this.keyValidationState.get(serviceId);
      await this.sendKeyStatusUpdate(serviceId, serviceId);
      const message = error instanceof Error ? error.message : `Unable to test ${service.displayName} key.`;
      if (previous) {
        this.postMessage({ type: "keyActionError", serviceId, message });
      } else {
        this.postMessage({
          type: "keyStatusUpdated",
          status: { ...current, message, maskedPreview: current.maskedPreview ?? maskKeyPreview(undefined) },
          focusServiceId: serviceId,
        });
      }
    }
  }

  private async handleMessage(message: WebviewMessage): Promise<void> {
    await dispatchWebviewMessage(message, {
      startScan: () => this.handleStartScan(),
      runAiReview: () => this.handleRunAiReview(),
      chat: (text, provider, model) => this.handleChat(text, provider, model),
      modelChanged: async (provider, model) => {
        await this.context.globalState.update("recost.selectedChatProvider", provider);
        await this.context.globalState.update("recost.selectedChatModel", model);
        await this.sendChatConfig(provider as ChatProviderId, model);
        await this.sendAllKeyStatuses();
      },
      applyFix: (code, file, line) => this.handleApplyFix(code, file, line),
      openFile: (file, line) => this.handleOpenFile(file, line),
      openDashboard: () => this.handleOpenDashboard(),
      runSimulation: (input) => { this.handleRunSimulation(input); },
      getAllKeyStatuses: () => this.sendAllKeyStatuses(),
      getProjectIdStatus: () => this.sendProjectIdStatus(),
      setKey: (serviceId, value) => this.setServiceKey(serviceId, value),
      clearKey: (serviceId) => this.clearServiceKey(serviceId),
      setProjectId: async (value) => {
        await this.setManualProjectId(value);
        await this.clearProjectIdValidationState();
        await this.validateManualProjectId();
      },
      clearProjectId: async () => {
        await this.clearManualProjectId();
        await this.clearProjectIdValidationState();
        await this.sendProjectIdStatus();
      },
      testKey: (serviceId) => this.testServiceKey(serviceId),
      navigate: (_screen, focusServiceId) => this.openKeys(focusServiceId),
      copyAiContext: () => this.handleCopyAiContext(),
      log: (m) => getOutputChannel().appendLine(m),
    });
  }

  private async handleCopyAiContext(): Promise<void> {
    if (this.lastApiCalls.length === 0 && this.lastFindings.length === 0) {
      vscode.window.showWarningMessage("Run a scan first before copying AI context.");
      return;
    }
    try {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      const totalFilesScanned = await countScopedWorkspaceFiles();
      const snapshot = buildSnapshot({
        apiCalls: this.lastApiCalls,
        findings: this.lastFindings,
        repoRoot: workspaceFolder?.uri.fsPath,
        totalFilesScanned,
      });
      const scored = scoreSnapshot(snapshot);
      const clusters = buildReviewClusters(scored);
      const compressed = await compressClusters(clusters, snapshot);
      const generatorVersion = String(this.context.extension.packageJSON.version ?? "");
      const exportContext = buildExportContext(compressed, snapshot, scored, {
        generatorVersion: generatorVersion || undefined,
      });
      const markdown = formatAsMarkdown(exportContext);
      await vscode.env.clipboard.writeText(markdown);
      vscode.window.showInformationMessage("AI context copied to clipboard.");
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to generate AI context";
      vscode.window.showErrorMessage(`ReCost: ${message}`);
    }
  }

  private handleRunSimulation(input: SimulatorInput): void {
    try {
      if (this.lastEndpoints.length === 0) {
        this.postMessage({ type: "simulationError", message: "Run a scan first to use the simulator." });
        return;
      }
      const source = new StaticDataSource(this.lastEndpoints);
      const result = runSimulation(source, input);
      this.postMessage({ type: "simulationResult", result });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Simulation failed";
      this.postMessage({ type: "simulationError", message });
    }
  }

  private async handleStartScan() {
    await vscode.commands.executeCommand("setContext", "recost.scanning", true);
    try {
      this.chatHistory = [];
      const scannedFiles = (await getWorkspaceScanFiles()).map((file) => file.relativePath);

      const apiCalls = await scanWorkspace((progress) => {
        this.postMessage({
          type: "scanProgress",
          stage: "scanning",
          file: progress.file,
          fileIndex: progress.fileIndex,
          fileTotal: progress.fileTotal,
        });
      });

      this.postMessage({ type: "scanProgress", stage: "analyzing" });
      this.postMessage({ type: "scanProgress", stage: "detecting" });
      const localWasteFindings = await detectLocalWastePatterns();
      this.lastApiCalls = apiCalls;
      this.lastFindings = localWasteFindings;
      this.postMessage({ type: "scanProgress", stage: "resolving" });

      if (process.env.RECOST_INTELLIGENCE_DEBUG === "1") {
        const totalFilesScanned = await countScopedWorkspaceFiles();
        const snapshot = buildSnapshot({
          apiCalls,
          findings: localWasteFindings,
          totalFilesScanned,
        });
        const scored = scoreSnapshot(snapshot);
        for (const file of scored.scoredFiles.slice(0, 5)) {
          console.log(
            `[intelligence] ${file.filePath} | priority=${file.scores.aiReviewPriority.toFixed(2)} | ` +
              `importance=${file.scores.importance.toFixed(2)} | ` +
              `costLeak=${file.scores.costLeak.toFixed(2)} | ` +
              `reliabilityRisk=${file.scores.reliabilityRisk.toFixed(2)} | ` +
              `reasons=${file.reasons.join("; ")}`
          );
        }
      }

      this.postMessage({ type: "scanComplete" });

      const publishLocalOnlyResults = (localProjectId: string, localScanId: string) => {
        const endpoints = mergeRemoteAndLocalEndpoints([], apiCalls, localProjectId, localScanId);
        const mergedSuggestions = mergeLocalWasteFindings(
          [],
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
        this.lastEndpoints = externalEndpoints;
        this.lastSuggestions = mergedSuggestions;
        this.lastSummary = { ...summary, totalEndpoints: externalEndpoints.length };
        this.postMessage({
          type: "scanResults",
          endpoints: externalEndpoints,
          suggestions: mergedSuggestions,
          summary: { ...summary, totalEndpoints: externalEndpoints.length },
        });
        void this.exportDebugScanResults({
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
        this.lastEndpoints = [];
        this.lastSuggestions = [];
        this.lastSummary = {
          totalEndpoints: 0,
          totalCallsPerDay: 0,
          totalMonthlyCost: 0,
          highRiskCount: 0,
        };
        this.postMessage({
          type: "scanResults",
          endpoints: [],
          suggestions: [],
          summary: this.lastSummary,
        });
        void this.exportDebugScanResults({
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
            summary: this.lastSummary,
          },
        });
        return;
      }

      // Ensure we have a project on the remote API
      const manualProjectId = this.getManualProjectId();
      let rcApiKey = await this.getRcApiKey();
      if (!rcApiKey) {
        publishLocalOnlyResults(manualProjectId ?? this.projectId ?? "local", `local-${Date.now()}`);
        this.postMessage({
          type: "scanNotification",
          message: "No ReCost API key — showing local results only. Add a key in Keys to enable remote sync.",
        });
        return;
      }
      // Submit scan and fetch results
      // Ensure every call has a provider — fall back to URL-based detection, then skip if still unknown.
      const remoteApiCalls = apiCalls
        .filter(shouldSubmitRemote)
        .map((call) => ({
          ...call,
          provider: call.provider ?? detectEndpointProvider(canonicalizeEndpointUrl(call.url)) ?? "unknown",
        }))
        .filter((call) => call.provider !== "unknown");
      if (remoteApiCalls.length === 0) {
        publishLocalOnlyResults(manualProjectId ?? this.projectId ?? "local", `local-${Date.now()}`);
        return;
      }

      // Show local results immediately so UI unblocks, then update with remote
      publishLocalOnlyResults(manualProjectId ?? this.projectId ?? "local", `local-${Date.now()}`);

      try {
        const projectTarget = await this.resolveScanProjectTarget(rcApiKey);
        let projectId = projectTarget.projectId;
        let scanResult;
        try {
          scanResult = await submitScan(projectId, remoteApiCalls, rcApiKey);
        } catch (err: unknown) {
          // Project may have been deleted, create a fresh one and retry once.
          if ((err as { status?: number }).status === 404 && projectTarget.source === "auto") {
            const freshId = await createProject(this.getWorkspaceName(), rcApiKey);
            this.projectId = freshId;
            projectId = freshId;
            await this.context.globalState.update("recost.projectId", freshId);
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
        this.lastEndpoints = externalEndpoints;
        const aggressiveSuggestions = buildAggressiveSuggestions(endpoints, taggedRemoteSuggestions, localWasteFindings);
        const mergedSuggestions = mergeLocalWasteFindings(
          aggressiveSuggestions,
          localWasteFindings,
          endpoints,
          projectId,
          scanResult.scanId
        );
        this.lastSuggestions = mergedSuggestions;
        this.lastSummary = { ...scanResult.summary, totalEndpoints: externalEndpoints.length };

        this.postMessage({
          type: "scanResults",
          endpoints: externalEndpoints,
          suggestions: mergedSuggestions,
          summary: {
            ...scanResult.summary,
            totalEndpoints: externalEndpoints.length,
          },
        });
        void this.exportDebugScanResults({
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
          const rcApiKey = await this.getRcApiKey();
          if (rcApiKey) {
            await this.setValidationState("recost", {
              state: "invalid",
              message,
              lastCheckedAt: new Date().toISOString(),
              keyFingerprint: buildKeyFingerprint(rcApiKey),
            });
          } else {
            await this.clearValidationState("recost");
          }
          await this.sendKeyStatusUpdate("recost", "recost");
          this.openKeys("recost");
        }
        publishLocalOnlyResults(manualProjectId ?? this.projectId ?? "local", `local-${Date.now()}`);
        if (status === 404 && manualProjectId) {
          this.postMessage({
            type: "scanNotification",
            message: `Project ID ${manualProjectId} was not found. Keeping the saved manual Project ID and showing local results.`,
          });
          return;
        }
        if (err instanceof Error && err.message === "fetch failed") {
          this.postMessage({
            type: "scanNotification",
            message: "Could not reach ReCost server. Showing local results.",
          });
        }
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Unknown error during scan";
      this.postMessage({ type: "error", message });
    } finally {
      await vscode.commands.executeCommand("setContext", "recost.scanning", false);
    }
  }

  private logAiReview(message: string) {
    const stamp = new Date().toISOString();
    this.outputChannel.appendLine(`[${stamp}] ${message}`);
  }

  private getAiReviewConfig() {
    const config = vscode.workspace.getConfiguration("recost");
    return {
      enabled: config.get<boolean>("aiReview.enabled", true),
      minConfidence: config.get<number>("aiReview.minConfidence", 0.7),
      maxFiles: config.get<number>("aiReview.maxFiles", 25),
      maxCharsPerFile: config.get<number>("aiReview.maxCharsPerFile", 6000),
      fallbackModel: config.get<string>("aiReview.model", "gpt-4.1-mini"),
    };
  }

  private resolveAiReviewSelection(fallbackModel: string): { providerId: ChatProviderId; model: string } {
    const providerId = this.getSelectedChatProvider();
    const provider = getProviderAdapter(providerId);
    const selectedModel = this.getSelectedChatModel();
    if (provider.models.some((entry) => entry.id === selectedModel)) {
      return { providerId, model: selectedModel };
    }
    if (providerId === "openai" && provider.models.some((entry) => entry.id === fallbackModel)) {
      return { providerId, model: fallbackModel };
    }
    return { providerId, model: provider.models[0]?.id ?? fallbackModel };
  }

  private async executeAiReviewRequest(request: NormalizedChatRequest) {
    const modelMeta = findModelMetadata(request.provider, request.model);
    const requiresFallback = request.provider === "openai" && modelMeta?.reasoning;
    if (!requiresFallback) {
      return executeChat({ request, secrets: this.context.secrets });
    }
    try {
      return await executeChat({ request: { ...request, stream: false }, secrets: this.context.secrets });
    } catch (error) {
      const chatError = error as ChatAdapterError;
      if (chatError?.status !== 400) {
        throw error;
      }
      return executeChat({
        request: {
          ...request,
          stream: false,
          messages: request.messages.filter((message) => message.role !== "system"),
        },
        secrets: this.context.secrets,
      });
    }
  }

  private redactSensitiveText(value: string): string {
    return value
      .replace(/sk-[a-zA-Z0-9]{16,}/g, "[REDACTED_OPENAI_KEY]")
      .replace(/(api[_-]?key|token|secret)\s*[:=]\s*["'`][^"'`\n]{8,}["'`]/gi, "$1=[REDACTED]")
      .replace(/(authorization\s*:\s*["'`]bearer\s+)[^"'`\n]+/gi, "$1[REDACTED]");
  }

  private async buildAiReviewInputContext(maxFiles: number, maxCharsPerFile: number): Promise<AiReviewInput> {
    const scoreByFile = new Map<string, number>();
    const lineHintByFile = new Map<string, number>();
    const severityScore: Record<Suggestion["severity"], number> = { high: 4, medium: 2, low: 1 };

    for (const suggestion of this.lastSuggestions) {
      for (const file of suggestion.affectedFiles) {
        scoreByFile.set(file, (scoreByFile.get(file) ?? 0) + severityScore[suggestion.severity]);
        if (suggestion.targetLine && !lineHintByFile.has(file)) {
          lineHintByFile.set(file, suggestion.targetLine);
        }
      }
    }

    for (const endpoint of this.lastEndpoints) {
      const endpointScore =
        endpoint.status === "n_plus_one_risk" || endpoint.status === "redundant" ? 4 :
        endpoint.status === "rate_limit_risk" ? 3 :
        endpoint.status === "cacheable" || endpoint.status === "batchable" ? 2 :
        1;
      for (const callSite of endpoint.callSites) {
        scoreByFile.set(callSite.file, (scoreByFile.get(callSite.file) ?? 0) + endpointScore);
        if (!lineHintByFile.has(callSite.file)) {
          lineHintByFile.set(callSite.file, callSite.line);
        }
      }
    }

    const rankedFiles = [...scoreByFile.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, Math.max(1, maxFiles))
      .map(([file]) => file);

    const files: AiPromptFile[] = [];
    for (let i = 0; i < rankedFiles.length; i += 1) {
      const file = rankedFiles[i];
      this.postMessage({
        type: "aiReviewProgress",
        stage: `Preparing context (${i + 1}/${rankedFiles.length})`,
        current: i + 1,
        total: rankedFiles.length,
      });

      const excerpt = await readWorkspaceFileExcerpt(file, {
        centerLine: lineHintByFile.get(file),
        contextLines: 40,
        maxChars: maxCharsPerFile,
      });
      if (!excerpt || !excerpt.content.trim()) continue;
      files.push({
        path: file,
        startLine: excerpt.startLine,
        endLine: excerpt.endLine,
        snippet: this.redactSensitiveText(excerpt.content),
      });
    }

    return {
      files,
      summary: this.lastSummary,
      endpoints: this.lastEndpoints.map((endpoint) => ({
        id: endpoint.id,
        method: endpoint.method,
        url: endpoint.url,
        status: endpoint.status,
        monthlyCost: endpoint.monthlyCost,
        files: endpoint.files,
      })),
      suggestions: this.lastSuggestions.map((suggestion) => ({
        type: suggestion.type,
        severity: suggestion.severity,
        description: suggestion.description,
        affectedFiles: suggestion.affectedFiles,
      })),
    };
  }

  private buildAiReviewPrompt(input: AiReviewInput): string {
    const contract = {
      findings: [
        {
          type: "cache | batch | redundancy | n_plus_one | rate_limit",
          severity: "high | medium | low",
          confidence: 0.0,
          description: "short, specific finding",
          affectedFile: "path/to/file.ts",
          targetLine: 1,
          evidence: ["short reason 1", "short reason 2"],
        },
      ],
    };

    return [
      "You are an API efficiency code reviewer.",
      "Analyze only the provided snippets and existing scan context.",
      "Return ONLY valid JSON with no markdown and no extra text.",
      "Do not invent files. Use only provided file paths.",
      "Prefer high precision over recall.",
      `JSON contract: ${JSON.stringify(contract)}`,
      `Context: ${JSON.stringify(input)}`,
    ].join("\n");
  }

  private parseAndValidateAiFindings(
    raw: string,
    validFiles: Set<string>,
    minConfidence: number
  ): { accepted: AiFinding[]; filtered: number } {
    const allowedTypes = new Set<Suggestion["type"]>(["cache", "batch", "redundancy", "n_plus_one", "rate_limit"]);
    const allowedSeverity = new Set<Suggestion["severity"]>(["high", "medium", "low"]);

    const tryParse = (value: string): unknown => {
      try {
        return JSON.parse(value);
      } catch {
        return null;
      }
    };

    let parsed = tryParse(raw);
    if (!parsed) {
      const fenced = raw.match(/```json\s*([\s\S]*?)\s*```/i) ?? raw.match(/```\s*([\s\S]*?)\s*```/i);
      if (fenced) {
        parsed = tryParse(fenced[1]);
      }
    }
    if (!parsed) {
      const start = raw.indexOf("{");
      const end = raw.lastIndexOf("}");
      if (start >= 0 && end > start) {
        parsed = tryParse(raw.slice(start, end + 1));
      }
    }

    const findings = (parsed as { findings?: unknown })?.findings;
    if (!Array.isArray(findings)) {
      return { accepted: [], filtered: 0 };
    }

    const accepted: AiFinding[] = [];
    let filtered = 0;
    for (const entry of findings) {
      if (accepted.length >= 50) {
        filtered += 1;
        continue;
      }
      if (!entry || typeof entry !== "object") {
        filtered += 1;
        continue;
      }
      const candidate = entry as Record<string, unknown>;
      const type = candidate.type;
      const severity = candidate.severity;
      const affectedFile = candidate.affectedFile;
      const description = candidate.description;
      if (
        typeof type !== "string" ||
        typeof severity !== "string" ||
        typeof affectedFile !== "string" ||
        typeof description !== "string"
      ) {
        filtered += 1;
        continue;
      }
      if (!allowedTypes.has(type as Suggestion["type"]) || !allowedSeverity.has(severity as Suggestion["severity"])) {
        filtered += 1;
        continue;
      }
      if (!validFiles.has(affectedFile)) {
        filtered += 1;
        continue;
      }

      const confidence = clampConfidence(Number(candidate.confidence));
      if (confidence < minConfidence) {
        filtered += 1;
        continue;
      }

      const rawLine = Number(candidate.targetLine);
      const targetLine = Number.isFinite(rawLine) && rawLine > 0 ? Math.floor(rawLine) : undefined;
      const evidence = Array.isArray(candidate.evidence)
        ? candidate.evidence.filter((item): item is string => typeof item === "string").slice(0, 4).map((item) => trimText(item, 180))
        : [];

      accepted.push({
        type: type as Suggestion["type"],
        severity: severity as Suggestion["severity"],
        confidence,
        description: trimText(description.trim(), 500),
        affectedFile,
        targetLine,
        evidence,
      });
    }

    return { accepted, filtered };
  }

  private mapAiFindingToSuggestion(finding: AiFinding, index: number): Suggestion {
    const scanId = this.lastEndpoints[0]?.scanId ?? this.projectId ?? `local-${Date.now()}`;
    const projectId = this.lastEndpoints[0]?.projectId ?? this.projectId ?? "local";
    const fileEndpoints = this.lastEndpoints.filter((ep) => ep.files.includes(finding.affectedFile));
    const related = fileEndpoints.map((endpoint) => endpoint.id);
    const closestEndpoint = findClosestEndpoint(
      { affectedFile: finding.affectedFile, line: finding.targetLine },
      fileEndpoints
    );
    const directCost = closestEndpoint?.monthlyCost ?? 0;
    const fileMonthlyCost = fileEndpoints.reduce((sum, ep) => sum + ep.monthlyCost, 0);
    const monthlyBaseline = directCost > 0
      ? directCost
      : fileMonthlyCost > 0
      ? fileMonthlyCost
      : 0; // unknown — no savings estimate

    return {
      id: `ai-${Date.now()}-${index + 1}`,
      projectId,
      scanId,
      type: finding.type,
      severity: finding.severity,
      affectedEndpoints: related,
      affectedFiles: [finding.affectedFile],
      targetLine: finding.targetLine,
      estimatedMonthlySavings: calculateSavings(finding.type, finding.severity, monthlyBaseline),
      description: finding.description,
      codeFix: "",
      source: "ai",
      confidence: finding.confidence,
      evidence: finding.evidence,
      reviewedAt: new Date().toISOString(),
      pricingClass: classifyPricing(fileEndpoints.map((ep) => ep.costModel)),
    };
  }

  private mergeAiSuggestions(existing: Suggestion[], incoming: Suggestion[]): { merged: Suggestion[]; added: number; filtered: number } {
    const existingByKey = new Set<string>();
    const deterministicOverlap = new Map<string, number[]>();

    for (const suggestion of existing) {
      const file = suggestion.affectedFiles[0] ?? "";
      const line = suggestion.targetLine ?? 0;
      const key = `${suggestion.type}|${file}|${line}|${normalizeDescription(suggestion.description)}`;
      existingByKey.add(key);
      if (file && suggestion.source !== "ai") {
        const overlapKey = `${suggestion.type}|${file}`;
        const lines = deterministicOverlap.get(overlapKey) ?? [];
        lines.push(line);
        deterministicOverlap.set(overlapKey, lines);
      }
    }

    const aiByKey = new Set<string>();
    const accepted: Suggestion[] = [];
    let filtered = 0;

    for (const suggestion of incoming) {
      const file = suggestion.affectedFiles[0] ?? "";
      const line = suggestion.targetLine ?? 0;
      const key = `${suggestion.type}|${file}|${line}|${normalizeDescription(suggestion.description)}`;
      if (existingByKey.has(key) || aiByKey.has(key)) {
        filtered += 1;
        continue;
      }

      const overlapKey = `${suggestion.type}|${file}`;
      const overlapLines = deterministicOverlap.get(overlapKey) ?? [];
      const nearDeterministic = overlapLines.some((knownLine) => Math.abs(knownLine - line) <= 5);
      if (nearDeterministic) {
        filtered += 1;
        continue;
      }

      aiByKey.add(key);
      accepted.push(suggestion);
    }

    return { merged: [...existing, ...accepted], added: accepted.length, filtered };
  }

  private async handleRunAiReview() {
    const { enabled, minConfidence, maxFiles, maxCharsPerFile, fallbackModel } = this.getAiReviewConfig();
    if (!enabled) {
      this.postMessage({ type: "aiReviewError", message: "AI review is disabled in settings." });
      return;
    }
    if (this.lastEndpoints.length === 0 && this.lastSuggestions.length === 0) {
      this.postMessage({ type: "aiReviewError", message: "Run a scan before AI review." });
      return;
    }

    try {
      const { providerId, model } = this.resolveAiReviewSelection(fallbackModel);
      const provider = getProviderAdapter(providerId);
      this.postMessage({ type: "aiReviewProgress", stage: "Collecting files..." });
      const input = await this.buildAiReviewInputContext(maxFiles, maxCharsPerFile);
      if (input.files.length === 0) {
        this.postMessage({ type: "aiReviewComplete", added: 0, filtered: 0 });
        return;
      }

      this.postMessage({ type: "aiReviewProgress", stage: `Calling ${provider.displayName}...` });
      const response = await this.executeAiReviewRequest({
        provider: providerId,
        model,
        temperature: providerId === "recost" ? undefined : 0.1,
        stream: false,
        messages: [
          {
            role: "system",
            content: "You are a strict API efficiency reviewer. Return only JSON.",
          },
          {
            role: "user",
            content: this.buildAiReviewPrompt(input),
          },
        ],
      });

      const raw = response.content ?? "";
      this.postMessage({ type: "aiReviewProgress", stage: "Validating findings..." });
      const validFiles = new Set(input.files.map((file) => file.path));
      const { accepted, filtered } = this.parseAndValidateAiFindings(raw, validFiles, minConfidence);
      const aiSuggestions = accepted.map((finding, index) => this.mapAiFindingToSuggestion(finding, index));
      const merged = this.mergeAiSuggestions(this.lastSuggestions, aiSuggestions);

      this.lastSuggestions = merged.merged;
      const summary = this.lastSummary ?? {
        totalEndpoints: this.lastEndpoints.length,
        totalCallsPerDay: this.lastEndpoints.reduce((sum, endpoint) => sum + endpoint.callsPerDay, 0),
        totalMonthlyCost: this.lastEndpoints.reduce((sum, endpoint) => sum + endpoint.monthlyCost, 0),
        highRiskCount: 0,
      };
      const updatedSummary: ScanSummary = {
        ...summary,
        totalEndpoints: Math.max(summary.totalEndpoints, this.lastEndpoints.length),
        highRiskCount: this.lastSuggestions.filter((suggestion) => suggestion.severity === "high").length,
      };
      this.lastSummary = updatedSummary;

      this.logAiReview(
        `provider=${providerId} model=${model} files=${input.files.length} raw=${accepted.length + filtered} accepted=${merged.added} filtered=${filtered + merged.filtered}`
      );

      this.postMessage({
        type: "scanResults",
        endpoints: this.lastEndpoints,
        suggestions: this.lastSuggestions,
        summary: updatedSummary,
      });
      this.postMessage({ type: "aiReviewComplete", added: merged.added, filtered: filtered + merged.filtered });
    } catch (err: unknown) {
      const chatError = err as ChatAdapterError;
      const { providerId } = this.resolveAiReviewSelection(fallbackModel);
      const serviceId = this.getKeyServiceIdForProvider(providerId);
      if (chatError?.code === "bad_auth") {
        if (serviceId) {
          const apiKey = await this.getStoredProviderApiKey(providerId);
          if (apiKey) {
            await this.setValidationState(serviceId, {
            state: "invalid",
            message: chatError.message,
            lastCheckedAt: new Date().toISOString(),
              keyFingerprint: buildKeyFingerprint(apiKey),
            });
          } else {
            await this.clearValidationState(serviceId);
          }
          await this.sendKeyStatusUpdate(serviceId, serviceId);
        }
        this.openKeys(serviceId);
        this.postMessage({ type: "aiReviewError", message: chatError.message });
        return;
      }
      if (chatError?.code === "missing_api_key") {
        if (serviceId) {
          await this.clearValidationState(serviceId);
          await this.sendKeyStatusUpdate(serviceId, serviceId);
        }
        this.openKeys(serviceId);
        this.postMessage({ type: "aiReviewError", message: chatError.message });
        return;
      }
      const message = err instanceof Error ? err.message : "AI review failed";
      this.logAiReview(`error=${message}`);
      this.postMessage({ type: "aiReviewError", message });
    }
  }

  private async getOrCreateProject(rcApiKey?: string): Promise<string> {
    if (this.projectId) {
      return this.projectId;
    }
    // No local record — check if a project with this workspace name already exists
    // (handles cloning the same repo on a new machine)
    const existing = await findProjectByName(this.getWorkspaceName(), rcApiKey);
    const id = existing ?? await createProject(this.getWorkspaceName(), rcApiKey);
    this.projectId = id;
    await this.context.globalState.update("recost.projectId", id);
    return id;
  }

  private getWorkspaceName(): string {
    return vscode.workspace.workspaceFolders?.[0]?.name ?? "recost-workspace";
  }

  private async getRcApiKey(): Promise<string | undefined> {
    return readStoredSecret(getKeyService("recost"), this.context.secrets);
  }

  private restoreKeyValidationState() {
    const stored =
      this.context.globalState.get<Partial<Record<KeyServiceId, PersistedKeyValidationSnapshot>>>(
        ReCostSidebarProvider.KEY_VALIDATION_STATE_STORAGE_KEY
      ) ?? {};
    for (const [serviceId, snapshot] of Object.entries(stored) as [KeyServiceId, PersistedKeyValidationSnapshot | undefined][]) {
      if (snapshot) {
        this.keyValidationState.set(serviceId, snapshot);
      }
    }
  }

  private async persistKeyValidationState() {
    await this.context.globalState.update(
      ReCostSidebarProvider.KEY_VALIDATION_STATE_STORAGE_KEY,
      Object.fromEntries(this.keyValidationState.entries())
    );
  }

  private async clearValidationState(serviceId: KeyServiceId) {
    this.keyValidationState.delete(serviceId);
    await this.persistKeyValidationState();
  }

  private async setValidationState(serviceId: KeyServiceId, snapshot: PersistedKeyValidationSnapshot) {
    this.keyValidationState.set(serviceId, snapshot);
    await this.persistKeyValidationState();
  }

  private async getValidationSnapshot(serviceId: KeyServiceId): Promise<PersistedKeyValidationSnapshot | undefined> {
    const snapshot = this.keyValidationState.get(serviceId);
    if (!snapshot) return undefined;
    const service = getKeyService(serviceId);
    const currentValue = await resolveCurrentKeyValue(service, this.context.secrets);
    if (!currentValue || snapshot.keyFingerprint !== buildKeyFingerprint(currentValue)) {
      await this.clearValidationState(serviceId);
      return undefined;
    }
    return snapshot;
  }

  private async buildKeyStatus(service: ReturnType<typeof getKeyService>): Promise<KeyStatusSummary> {
    return buildKeyStatusSummary(
      service,
      this.context.secrets,
      await this.getValidationSnapshot(service.serviceId)
    );
  }

  private buildMessages(text: string, limitContext = false): NormalizedChatMessage[] {
    const suggestions = limitContext ? this.lastSuggestions.slice(0, 5) : this.lastSuggestions;
    const endpoints = limitContext ? this.lastEndpoints.slice(0, 8) : this.lastEndpoints;
    return [
      { role: "system", content: buildSystemPrompt(this.lastSummary, suggestions, endpoints) },
      ...this.chatHistory,
      { role: "user", content: text },
    ];
  }

  private async executeProviderRequest(request: NormalizedChatRequest) {
    return executeChat({
      request,
      secrets: this.context.secrets,
      onChunk: async (chunk) => {
        if (chunk.delta) {
          this.postMessage({ type: "chatStreaming", chunk: chunk.delta });
        }
      },
    });
  }

  private async handleChat(text: string, providerId: string, model: string) {
    const provider = getProviderAdapter(providerId);
    const modelMeta = findModelMetadata(providerId, model);
    const messages = this.buildMessages(text, providerId === "recost");
    const baseRequest: NormalizedChatRequest = {
      provider: providerId,
      model,
      messages,
      temperature: providerId === "recost" ? undefined : 0.7,
      stream: provider.supportsStreaming && (modelMeta?.supportsStreaming ?? provider.supportsStreaming),
    };

    try {
      let response;
      const requiresFallback = providerId === "openai" && modelMeta?.reasoning;
      if (requiresFallback) {
        try {
          response = await this.executeProviderRequest({ ...baseRequest, stream: false });
        } catch (error) {
          const chatError = error as ChatAdapterError;
          if (chatError?.status === 400) {
            response = await this.executeProviderRequest({
              ...baseRequest,
              stream: false,
              messages: messages.filter((message) => message.role !== "system"),
            });
          } else {
            throw error;
          }
        }
      } else {
        response = await this.executeProviderRequest(baseRequest);
      }

      this.chatHistory.push({ role: "user", content: text });
      this.chatHistory.push({ role: "assistant", content: response.content });
      this.postMessage({ type: "chatDone", fullContent: response.content });
    } catch (error) {
      const chatError = error as ChatAdapterError;
      const serviceId = this.getKeyServiceIdForProvider(providerId);
      if (chatError?.code === "bad_auth") {
        if (serviceId) {
          const apiKey = await this.getStoredProviderApiKey(providerId);
          if (apiKey) {
            await this.setValidationState(serviceId, {
            state: "invalid",
            message: chatError.message,
            lastCheckedAt: new Date().toISOString(),
              keyFingerprint: buildKeyFingerprint(apiKey),
            });
          } else {
            await this.clearValidationState(serviceId);
          }
          await this.sendKeyStatusUpdate(serviceId, serviceId);
        }
        this.openKeys(serviceId);
        this.postMessage({ type: "chatError", message: chatError.message });
        return;
      }
      if (chatError?.code === "missing_api_key") {
        if (serviceId) {
          await this.clearValidationState(serviceId);
          await this.sendKeyStatusUpdate(serviceId, serviceId);
        }
        this.openKeys(serviceId);
        this.postMessage({ type: "chatError", message: chatError.message });
        return;
      }
      const message = error instanceof Error ? error.message : "Network error. Check your connection.";
      this.postMessage({ type: "chatError", message });
    }
  }

  private async handleApplyFix(code: string, file: string, line?: number) {
    try {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (!workspaceFolder) return;

      const fileUri = await resolveWorkspaceFileSafely(workspaceFolder, file);
      if (!fileUri) {
        vscode.window.showErrorMessage("ECO: Invalid target path.");
        return;
      }
      const doc = await vscode.workspace.openTextDocument(fileUri);
      const editor = await vscode.window.showTextDocument(doc);
      const boundedLine = Math.min(
        Math.max((line ?? 1) - 1, 0),
        Math.max(doc.lineCount - 1, 0)
      );
      const position = new vscode.Position(boundedLine, 0);
      const insertLine = boundedLine ?? position.line;
      const textToInsert = this.formatFixForInsertion(code, doc, insertLine);

      if (this.isDuplicateFix(doc, textToInsert, insertLine)) {
        vscode.window.showInformationMessage("ECO: This fix is already applied.");
        return;
      }

      await editor.edit((editBuilder) => {
        editBuilder.insert(position, textToInsert);
      });

      await doc.save();

      editor.selection = new vscode.Selection(position, position);
      editor.revealRange(new vscode.Range(position, position));
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to apply fix";
      vscode.window.showErrorMessage(`ECO: ${message}`);
    }
  }

  private formatFixForInsertion(code: string, doc: vscode.TextDocument, line: number): string {
    const normalized = code.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const rawLines = normalized.split("\n");

    while (rawLines.length > 0 && rawLines[0].trim() === "") rawLines.shift();
    while (rawLines.length > 0 && rawLines[rawLines.length - 1].trim() === "") rawLines.pop();

    if (rawLines.length === 0) return "";

    const baseIndent = this.getLineIndent(doc, line);
    const minIndent = this.getMinIndent(rawLines);

    const adjusted = rawLines
      .map((current) => {
        if (current.trim() === "") return "";
        const currentIndent = (current.match(/^\s*/) ?? [""])[0].length;
        const removeCount = Math.min(minIndent, currentIndent);
        return `${baseIndent}${current.slice(removeCount)}`;
      })
      .join("\n");

    return adjusted.endsWith("\n") ? adjusted : `${adjusted}\n`;
  }

  private getLineIndent(doc: vscode.TextDocument, line: number): string {
    if (line < 0 || line >= doc.lineCount) return "";
    const text = doc.lineAt(line).text;
    return (text.match(/^\s*/) ?? [""])[0];
  }

  private getMinIndent(lines: string[]): number {
    const nonEmpty = lines.filter((line) => line.trim().length > 0);
    if (nonEmpty.length === 0) return 0;
    return nonEmpty.reduce((min, line) => {
      const indent = (line.match(/^\s*/) ?? [""])[0].length;
      return Math.min(min, indent);
    }, Number.MAX_SAFE_INTEGER);
  }

  private isDuplicateFix(doc: vscode.TextDocument, textToInsert: string, line: number): boolean {
    const normalizedSnippet = textToInsert.trimEnd();
    if (!normalizedSnippet) return true;

    const fullText = doc.getText();
    if (fullText.includes(normalizedSnippet)) {
      return true;
    }

    const snippetLineCount = normalizedSnippet.split("\n").length;
    const endLine = Math.min(doc.lineCount - 1, line + snippetLineCount - 1);
    if (line <= endLine && doc.lineCount > 0) {
      const start = new vscode.Position(line, 0);
      const end = doc.lineAt(endLine).range.end;
      const existing = doc.getText(new vscode.Range(start, end)).trimEnd();
      if (existing === normalizedSnippet) {
        return true;
      }
    }

    return false;
  }

  private async handleOpenDashboard() {
    try {
      const projectIdStatus = await this.buildProjectIdStatus();
      const targetProjectId =
        projectIdStatus.state === "valid" && projectIdStatus.value
          ? projectIdStatus.value
          : null;

      const url = targetProjectId
        ? `https://recost.dev/dashboard/projects/${targetProjectId}`
        : "https://recost.dev/dashboard/projects";
      await vscode.env.openExternal(vscode.Uri.parse(url));
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to open dashboard";
      this.postMessage({ type: "error", message });
    }
  }

  private async handleOpenFile(file: string, line?: number) {
    try {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (!workspaceFolder) return;

      const fileUri = await resolveWorkspaceFileSafely(workspaceFolder, file);
      if (!fileUri) return;
      const doc = await vscode.workspace.openTextDocument(fileUri);
      const selection = line
        ? new vscode.Range(line - 1, 0, line - 1, 0)
        : undefined;
      await vscode.window.showTextDocument(doc, {
        selection,
        viewColumn: vscode.ViewColumn.One,
      });
    } catch {
      // File not found
    }
  }

  private getHtmlForWebview(webview: vscode.Webview): string {
    const distUri = vscode.Uri.joinPath(this.context.extensionUri, "dist", "webview");

    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(distUri, "assets", "index.js"));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(distUri, "assets", "index.css"));

    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${webview.cspSource}; img-src ${webview.cspSource} data:;">
  <link rel="stylesheet" href="${styleUri}">
  <title>ECO</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function getNonce(): string {
  let text = "";
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
