import * as vscode from "vscode";
import { ReCostSidebarProvider, collectLocalScanData } from "./webview-provider";
import { validateApiKey } from "./api-client";
import { syncPricingFromBackend } from "./scanner/fingerprints/registry";
import { buildSnapshot } from "./intelligence/builder";
import { scoreSnapshot } from "./intelligence/scorer";
import { buildReviewClusters } from "./intelligence/clusters";
import { compressClusters } from "./intelligence/compression";
import { buildExportContext, formatAsMarkdown } from "./intelligence/export";
import { buildKeyFingerprint, getKeyService, readStoredSecret, resolveCurrentKeyValue, type PersistedKeyValidationSnapshot } from "./key-management";
import { getOutputChannel } from "./output";
import { setIncludeTestFiles as setScannerTestFiles } from "./scanner/workspace-scanner";
import { setIncludeTestFiles as setScorerTestFiles } from "./intelligence/scorer";
import { setIncludeTestFiles as setClusterTestFiles } from "./intelligence/clusters";

const ECO_API_KEY = "recost.apiKey";
const GET_KEY_URL = "https://recost.dev/dashboard/account";
const PRICING_BACKEND_URL = "https://api.recost.dev";
const DEFAULT_SYNC_INTERVAL_HOURS = 6;
const KEY_VALIDATION_STATE_STORAGE_KEY = "recost.keyValidationState";

let activePricingSyncIntervalId: ReturnType<typeof setInterval> | null = null;

function logStatus(output: vscode.OutputChannel, message: string): void {
  const line = `[${new Date().toISOString()}] ${message}`;
  output.appendLine(line);
  console.log(`[ReCost Status] ${line}`);
}

async function updateStatusBar(
  statusBar: vscode.StatusBarItem,
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel
): Promise<boolean> {
  const key = await readStoredSecret(getKeyService("recost"), context.secrets);
  if (!key) {
    logStatus(output, "updateStatusBar: no stored ReCost key; setting keyOnline=false");
    statusBar.text = "$(key) ReCost: Not Configured";
    statusBar.tooltip = "Click to manage your ReCost API keys";
    statusBar.color = undefined;
    await vscode.commands.executeCommand("setContext", "recost.keyOnline", false);
    return false;
  }
  try {
    const user = await validateApiKey(key);
    logStatus(output, `updateStatusBar: validateApiKey succeeded for ${user.email}; setting keyOnline=true`);
    statusBar.text = `$(check) ReCost: ${user.email}`;
    statusBar.tooltip = `Connected as ${user.email}`;
    statusBar.color = new vscode.ThemeColor("testing.iconPassed");
    await vscode.commands.executeCommand("setContext", "recost.keyOnline", true);
    return true;
  } catch (err: unknown) {
    const error = err as Error & { status?: number };
    if (error.status === 401) {
      if (await hasPersistedValidEcoKey(context, output)) {
        logStatus(output, `updateStatusBar: validateApiKey returned 401 (${error.message}) but a persisted valid snapshot still exists; keeping keyOnline=true`);
        statusBar.text = "$(warning) ReCost: Auth Check Failed";
        statusBar.tooltip = "Stored ReCost key was previously validated, but the latest background auth check returned 401.";
        statusBar.color = new vscode.ThemeColor("statusBarItem.warningForeground");
        await vscode.commands.executeCommand("setContext", "recost.keyOnline", true);
        return true;
      }

      logStatus(output, `updateStatusBar: validateApiKey returned 401 (${error.message}); setting keyOnline=false`);
      statusBar.text = "$(warning) ReCost: Invalid Key";
      statusBar.tooltip = "ReCost API key is invalid. Click to manage keys.";
      statusBar.color = new vscode.ThemeColor("statusBarItem.warningForeground");
      await vscode.commands.executeCommand("setContext", "recost.keyOnline", false);
      return false;
    }

    if (await hasPersistedValidEcoKey(context, output)) {
      logStatus(output, `updateStatusBar: validateApiKey failed transiently (${error.message}); keeping keyOnline=true from persisted valid snapshot`);
      statusBar.text = "$(check) ReCost: Connected";
      statusBar.tooltip = "ReCost key is stored and was previously validated. ReCost is temporarily unreachable.";
      statusBar.color = new vscode.ThemeColor("testing.iconPassed");
      await vscode.commands.executeCommand("setContext", "recost.keyOnline", true);
      return true;
    } else {
      logStatus(output, `updateStatusBar: validateApiKey failed without trusted snapshot (${error.message}); setting keyOnline=false`);
      statusBar.text = "$(warning) ReCost: Unreachable";
      statusBar.tooltip = "Cannot reach ReCost. Check your connection.";
      statusBar.color = new vscode.ThemeColor("statusBarItem.warningForeground");
      await vscode.commands.executeCommand("setContext", "recost.keyOnline", false);
      return false;
    }
  }
}

async function hasPersistedValidEcoKey(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel
): Promise<boolean> {
  const stored =
    context.globalState.get<Partial<Record<string, PersistedKeyValidationSnapshot>>>(KEY_VALIDATION_STATE_STORAGE_KEY) ?? {};
  const snapshot = stored.recost;
  if (!snapshot || snapshot.state !== "valid") {
    logStatus(output, "hasPersistedValidEcoKey: no persisted valid ecoapi snapshot");
    return false;
  }

  const currentValue = await resolveCurrentKeyValue(getKeyService("recost"), context.secrets);
  if (!currentValue) {
    logStatus(output, "hasPersistedValidEcoKey: current ecoapi key missing");
    return false;
  }

  const matches = snapshot.keyFingerprint === buildKeyFingerprint(currentValue);
  logStatus(output, `hasPersistedValidEcoKey: fingerprint match=${matches}`);
  return matches;
}

function scheduleKeyIndicatorRefresh(
  statusBar: vscode.StatusBarItem,
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
  reason: string
): void {
  void (async () => {
    logStatus(output, `scheduleKeyIndicatorRefresh: begin reason=${reason}`);
    await updateStatusBar(statusBar, context, output);
    logStatus(output, `scheduleKeyIndicatorRefresh: end reason=${reason} text="${statusBar.text}"`);
  })().catch((err: unknown) => {
    logStatus(output, `scheduleKeyIndicatorRefresh: error reason=${reason} message=${err instanceof Error ? err.message : String(err)}`);
  });
}

export function activate(context: vscode.ExtensionContext) {
  const statusOutput = getOutputChannel();
  context.subscriptions.push(statusOutput);

  // Status bar
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = "recost.openKeys";
  statusBar.text = "$(key) ReCost: Not Configured";
  statusBar.show();
  context.subscriptions.push(statusBar);

  // Initialize context variables immediately so view/title when/enablement clauses work on first render
  vscode.commands.executeCommand("setContext", "recost.keyOnline", false);
  vscode.commands.executeCommand("setContext", "recost.scanning", false);
  vscode.commands.executeCommand("setContext", "recost.includeTestFiles", false);

  let includeTestFiles = false;

  const provider = new ReCostSidebarProvider(context, () => {
    scheduleKeyIndicatorRefresh(statusBar, context, statusOutput, "scanAuthFailure");
  });

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ReCostSidebarProvider.viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  const openPanelCommand = vscode.commands.registerCommand("recost.openPanel", () => {
    vscode.commands.executeCommand("recost.sidebarView.focus");
    scheduleKeyIndicatorRefresh(statusBar, context, statusOutput, "openPanel");
  });

  const scanCommand = vscode.commands.registerCommand("recost.scanWorkspace", () => {
    vscode.commands.executeCommand("setContext", "recost.scanning", true);
    vscode.commands.executeCommand("recost.sidebarView.focus");
    scheduleKeyIndicatorRefresh(statusBar, context, statusOutput, "scanWorkspace");
    provider.startScan();
  });

  const openKeysCommand = vscode.commands.registerCommand("recost.openKeys", () => {
    vscode.commands.executeCommand("recost.sidebarView.focus");
    scheduleKeyIndicatorRefresh(statusBar, context, statusOutput, "openKeys");
    provider.openKeys();
  });

  const toggleTestFilesCommand = vscode.commands.registerCommand("recost.toggleTestFiles", async () => {
    includeTestFiles = !includeTestFiles;
    setScannerTestFiles(includeTestFiles);
    setScorerTestFiles(includeTestFiles);
    setClusterTestFiles(includeTestFiles);
    await vscode.commands.executeCommand("setContext", "recost.includeTestFiles", includeTestFiles);
    vscode.window.showInformationMessage(
      includeTestFiles
        ? "ReCost: recost-mock-calls fixture file included in next scan."
        : "ReCost: Fixture file excluded from scan."
    );
  });

  const generateContextCommand = vscode.commands.registerCommand("recost.generateContext", async () => {
    try {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      const { apiCalls, findings, totalFilesScanned } = await collectLocalScanData();
      console.info(
        `ReCost context scan collected ${apiCalls.length} apiCalls, ${findings.length} findings, and scanned ${totalFilesScanned} files`
      );
      const snapshot = buildSnapshot({
        apiCalls,
        findings,
        repoRoot: workspaceFolder?.uri.fsPath,
        totalFilesScanned,
      });
      const scored = scoreSnapshot(snapshot);
      const reviewClusters = buildReviewClusters(scored);
      const compressedClusters = await compressClusters(reviewClusters, snapshot);
      const generatorVersion = String(context.extension.packageJSON.version ?? "");
      const exportContext = buildExportContext(compressedClusters, snapshot, scored, {
        generatorVersion: generatorVersion || undefined,
      });
      const markdown = formatAsMarkdown(exportContext);

      await vscode.env.clipboard.writeText(markdown);

      if (!workspaceFolder) {
        vscode.window.showInformationMessage("ReCost context generated: copied to clipboard");
        return;
      }

      const outputUri = vscode.Uri.joinPath(workspaceFolder.uri, ".recost-context.md");
      const bytes = new TextEncoder().encode(markdown);
      await vscode.workspace.fs.writeFile(outputUri, bytes);
      vscode.window.showInformationMessage(
        "ReCost context generated: copied to clipboard and saved to .recost-context.md"
      );

      // TODO: Add a parallel JSON export command if/when we expose formatAsJSON.
    } catch (err: unknown) {
      console.error("ReCost failed to generate context", err);
      vscode.window.showErrorMessage("ReCost failed to generate context");
    }
  });

  // Re-validate status bar whenever the ReCost API key changes in SecretStorage
  context.subscriptions.push(
    context.secrets.onDidChange(async (event) => {
      if (event.key === ECO_API_KEY) {
        logStatus(statusOutput, "secret change detected for recost.apiKey");
        await updateStatusBar(statusBar, context, statusOutput);
      }
    })
  );
  context.subscriptions.push(
    vscode.window.onDidChangeWindowState((event) => {
      if (event.focused) {
        scheduleKeyIndicatorRefresh(statusBar, context, statusOutput, "windowFocused");
      }
    })
  );
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      scheduleKeyIndicatorRefresh(statusBar, context, statusOutput, "workspaceFoldersChanged");
    })
  );

  const statusOnlineCommand = vscode.commands.registerCommand("recost.statusOnline", () => {});
  const statusLocalCommand = vscode.commands.registerCommand("recost.statusLocal", () => {});
  const scanningIndicatorCommand = vscode.commands.registerCommand("recost.scanningIndicator", () => {});

  const editIgnoreRulesCommand = vscode.commands.registerCommand("recost.editIgnoreRules", async () => {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!workspaceRoot) {
      await vscode.window.showErrorMessage("ReCost: No workspace folder open.");
      return;
    }
    const recostignoreUri = vscode.Uri.joinPath(workspaceRoot, ".recostignore");
    try {
      await vscode.workspace.fs.stat(recostignoreUri);
    } catch {
      const defaultContent = [
        "# ReCost ignore rules",
        "# Files and patterns listed here will be excluded from scanning.",
        "# Uses glob syntax — one pattern per line. Lines starting with # are comments.",
        "#",
        "# Examples:",
        "# **/*.test.ts",
        "# **/mocks/**",
        "# src/generated/**",
        "",
      ].join("\n");
      await vscode.workspace.fs.writeFile(recostignoreUri, new TextEncoder().encode(defaultContent));
    }
    const doc = await vscode.workspace.openTextDocument(recostignoreUri);
    await vscode.window.showTextDocument(doc);
  });

  context.subscriptions.push(
    openPanelCommand,
    scanCommand,
    openKeysCommand,
    toggleTestFilesCommand,
    generateContextCommand,
    statusOnlineCommand,
    statusLocalCommand,
    scanningIndicatorCommand,
    editIgnoreRulesCommand
  );

  // Pricing sync: fire-and-forget on startup, then repeat on a configurable interval
  const syncPricing = () => {
    syncPricingFromBackend(PRICING_BACKEND_URL).catch((err: unknown) => {
      console.warn("ReCost: pricing sync error", err);
    });
  };
  syncPricing();

  const intervalHours =
    vscode.workspace
      .getConfiguration("recost")
      .get<number>("pricingSyncIntervalHours") ?? DEFAULT_SYNC_INTERVAL_HOURS;
  if (activePricingSyncIntervalId !== null) {
    clearInterval(activePricingSyncIntervalId);
    activePricingSyncIntervalId = null;
  }
  activePricingSyncIntervalId = setInterval(syncPricing, intervalHours * 60 * 60 * 1_000);
  const pricingIntervalDisposer: vscode.Disposable = {
    dispose: () => {
      if (activePricingSyncIntervalId !== null) {
        clearInterval(activePricingSyncIntervalId);
        activePricingSyncIntervalId = null;
      }
    },
  };
  context.subscriptions.push(pricingIntervalDisposer);

  // Async init: update status bar on startup + show first-run notification if no key
  (async () => {
    scheduleKeyIndicatorRefresh(statusBar, context, statusOutput, "activate");
    const existingKey = await readStoredSecret(getKeyService("recost"), context.secrets);
    if (!existingKey) {
      const choice = await vscode.window.showInformationMessage(
        "ReCost API key not configured. Open Keys to set up your API key.",
        "Open Keys",
        "Get a key"
      );
      if (choice === "Open Keys") {
        vscode.commands.executeCommand("recost.openKeys");
      } else if (choice === "Get a key") {
        await vscode.env.openExternal(vscode.Uri.parse(GET_KEY_URL));
      }
    }
  })().catch((err: unknown) => {
    console.error("ReCost: init error", err);
  });
}

export function deactivate(): void {
  if (activePricingSyncIntervalId !== null) {
    clearInterval(activePricingSyncIntervalId);
    activePricingSyncIntervalId = null;
  }
}
