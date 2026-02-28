import * as vscode from "vscode";
import { scanWorkspace } from "./scanner/workspace-scanner";
import { createProject, submitScan, getAllEndpoints, getAllSuggestions } from "./api-client";
import { buildSystemPrompt } from "./chat/prompts";
import type { WebviewMessage, HostMessage } from "./messages";
import type { EndpointRecord, Suggestion, ScanSummary } from "./analysis/types";

const MODELS = {
  "gpt-4o-mini": { id: "gpt-4o-mini", name: "GPT-4o Mini" },
  "gpt-4o": { id: "gpt-4o", name: "GPT-4o" },
  "gpt-4.1-mini": { id: "gpt-4.1-mini", name: "GPT-4.1 Mini" },
  "gpt-4.1": { id: "gpt-4.1", name: "GPT-4.1" },
  "o1-mini": { id: "o1-mini", name: "o1 Mini" },
  "o3-mini": { id: "o3-mini", name: "o3 Mini" },
  "o1": { id: "o1", name: "o1" },
  "o3": { id: "o3", name: "o3" },
} as const;

type ModelId = keyof typeof MODELS;

function isOpenAIModel(model: string): boolean {
  return model in MODELS;
}

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
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

  // Chat state
  private chatHistory: ChatMessage[] = [];

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
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
        await this.handleApplyFix(message.code, message.file);
        break;
      case "openFile":
        await this.handleOpenFile(message.file, message.line);
        break;
    }
  }

  private async handleStartScan() {
    try {
      this.chatHistory = [];

      const apiCalls = await scanWorkspace((progress) => {
        this.postMessage({
          type: "scanProgress",
          file: progress.file,
          index: progress.index,
          total: progress.total,
          endpointsSoFar: progress.endpointsSoFar,
        });
      });

      this.postMessage({ type: "scanComplete" });

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
      const projectId = await this.getOrCreateProject();

      // Submit scan and fetch results
      let scanResult;
      try {
        scanResult = await submitScan(projectId, apiCalls);
      } catch (err: unknown) {
        // Project may have been deleted — create a fresh one and retry once
        if ((err as { status?: number }).status === 404) {
          const freshId = await createProject(this.getWorkspaceName());
          this.projectId = freshId;
          await this.context.globalState.update("eco.projectId", freshId);
          scanResult = await submitScan(freshId, apiCalls);
        } else {
          throw err;
        }
      }

      const [endpoints, suggestions] = await Promise.all([
        getAllEndpoints(projectId, scanResult.scanId),
        getAllSuggestions(projectId, scanResult.scanId),
      ]);

      this.lastEndpoints = endpoints;
      this.lastSuggestions = suggestions;
      this.lastSummary = scanResult.summary;

      this.postMessage({
        type: "scanResults",
        endpoints,
        suggestions,
        summary: scanResult.summary,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Unknown error during scan";
      this.postMessage({ type: "error", message });
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

    try {
      const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: MODELS[modelId].id,
          messages: this.buildMessages(text),
          temperature: 0.7,
          stream: true,
        }),
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
        const errMsg = (errData as { error?: { message?: string } })?.error?.message ?? "API request failed";
        this.postMessage({ type: "chatError", message: errMsg });
        return;
      }

      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let fullContent = "";
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

      this.chatHistory.push({ role: "user", content: text });
      this.chatHistory.push({ role: "assistant", content: fullContent });

      this.postMessage({ type: "chatDone", fullContent });
    } catch {
      this.postMessage({ type: "chatError", message: "Network error. Check your connection." });
    }
  }

  private async handleApplyFix(code: string, file: string) {
    try {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (!workspaceFolder) return;

      const fileUri = vscode.Uri.joinPath(workspaceFolder.uri, file);
      const doc = await vscode.workspace.openTextDocument(fileUri);
      const editor = await vscode.window.showTextDocument(doc);

      const position = editor.selection.active;
      await editor.edit((editBuilder) => {
        editBuilder.insert(position, code);
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to apply fix";
      vscode.window.showErrorMessage(`ECO: ${message}`);
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
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${webview.cspSource};">
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
