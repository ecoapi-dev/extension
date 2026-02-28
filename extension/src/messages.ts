import type { EndpointRecord, Suggestion, ScanSummary } from "./analysis/types";

// Webview -> Host messages
export type WebviewMessage =
  | { type: "startScan" }
  | { type: "chat"; text: string; model: string }
  | { type: "setApiKey"; key: string }
  | { type: "modelChanged"; model: string }
  | { type: "applyFix"; code: string; file: string }
  | { type: "openFile"; file: string; line?: number };

export interface SuggestionContext {
  type: string;
  description: string;
  files: string[];
  codeFix?: string;
  severity?: string;
  estimatedMonthlySavings?: number;
}

// Host -> Webview messages
export type HostMessage =
  | { type: "triggerScan" }
  | { type: "scanProgress"; file: string; index: number; total: number; endpointsSoFar: number }
  | { type: "scanComplete" }
  | { type: "scanResults"; endpoints: EndpointRecord[]; suggestions: Suggestion[]; summary: ScanSummary }
  | { type: "chatStreaming"; chunk: string }
  | { type: "chatDone"; fullContent: string }
  | { type: "chatError"; message: string }
  | { type: "needsApiKey"; message?: string }
  | { type: "apiKeyStored" }
  | { type: "apiKeyError"; message: string }
  | { type: "apiKeyCleared" }
  | { type: "error"; message: string };
