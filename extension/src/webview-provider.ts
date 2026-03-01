import * as vscode from "vscode";
import * as path from "path";
import { scanWorkspace, detectLocalWastePatterns, readWorkspaceFileExcerpt } from "./scanner/workspace-scanner";
import { createProject, submitScan, getAllEndpoints, getAllSuggestions } from "./api-client";
import { buildSystemPrompt } from "./chat/prompts";
import { LocalServer } from "./local-server";
import type { WebviewMessage, HostMessage } from "./messages";
import type { ApiCallInput, EndpointRecord, Suggestion, ScanSummary } from "./analysis/types";

const MODELS = {
  "gpt-4o-mini": { id: "gpt-4o-mini", name: "GPT-4o Mini" },
  "gpt-4o": { id: "gpt-4o", name: "GPT-4o" },
  "gpt-4.1-mini": { id: "gpt-4.1-mini", name: "GPT-4.1 Mini" },
  "gpt-4.1": { id: "gpt-4.1", name: "GPT-4.1" },
  "o3-mini": { id: "o3-mini", name: "o3 Mini" },
  "o1": { id: "o1", name: "o1" },
  "o3": { id: "o3", name: "o3" },
} as const;

type ModelId = keyof typeof MODELS;

function isOpenAIModel(model: string): boolean {
  return model in MODELS;
}

function isReasoningModel(model: string): boolean {
  return model.startsWith("o1") || model.startsWith("o3");
}

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

function estimateAiSavings(type: Suggestion["type"], severity: Suggestion["severity"], baseline: number): number {
  const baseMultiplier =
    type === "redundancy" ? 0.35 :
    type === "n_plus_one" ? 0.3 :
    type === "cache" ? 0.2 :
    type === "batch" ? 0.18 :
    0.12;
  const severityMultiplier =
    severity === "high" ? 1 :
    severity === "medium" ? 0.75 :
    0.5;
  return Number((baseline * baseMultiplier * severityMultiplier).toFixed(2));
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

function estimateSavings(status: EndpointRecord["status"], monthlyCost: number): number {
  const multiplier =
    status === "redundant" ? 0.4 :
    status === "cacheable" ? 0.25 :
    status === "batchable" ? 0.2 :
    status === "n_plus_one_risk" ? 0.35 :
    status === "rate_limit_risk" ? 0.15 :
    0.1;
  return Number((monthlyCost * multiplier).toFixed(2));
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

function buildAggressiveSuggestions(endpoints: EndpointRecord[], suggestions: Suggestion[]): Suggestion[] {
  const existing = new Set<string>();
  for (const suggestion of suggestions) {
    for (const endpointId of suggestion.affectedEndpoints) {
      existing.add(`${endpointId}:${suggestion.type}`);
    }
  }

  const extras: Suggestion[] = [];
  for (const endpoint of endpoints) {
    const type = mapStatusToSuggestionType(endpoint.status);
    if (!type) continue;

    const dedupeKey = `${endpoint.id}:${type}`;
    if (existing.has(dedupeKey)) continue;

    extras.push({
      id: `local-${endpoint.id}-${type}`,
      projectId: endpoint.projectId,
      scanId: endpoint.scanId,
      type,
      severity: chooseSeverity(endpoint.status, endpoint.monthlyCost),
      affectedEndpoints: [endpoint.id],
      affectedFiles: endpoint.files,
      estimatedMonthlySavings: estimateSavings(endpoint.status, endpoint.monthlyCost),
      description: buildAggressiveDescription(endpoint, type),
      codeFix: "",
      source: "local-rule",
    });
  }

  return [...suggestions, ...extras];
}

function mergeLocalWasteFindings(
  baseSuggestions: Suggestion[],
  localFindings: Awaited<ReturnType<typeof detectLocalWastePatterns>>,
  endpoints: EndpointRecord[],
  totalMonthlyCost: number,
  projectId: string,
  scanId: string
): Suggestion[] {
  const existingByDescAndFile = new Set(
    baseSuggestions.map((s) => `${s.description}::${s.affectedFiles[0] ?? ""}`)
  );

  const locals: Suggestion[] = [];
  for (const finding of localFindings) {
    const key = `${finding.description}::${finding.affectedFile}`;
    if (existingByDescAndFile.has(key)) continue;
    existingByDescAndFile.add(key);

    const fileEndpoints = endpoints.filter((ep) => ep.files.includes(finding.affectedFile));
    const fileMonthlyCost = fileEndpoints.reduce((sum, ep) => sum + ep.monthlyCost, 0);
    const baselineCost = fileMonthlyCost > 0 ? fileMonthlyCost : totalMonthlyCost;
    const multiplier =
      finding.type === "redundancy" ? 0.4 :
      finding.type === "n_plus_one" ? 0.35 :
      finding.type === "cache" ? 0.25 :
      finding.type === "batch" ? 0.2 :
      0.2;
    const severityWeight =
      finding.severity === "high" ? 1 :
      finding.severity === "medium" ? 0.75 :
      0.5;
    const estimatedMonthlySavings = Number((baselineCost * multiplier * severityWeight).toFixed(2));

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
    });
  }

  return [...baseSuggestions, ...locals];
}

function inferProviderFromUrl(url: string): string {
  if (url.startsWith("/")) return "internal";
  const dynamicMatch = url.match(/^<dynamic:([^>]+)>$/);
  if (dynamicMatch) {
    const token = dynamicMatch[1];
    if (/base_url|api/i.test(token)) return "dynamic-api";
    return "dynamic";
  }
  const hostMatch = url.match(/^https?:\/\/([^\/]+)/i);
  if (!hostMatch) return "unknown";
  return hostMatch[1].replace(/^www\./, "");
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
  if (!OUTBOUND_LIBRARIES.has(call.library)) return false;
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

function mergeRemoteAndLocalEndpoints(
  remote: EndpointRecord[],
  localCalls: ApiCallInput[],
  projectId: string,
  scanId: string
): EndpointRecord[] {
  const merged = [...remote];
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
          library: call.library,
          frequency: call.frequency,
        });
      }
      continue;
    }

    if (!syntheticByMethodUrl.has(key)) {
      syntheticByMethodUrl.set(key, {
        id: `local-${scanId}-${syntheticByMethodUrl.size + 1}`,
        projectId,
        scanId,
        provider: inferProviderFromUrl(canonicalizeEndpointUrl(call.url)),
        method: call.method,
        url: canonicalizeEndpointUrl(call.url),
        files: [call.file],
        callSites: [{
          file: call.file,
          line: call.line,
          library: call.library,
          frequency: call.frequency,
        }],
        callsPerDay: call.frequency === "per-request" ? 100 : call.library === "route-def" ? 0 : 1,
        monthlyCost: 0,
        status:
          call.frequency === "per-request"
            ? "n_plus_one_risk"
            : call.library === "route-def"
            ? "normal"
            : "normal",
      });
      continue;
    }

    const synthetic = syntheticByMethodUrl.get(key)!;
    synthetic.url = pickDisplayUrl(synthetic.url, call.url);
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
        library: call.library,
        frequency: call.frequency,
      });
    }
    if (call.frequency === "per-request") {
      synthetic.status = "n_plus_one_risk";
      synthetic.callsPerDay = Math.max(synthetic.callsPerDay, 100);
    }
  }

  return [...merged, ...syntheticByMethodUrl.values()];
}

export class EcoSidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "eco.sidebarView";

  private _view?: vscode.WebviewView;
  private readonly context: vscode.ExtensionContext;

  // Scan state
  private lastEndpoints: EndpointRecord[] = [];
  private lastSuggestions: Suggestion[] = [];
  private lastSummary: ScanSummary | null = null;
  private projectId: string | null = null;

  // Local dashboard server
  private localServer: LocalServer | null = null;

  // Chat state
  private chatHistory: ChatMessage[] = [];
  private readonly outputChannel: vscode.OutputChannel;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
    this.outputChannel = vscode.window.createOutputChannel("ECO AI Review");
    this.context.subscriptions.push(this.outputChannel);
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

    webviewView.webview.onDidReceiveMessage(
      (message: WebviewMessage) => this.handleMessage(message)
    );

    this.projectId = this.context.globalState.get<string>("eco.projectId") ?? null;
  }

  private async checkAndNotifyApiKey() {
    const apiKey = await this.context.secrets.get("eco.openaiApiKey");
    if (!apiKey) {
      this.postMessage({ type: "needsApiKey" });
    }
  }

  public startScan() {
    this._view?.webview.postMessage({ type: "triggerScan" } as HostMessage);
  }

  public sendApiKeyCleared() {
    this.postMessage({ type: "apiKeyCleared" });
  }

  public sendNeedsApiKey() {
    this.postMessage({ type: "needsApiKey" });
  }

  public postMessage(message: HostMessage) {
    this._view?.webview.postMessage(message);
  }

  private async handleMessage(message: WebviewMessage) {
    switch (message.type) {
      case "startScan":
        await this.handleStartScan();
        break;
      case "runAiReview":
        await this.handleRunAiReview();
        break;
      case "chat":
        await this.handleChat(message.text, message.model);
        break;
      case "setApiKey":
        await this.handleSetApiKey(message.key);
        break;
      case "modelChanged": {
        await this.context.globalState.update("eco.selectedModel", message.model);
        // Only gate on API key when switching to an OpenAI model
        if (isOpenAIModel(message.model)) {
          const apiKey = await this.context.secrets.get("eco.openaiApiKey");
          if (!apiKey) {
            this.postMessage({ type: "needsApiKey" });
          }
        }
        break;
      }
      case "applyFix":
        await this.handleApplyFix(message.code, message.file, message.line);
        break;
      case "openFile":
        await this.handleOpenFile(message.file, message.line);
        break;
      case "openDashboard":
        await this.handleOpenDashboard();
        break;
    }
  }

  private async handleStartScan() {
    try {
      this.chatHistory = [];

      const [apiCalls, localWasteFindings] = await Promise.all([
        scanWorkspace((progress) => {
          this.postMessage({
            type: "scanProgress",
            file: progress.file,
            index: progress.index,
            total: progress.total,
            endpointsSoFar: progress.endpointsSoFar,
          });
        }),
        detectLocalWastePatterns(),
      ]);

      this.postMessage({ type: "scanComplete" });

      const publishLocalOnlyResults = (localProjectId: string, localScanId: string) => {
        const endpoints = mergeRemoteAndLocalEndpoints([], apiCalls, localProjectId, localScanId);
        const mergedSuggestions = mergeLocalWasteFindings(
          [],
          localWasteFindings,
          endpoints,
          0,
          localProjectId,
          localScanId
        );
        const summary: ScanSummary = {
          totalEndpoints: endpoints.length,
          totalCallsPerDay: endpoints.reduce((sum, ep) => sum + ep.callsPerDay, 0),
          totalMonthlyCost: 0,
          highRiskCount: mergedSuggestions.filter((s) => s.severity === "high").length,
        };

        this.lastEndpoints = endpoints;
        this.lastSuggestions = mergedSuggestions;
        this.lastSummary = summary;
        this.postMessage({
          type: "scanResults",
          endpoints,
          suggestions: mergedSuggestions,
          summary,
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
        return;
      }

      // Ensure we have a project on the remote API
      let projectId = await this.getOrCreateProject();

      // Submit scan and fetch results
      const remoteApiCalls = apiCalls.filter(shouldSubmitRemote);
      if (remoteApiCalls.length === 0) {
        publishLocalOnlyResults(this.projectId ?? "local", `local-${Date.now()}`);
        return;
      }

      try {
        let scanResult;
        try {
          scanResult = await submitScan(projectId, remoteApiCalls);
        } catch (err: unknown) {
          // Project may have been deleted, create a fresh one and retry once.
          if ((err as { status?: number }).status === 404) {
            const freshId = await createProject(this.getWorkspaceName());
            this.projectId = freshId;
            projectId = freshId;
            await this.context.globalState.update("eco.projectId", freshId);
            scanResult = await submitScan(projectId, remoteApiCalls);
          } else {
            throw err;
          }
        }

        const [remoteEndpoints, suggestions] = await Promise.all([
          getAllEndpoints(projectId, scanResult.scanId),
          getAllSuggestions(projectId, scanResult.scanId),
        ]);
        const taggedRemoteSuggestions = suggestions.map((s) => ({ ...s, source: s.source ?? "remote" }));

        const endpoints = mergeRemoteAndLocalEndpoints(remoteEndpoints, apiCalls, projectId, scanResult.scanId);
        this.lastEndpoints = endpoints;
        const aggressiveSuggestions = buildAggressiveSuggestions(endpoints, taggedRemoteSuggestions);
        const mergedSuggestions = mergeLocalWasteFindings(
          aggressiveSuggestions,
          localWasteFindings,
          endpoints,
          scanResult.summary.totalMonthlyCost,
          projectId,
          scanResult.scanId
        );
        this.lastSuggestions = mergedSuggestions;
        this.lastSummary = scanResult.summary;

        this.postMessage({
          type: "scanResults",
          endpoints,
          suggestions: mergedSuggestions,
          summary: {
            ...scanResult.summary,
            totalEndpoints: Math.max(scanResult.summary.totalEndpoints, endpoints.length),
          },
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : "Remote analysis failed";
        publishLocalOnlyResults(this.projectId ?? projectId ?? "local", `local-${Date.now()}`);
        this.postMessage({
          type: "error",
          message: `Remote analysis failed: ${message}. Showing local-only results.`,
        });
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Unknown error during scan";
      this.postMessage({ type: "error", message });
    }
  }

  private logAiReview(message: string) {
    const stamp = new Date().toISOString();
    this.outputChannel.appendLine(`[${stamp}] ${message}`);
  }

  private getAiReviewConfig() {
    const config = vscode.workspace.getConfiguration("eco");
    return {
      enabled: config.get<boolean>("aiReview.enabled", true),
      minConfidence: config.get<number>("aiReview.minConfidence", 0.7),
      maxFiles: config.get<number>("aiReview.maxFiles", 25),
      maxCharsPerFile: config.get<number>("aiReview.maxCharsPerFile", 6000),
      model: config.get<string>("aiReview.model", "gpt-4.1-mini"),
    };
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
    const related = this.lastEndpoints
      .filter((endpoint) => endpoint.files.includes(finding.affectedFile))
      .map((endpoint) => endpoint.id);
    const baselineCost = this.lastSummary?.totalMonthlyCost ?? 0;
    const relatedCost = this.lastEndpoints
      .filter((endpoint) => endpoint.files.includes(finding.affectedFile))
      .reduce((sum, endpoint) => sum + endpoint.monthlyCost, 0);
    const monthlyBaseline = relatedCost > 0 ? relatedCost : baselineCost;

    return {
      id: `ai-${Date.now()}-${index + 1}`,
      projectId,
      scanId,
      type: finding.type,
      severity: finding.severity,
      affectedEndpoints: related,
      affectedFiles: [finding.affectedFile],
      targetLine: finding.targetLine,
      estimatedMonthlySavings: estimateAiSavings(finding.type, finding.severity, monthlyBaseline),
      description: finding.description,
      codeFix: "",
      source: "ai",
      confidence: finding.confidence,
      evidence: finding.evidence,
      reviewedAt: new Date().toISOString(),
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
    const { enabled, minConfidence, maxFiles, maxCharsPerFile, model } = this.getAiReviewConfig();
    if (!enabled) {
      this.postMessage({ type: "aiReviewError", message: "AI review is disabled in settings." });
      return;
    }
    if (this.lastEndpoints.length === 0 && this.lastSuggestions.length === 0) {
      this.postMessage({ type: "aiReviewError", message: "Run a scan before AI review." });
      return;
    }

    const apiKey = await this.context.secrets.get("eco.openaiApiKey");
    if (!apiKey) {
      this.postMessage({ type: "needsApiKey", message: "Set your OpenAI API key to run AI review." });
      return;
    }

    try {
      this.postMessage({ type: "aiReviewProgress", stage: "Collecting files..." });
      const input = await this.buildAiReviewInputContext(maxFiles, maxCharsPerFile);
      if (input.files.length === 0) {
        this.postMessage({ type: "aiReviewComplete", added: 0, filtered: 0 });
        return;
      }

      this.postMessage({ type: "aiReviewProgress", stage: "Calling model..." });
      const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          temperature: 0.1,
          response_format: { type: "json_object" },
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
        }),
      });

      if (response.status === 401) {
        await this.context.secrets.delete("eco.openaiApiKey");
        this.postMessage({ type: "needsApiKey", message: "Invalid API key. Please enter a valid key." });
        return;
      }
      if (!response.ok) {
        const errData = await response.json().catch(() => ({ error: { message: "AI review request failed" } }));
        const errMsg = (errData as { error?: { message?: string } })?.error?.message ?? "AI review request failed";
        this.postMessage({ type: "aiReviewError", message: errMsg });
        return;
      }

      const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
      const raw = data.choices?.[0]?.message?.content ?? "";
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
        `files=${input.files.length} raw=${accepted.length + filtered} accepted=${merged.added} filtered=${filtered + merged.filtered}`
      );

      this.postMessage({
        type: "scanResults",
        endpoints: this.lastEndpoints,
        suggestions: this.lastSuggestions,
        summary: updatedSummary,
      });
      this.postMessage({ type: "aiReviewComplete", added: merged.added, filtered: filtered + merged.filtered });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "AI review failed";
      this.logAiReview(`error=${message}`);
      this.postMessage({ type: "aiReviewError", message });
    }
  }

  private async getOrCreateProject(): Promise<string> {
    if (this.projectId) {
      return this.projectId;
    }
    const id = await createProject(this.getWorkspaceName());
    this.projectId = id;
    await this.context.globalState.update("eco.projectId", id);
    return id;
  }

  private getWorkspaceName(): string {
    return vscode.workspace.workspaceFolders?.[0]?.name ?? "eco-workspace";
  }

  private async handleSetApiKey(key: string) {
    if (!key.startsWith("sk-")) {
      this.postMessage({ type: "apiKeyError", message: 'API key must start with "sk-".' });
      return;
    }
    try {
      await this.context.secrets.store("eco.openaiApiKey", key);
      this.postMessage({ type: "apiKeyStored" });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to store API key";
      this.postMessage({ type: "apiKeyError", message });
    }
  }

  private buildMessages(text: string) {
    return [
      { role: "system" as const, content: buildSystemPrompt(this.lastSummary, this.lastSuggestions, this.lastEndpoints) },
      ...this.chatHistory,
      { role: "user" as const, content: text },
    ];
  }

  private async handleChat(text: string, model: string) {
    if (isOpenAIModel(model)) {
      await this.handleOpenAIChat(text, model);
    } else {
      await this.handleCloudflareChat(text);
    }
  }

  private async handleCloudflareChat(text: string) {
    try {
      const response = await fetch("https://api.ecoapi.dev/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: this.buildMessages(text) }),
      });

      if (!response.ok) {
        const errData = await response.json().catch(() => ({ error: { message: "Unknown API error" } }));
        const errMsg = (errData as { error?: { message?: string } })?.error?.message ?? "Chat request failed";
        this.postMessage({ type: "chatError", message: errMsg });
        return;
      }

      const data = await response.json() as { data: { response: string } };
      const fullContent = data.data.response;

      this.chatHistory.push({ role: "user", content: text });
      this.chatHistory.push({ role: "assistant", content: fullContent });

      this.postMessage({ type: "chatDone", fullContent });
    } catch {
      this.postMessage({ type: "chatError", message: "Network error. Check your connection." });
    }
  }

  private async handleOpenAIChat(text: string, model: string) {
    const apiKey = await this.context.secrets.get("eco.openaiApiKey");

    if (!apiKey) {
      this.postMessage({ type: "needsApiKey" });
      return;
    }

    const modelId: ModelId = (model in MODELS) ? (model as ModelId) : "gpt-4o-mini";

    const messages = this.buildMessages(text);
    const modelName = MODELS[modelId].id;
    const reasoning = isReasoningModel(modelName);

    const candidatePayloads: Array<{ stream: boolean; body: Record<string, unknown> }> = reasoning
      ? [
          { stream: false, body: { model: modelName, messages } },
          { stream: false, body: { model: modelName, messages: messages.filter((m) => m.role !== "system") } },
        ]
      : [
          { stream: true, body: { model: modelName, messages, temperature: 0.7, stream: true } },
        ];

    try {
      let lastErrMsg = "API request failed";

      for (let i = 0; i < candidatePayloads.length; i += 1) {
        const candidate = candidatePayloads[i];
        const response = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${apiKey}`,
          },
          body: JSON.stringify(candidate.body),
        });

        if (response.status === 401) {
          await this.context.secrets.delete("eco.openaiApiKey");
          this.postMessage({ type: "needsApiKey", message: "Invalid API key. Please enter a valid key." });
          return;
        }

        if (response.status === 429) {
          this.postMessage({ type: "chatError", message: "Rate limited. Wait a moment and try again." });
          return;
        }

        if (!response.ok) {
          const errData = await response.json().catch(() => ({ error: { message: "Unknown API error" } }));
          lastErrMsg = (errData as { error?: { message?: string } })?.error?.message ?? "API request failed";

          const shouldRetry = reasoning && response.status === 400 && i < candidatePayloads.length - 1;
          if (shouldRetry) {
            continue;
          }

          this.postMessage({ type: "chatError", message: lastErrMsg });
          return;
        }

        let fullContent = "";
        if (candidate.stream) {
          const reader = response.body!.getReader();
          const decoder = new TextDecoder();
          let buffer = "";

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";

            for (const line of lines) {
              if (!line.startsWith("data: ")) continue;
              const data = line.slice(6);
              if (data === "[DONE]") break;
              try {
                const parsed = JSON.parse(data) as { choices: { delta: { content?: string } }[] };
                const chunk = parsed.choices[0]?.delta?.content ?? "";
                if (chunk) {
                  fullContent += chunk;
                  this.postMessage({ type: "chatStreaming", chunk });
                }
              } catch {
                // Malformed SSE line, skip
              }
            }
          }
        } else {
          const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
          fullContent = data.choices?.[0]?.message?.content ?? "";
        }

        this.chatHistory.push({ role: "user", content: text });
        this.chatHistory.push({ role: "assistant", content: fullContent });
        this.postMessage({ type: "chatDone", fullContent });
        return;
      }

      this.postMessage({ type: "chatError", message: lastErrMsg });
    } catch {
      this.postMessage({ type: "chatError", message: "Network error. Check your connection." });
    }
  }

  private async handleApplyFix(code: string, file: string, line?: number) {
    try {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (!workspaceFolder) return;

      const fileUri = vscode.Uri.joinPath(workspaceFolder.uri, file);
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
      const dashboardPath = path.join(this.context.extensionPath, "dashboard-dist");

      if (!this.localServer) {
        this.localServer = new LocalServer(dashboardPath, () => ({
          endpoints: this.lastEndpoints,
          suggestions: this.lastSuggestions,
          summary: this.lastSummary,
          workspaceName: this.getWorkspaceName(),
        }));
      }

      if (!this.localServer.hasDistFiles()) {
        this.postMessage({
          type: "error",
          message: "Dashboard not built yet. Run 'npm run build:dashboard' in the extension directory first.",
        });
        return;
      }

      const port = await this.localServer.start();
      await vscode.env.openExternal(vscode.Uri.parse(`http://localhost:${port}`));
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to open dashboard";
      this.postMessage({ type: "error", message });
    }
  }

  private async handleOpenFile(file: string, line?: number) {
    try {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (!workspaceFolder) return;

      const fileUri = vscode.Uri.joinPath(workspaceFolder.uri, file);
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

