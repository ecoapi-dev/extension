import * as vscode from "vscode";
import { EcoPanel } from "./webview-provider";

export function activate(context: vscode.ExtensionContext) {
  const openPanelCommand = vscode.commands.registerCommand("eco.openPanel", () => {
    EcoPanel.createOrShow(context.extensionUri);
  });

  const scanCommand = vscode.commands.registerCommand("eco.scanWorkspace", () => {
    EcoPanel.createOrShow(context.extensionUri);
    // Small delay to ensure panel is ready, then trigger scan
    setTimeout(() => {
      if (EcoPanel.currentPanel) {
        vscode.commands.executeCommand("eco.openPanel");
      }
    }, 500);
  });

  context.subscriptions.push(openPanelCommand, scanCommand);
}

export function deactivate() {}
