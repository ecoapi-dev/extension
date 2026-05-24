import * as vscode from "vscode";
import type { HostMessage, KeyServiceId } from "../messages";
import type { PersistedKeyValidationSnapshot } from "../key-management";
import type { EndpointRecord, Suggestion, ScanSummary } from "../analysis/types";
import { buildSystemPrompt } from "../chat/prompts";
import { readWorkspaceFileExcerpt } from "../scanner/workspace-scanner";
import { classifyPricing, calculateSavings } from "../scan-results";
import { buildKeyFingerprint } from "../key-management";
import {
  buildProviderOptions,
  executeChat,
  findModelMetadata,
  getProviderAdapter,
  ChatAdapterError,
  type ChatProviderId,
  type NormalizedChatMessage,
  type NormalizedChatRequest,
} from "../chat";
import { newLocalScanId } from "../scan-id";
// Local copies of small pure helpers used here. Avoid importing from
// webview-provider.ts to prevent a circular import. Originals remain in
// webview-provider.ts where non-chat code also uses them.
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

const PROXIMITY_THRESHOLD_LINES = 25;

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

export interface ChatMessage {
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

export interface ChatHandlerContext {
  postMessage(message: HostMessage): void;
  outputChannel: vscode.OutputChannel;
  context: vscode.ExtensionContext;
  getSelectedChatProvider(): ChatProviderId;
  getSelectedChatModel(): string;
  // Scan state read accessors
  getLastEndpoints(): EndpointRecord[];
  getLastSuggestions(): Suggestion[];
  getLastSummary(): ScanSummary | null;
  getProjectId(): string | null;
  // Scan state write accessors (AI review mutates these)
  setLastSuggestions(suggestions: Suggestion[]): void;
  setLastSummary(summary: ScanSummary | null): void;
  // Key management callables (non-chat-related concerns)
  getKeyServiceIdForProvider(providerId: string): KeyServiceId | undefined;
  getStoredProviderApiKey(providerId: string): Promise<string | undefined>;
  setValidationState(serviceId: KeyServiceId, snapshot: PersistedKeyValidationSnapshot): Promise<void>;
  clearValidationState(serviceId: KeyServiceId): Promise<void>;
  sendKeyStatusUpdate(serviceId: KeyServiceId, focusServiceId?: KeyServiceId): Promise<void>;
  openKeys(focusServiceId?: KeyServiceId): void;
}

export class ChatHandler {
  private chatHistory: ChatMessage[] = [];

  constructor(private readonly ctx: ChatHandlerContext) {}

  public resetHistory(): void {
    this.chatHistory = [];
  }

  public async sendChatConfig(
    providerId: ChatProviderId = this.ctx.getSelectedChatProvider(),
    model: string = this.ctx.getSelectedChatModel()
  ) {
    this.ctx.postMessage({
      type: "chatConfig",
      providers: buildProviderOptions(),
      selectedProvider: providerId,
      selectedModel: model,
    });
  }

  private logAiReview(message: string) {
    const stamp = new Date().toISOString();
    this.ctx.outputChannel.appendLine(`[${stamp}] ${message}`);
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
    const providerId = this.ctx.getSelectedChatProvider();
    const provider = getProviderAdapter(providerId);
    const selectedModel = this.ctx.getSelectedChatModel();
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
      return executeChat({ request, secrets: this.ctx.context.secrets });
    }
    try {
      return await executeChat({ request: { ...request, stream: false }, secrets: this.ctx.context.secrets });
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
        secrets: this.ctx.context.secrets,
      });
    }
  }

  private redactSensitiveText(value: string): string {
    return value
      .replace(/\brc-[a-zA-Z0-9_-]{8,}\b/g, "[REDACTED_RECOST_KEY]")
      .replace(/sk-[a-zA-Z0-9]{16,}/g, "[REDACTED_OPENAI_KEY]")
      .replace(/(api[_-]?key|token|secret)\s*[:=]\s*["'`][^"'`\n]{8,}["'`]/gi, "$1=[REDACTED]")
      .replace(/(authorization\s*:\s*["'`]bearer\s+)[^"'`\n]+/gi, "$1[REDACTED]");
  }

  private async buildAiReviewInputContext(maxFiles: number, maxCharsPerFile: number): Promise<AiReviewInput> {
    const scoreByFile = new Map<string, number>();
    const lineHintByFile = new Map<string, number>();
    const severityScore: Record<Suggestion["severity"], number> = { high: 4, medium: 2, low: 1 };

    for (const suggestion of this.ctx.getLastSuggestions()) {
      for (const file of suggestion.affectedFiles) {
        scoreByFile.set(file, (scoreByFile.get(file) ?? 0) + severityScore[suggestion.severity]);
        if (suggestion.targetLine && !lineHintByFile.has(file)) {
          lineHintByFile.set(file, suggestion.targetLine);
        }
      }
    }

    for (const endpoint of this.ctx.getLastEndpoints()) {
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
      this.ctx.postMessage({
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
      summary: this.ctx.getLastSummary(),
      endpoints: this.ctx.getLastEndpoints().map((endpoint) => ({
        id: endpoint.id,
        method: endpoint.method,
        url: endpoint.url,
        status: endpoint.status,
        monthlyCost: endpoint.monthlyCost,
        files: endpoint.files,
      })),
      suggestions: this.ctx.getLastSuggestions().map((suggestion) => ({
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
    const lastEndpoints = this.ctx.getLastEndpoints();
    const providerProjectId = this.ctx.getProjectId();
    const scanId = lastEndpoints[0]?.scanId ?? providerProjectId ?? newLocalScanId();
    const projectId = lastEndpoints[0]?.projectId ?? providerProjectId ?? "local";
    const fileEndpoints = lastEndpoints.filter((ep) => ep.files.includes(finding.affectedFile));
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

  public async handleRunAiReview() {
    const { enabled, minConfidence, maxFiles, maxCharsPerFile, fallbackModel } = this.getAiReviewConfig();
    if (!enabled) {
      this.ctx.postMessage({ type: "aiReviewError", message: "AI review is disabled in settings." });
      return;
    }
    const lastEndpoints = this.ctx.getLastEndpoints();
    const lastSuggestions = this.ctx.getLastSuggestions();
    if (lastEndpoints.length === 0 && lastSuggestions.length === 0) {
      this.ctx.postMessage({ type: "aiReviewError", message: "Run a scan before AI review." });
      return;
    }

    try {
      const { providerId, model } = this.resolveAiReviewSelection(fallbackModel);
      const provider = getProviderAdapter(providerId);
      this.ctx.postMessage({ type: "aiReviewProgress", stage: "Collecting files..." });
      const input = await this.buildAiReviewInputContext(maxFiles, maxCharsPerFile);
      if (input.files.length === 0) {
        this.ctx.postMessage({ type: "aiReviewComplete", added: 0, filtered: 0 });
        return;
      }

      this.ctx.postMessage({ type: "aiReviewProgress", stage: `Calling ${provider.displayName}...` });
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
      this.ctx.postMessage({ type: "aiReviewProgress", stage: "Validating findings..." });
      const validFiles = new Set(input.files.map((file) => file.path));
      const { accepted, filtered } = this.parseAndValidateAiFindings(raw, validFiles, minConfidence);
      const aiSuggestions = accepted.map((finding, index) => this.mapAiFindingToSuggestion(finding, index));
      const currentSuggestions = this.ctx.getLastSuggestions();
      const merged = this.mergeAiSuggestions(currentSuggestions, aiSuggestions);

      this.ctx.setLastSuggestions(merged.merged);
      const currentEndpoints = this.ctx.getLastEndpoints();
      const currentSummary = this.ctx.getLastSummary();
      const summary = currentSummary ?? {
        totalEndpoints: currentEndpoints.length,
        totalCallsPerDay: currentEndpoints.reduce((sum, endpoint) => sum + endpoint.callsPerDay, 0),
        totalMonthlyCost: currentEndpoints.reduce((sum, endpoint) => sum + endpoint.monthlyCost, 0),
        highRiskCount: 0,
      };
      const updatedSuggestions = this.ctx.getLastSuggestions();
      const updatedSummary: ScanSummary = {
        ...summary,
        totalEndpoints: Math.max(summary.totalEndpoints, currentEndpoints.length),
        highRiskCount: updatedSuggestions.filter((suggestion) => suggestion.severity === "high").length,
      };
      this.ctx.setLastSummary(updatedSummary);

      this.logAiReview(
        `provider=${providerId} model=${model} files=${input.files.length} raw=${accepted.length + filtered} accepted=${merged.added} filtered=${filtered + merged.filtered}`
      );

      this.ctx.postMessage({
        type: "scanResults",
        endpoints: currentEndpoints,
        suggestions: updatedSuggestions,
        summary: updatedSummary,
      });
      this.ctx.postMessage({ type: "aiReviewComplete", added: merged.added, filtered: filtered + merged.filtered });
    } catch (err: unknown) {
      const chatError = err as ChatAdapterError;
      const { providerId } = this.resolveAiReviewSelection(fallbackModel);
      const serviceId = this.ctx.getKeyServiceIdForProvider(providerId);
      if (chatError?.code === "bad_auth") {
        if (serviceId) {
          const apiKey = await this.ctx.getStoredProviderApiKey(providerId);
          if (apiKey) {
            await this.ctx.setValidationState(serviceId, {
            state: "invalid",
            message: chatError.message,
            lastCheckedAt: new Date().toISOString(),
              keyFingerprint: buildKeyFingerprint(apiKey),
            });
          } else {
            await this.ctx.clearValidationState(serviceId);
          }
          await this.ctx.sendKeyStatusUpdate(serviceId, serviceId);
        }
        this.ctx.openKeys(serviceId);
        this.ctx.postMessage({ type: "aiReviewError", message: chatError.message });
        return;
      }
      if (chatError?.code === "missing_api_key") {
        if (serviceId) {
          await this.ctx.clearValidationState(serviceId);
          await this.ctx.sendKeyStatusUpdate(serviceId, serviceId);
        }
        this.ctx.openKeys(serviceId);
        this.ctx.postMessage({ type: "aiReviewError", message: chatError.message });
        return;
      }
      const message = err instanceof Error ? err.message : "AI review failed";
      this.logAiReview(`error=${message}`);
      this.ctx.postMessage({ type: "aiReviewError", message });
    }
  }

  private buildMessages(text: string, limitContext = false): NormalizedChatMessage[] {
    const lastSuggestions = this.ctx.getLastSuggestions();
    const lastEndpoints = this.ctx.getLastEndpoints();
    const lastSummary = this.ctx.getLastSummary();
    const suggestions = limitContext ? lastSuggestions.slice(0, 5) : lastSuggestions;
    const endpoints = limitContext ? lastEndpoints.slice(0, 8) : lastEndpoints;
    return [
      { role: "system", content: buildSystemPrompt(lastSummary, suggestions, endpoints) },
      ...this.chatHistory,
      { role: "user", content: text },
    ];
  }

  private async executeProviderRequest(request: NormalizedChatRequest) {
    return executeChat({
      request,
      secrets: this.ctx.context.secrets,
      onChunk: async (chunk) => {
        if (chunk.delta) {
          this.ctx.postMessage({ type: "chatStreaming", chunk: chunk.delta });
        }
      },
    });
  }

  public async handleChat(text: string, providerId: string, model: string) {
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
      this.ctx.postMessage({ type: "chatDone", fullContent: response.content });
    } catch (error) {
      const chatError = error as ChatAdapterError;
      const serviceId = this.ctx.getKeyServiceIdForProvider(providerId);
      if (chatError?.code === "bad_auth") {
        if (serviceId) {
          const apiKey = await this.ctx.getStoredProviderApiKey(providerId);
          if (apiKey) {
            await this.ctx.setValidationState(serviceId, {
            state: "invalid",
            message: chatError.message,
            lastCheckedAt: new Date().toISOString(),
              keyFingerprint: buildKeyFingerprint(apiKey),
            });
          } else {
            await this.ctx.clearValidationState(serviceId);
          }
          await this.ctx.sendKeyStatusUpdate(serviceId, serviceId);
        }
        this.ctx.openKeys(serviceId);
        this.ctx.postMessage({ type: "chatError", message: chatError.message });
        return;
      }
      if (chatError?.code === "missing_api_key") {
        if (serviceId) {
          await this.ctx.clearValidationState(serviceId);
          await this.ctx.sendKeyStatusUpdate(serviceId, serviceId);
        }
        this.ctx.openKeys(serviceId);
        this.ctx.postMessage({ type: "chatError", message: chatError.message });
        return;
      }
      const message = error instanceof Error ? error.message : "Network error. Check your connection.";
      this.ctx.postMessage({ type: "chatError", message });
    }
  }
}
