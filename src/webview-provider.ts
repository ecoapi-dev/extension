import * as vscode from "vscode";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import {
  scanWorkspace,
  detectLocalWastePatterns,
  countScopedWorkspaceFiles,
} from "./scanner/workspace-scanner";
import { findProjectByName, createProject, validateProjectId } from "./api-client";
import {
  getDefaultChatSelection,
  type ChatProviderId,
} from "./chat";
import type { WebviewMessage, HostMessage, KeyServiceId, ProjectIdStatusSummary } from "./messages";
import type { ApiCallInput, EndpointRecord, Suggestion, ScanSummary } from "./analysis/types";
import type { SimulatorInput } from "./simulator/types";
import { buildSnapshot } from "./intelligence/builder";
import { scoreSnapshot } from "./intelligence/scorer";
import { buildReviewClusters } from "./intelligence/clusters";
import { compressClusters } from "./intelligence/compression";
import { buildExportContext, formatAsMarkdown } from "./intelligence/export";
import {
  buildKeyFingerprint,
  getKeyService,
  readStoredSecret,
  resolveCurrentKeyValue,
  type PersistedKeyValidationSnapshot,
} from "./key-management";
import { resolveWorkspaceFilePathSafely } from "./workspace-file-access";
import { getOutputChannel } from "./output";
import { ChatHandler } from "./webview/chat-handler";
import { KeyManagementHandler } from "./webview/key-management-handler";
import { SimulationHandler } from "./webview/simulation-handler";
import { ScanPublishingHandler, type ExportDebugPayload } from "./webview/scan-publishing-handler";

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

  // Chat state
  private readonly chatHandler: ChatHandler;
  private readonly keyManagementHandler: KeyManagementHandler;
  private readonly simulationHandler: SimulationHandler;
  private readonly scanPublishingHandler: ScanPublishingHandler;
  private readonly outputChannel: vscode.OutputChannel;
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

  private async exportDebugScanResults(payload: ExportDebugPayload): Promise<void> {
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
      vscode.window.showErrorMessage(`ReCost: failed to export scan results: ${message}`);
    }
  }

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
    this.outputChannel = vscode.window.createOutputChannel("ReCost AI Review");
    this.context.subscriptions.push(this.outputChannel);
    this.simulationHandler = new SimulationHandler({
      postMessage: (m) => this.postMessage(m),
      context: this.context,
      getLastEndpoints: () => this.lastEndpoints,
    });
    this.keyManagementHandler = new KeyManagementHandler({
      postMessage: (m) => this.postMessage(m),
      context: this.context,
      outputChannel: this.outputChannel,
      openKeys: (id) => this.openKeys(id),
      getManualProjectId: () => this.getManualProjectId(),
      clearProjectIdValidationState: () => this.clearProjectIdValidationState(),
      sendProjectIdStatus: () => this.sendProjectIdStatus(),
      validateManualProjectId: () => this.validateManualProjectId(),
    });
    this.chatHandler = new ChatHandler({
      postMessage: (m) => this.postMessage(m),
      outputChannel: this.outputChannel,
      context: this.context,
      getSelectedChatProvider: () => this.getSelectedChatProvider(),
      getSelectedChatModel: () => this.getSelectedChatModel(),
      getLastEndpoints: () => this.lastEndpoints,
      getLastSuggestions: () => this.lastSuggestions,
      getLastSummary: () => this.lastSummary,
      getProjectId: () => this.projectId,
      setLastSuggestions: (suggestions) => { this.lastSuggestions = suggestions; },
      setLastSummary: (summary) => { this.lastSummary = summary; },
      getKeyServiceIdForProvider: (providerId) => this.getKeyServiceIdForProvider(providerId),
      getStoredProviderApiKey: (providerId) => this.getStoredProviderApiKey(providerId),
      setValidationState: (serviceId, snapshot) => this.setValidationState(serviceId, snapshot),
      clearValidationState: (serviceId) => this.clearValidationState(serviceId),
      sendKeyStatusUpdate: (serviceId, focusServiceId) => this.sendKeyStatusUpdate(serviceId, focusServiceId),
      openKeys: (focusServiceId) => this.openKeys(focusServiceId),
    });
    this.scanPublishingHandler = new ScanPublishingHandler({
      postMessage: (m) => this.postMessage(m),
      context: this.context,
      setLastEndpoints: (endpoints) => { this.lastEndpoints = endpoints; },
      setLastSuggestions: (suggestions) => { this.lastSuggestions = suggestions; },
      setLastSummary: (summary) => { this.lastSummary = summary; },
      setLastApiCalls: (calls) => { this.lastApiCalls = calls; },
      setLastFindings: (findings) => { this.lastFindings = findings; },
      setProjectId: (id) => { this.projectId = id; },
      getProjectId: () => this.projectId,
      getManualProjectId: () => this.getManualProjectId(),
      getRcApiKey: () => this.getRcApiKey(),
      resolveScanProjectTarget: (rcApiKey) => this.resolveScanProjectTarget(rcApiKey),
      getWorkspaceName: () => this.getWorkspaceName(),
      openKeys: (focusServiceId) => this.openKeys(focusServiceId),
      setRecostValidationState: (snapshot) => this.setValidationState("recost", snapshot),
      clearRecostValidationState: () => this.clearValidationState("recost"),
      sendRecostKeyStatusUpdate: () => this.sendKeyStatusUpdate("recost", "recost"),
      resetChatHistory: () => this.chatHandler.resetHistory(),
      exportDebugScanResults: (payload) => this.exportDebugScanResults(payload),
    });
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
    return this.keyManagementHandler.getKeyServiceIdForProvider(providerId);
  }

  private async getStoredProviderApiKey(providerId: string): Promise<string | undefined> {
    return this.keyManagementHandler.getStoredProviderApiKey(providerId);
  }

  private sendChatConfig(providerId?: ChatProviderId, model?: string) {
    return this.chatHandler.sendChatConfig(providerId, model);
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

  private async sendAllKeyStatuses(focusServiceId?: KeyServiceId) {
    return this.keyManagementHandler.sendAllKeyStatuses(focusServiceId);
  }

  private async sendKeyStatusUpdate(serviceId: KeyServiceId, focusServiceId?: KeyServiceId) {
    return this.keyManagementHandler.sendKeyStatusUpdate(serviceId, focusServiceId);
  }

  private async clearServiceKey(serviceId: KeyServiceId) {
    return this.keyManagementHandler.clearServiceKey(serviceId);
  }

  private async setServiceKey(serviceId: KeyServiceId, value: string) {
    return this.keyManagementHandler.setServiceKey(serviceId, value);
  }

  private async testServiceKey(serviceId: KeyServiceId) {
    return this.keyManagementHandler.testServiceKey(serviceId);
  }

  private async handleMessage(message: WebviewMessage): Promise<void> {
    await dispatchWebviewMessage(message, {
      startScan: () => this.scanPublishingHandler.handleStartScan(),
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
      runSimulation: (input) => this.simulationHandler.handleRunSimulation(input),
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


  private handleRunAiReview() {
    return this.chatHandler.handleRunAiReview();
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

  private async clearValidationState(serviceId: KeyServiceId) {
    return this.keyManagementHandler.clearValidationState(serviceId);
  }

  private async setValidationState(serviceId: KeyServiceId, snapshot: PersistedKeyValidationSnapshot) {
    return this.keyManagementHandler.setValidationState(serviceId, snapshot);
  }

  private handleChat(text: string, provider: string, model: string) {
    return this.chatHandler.handleChat(text, provider, model);
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
