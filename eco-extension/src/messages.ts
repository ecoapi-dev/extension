import type { EndpointRecord, Suggestion, ScanSummary } from "./analysis/types";

// Webview -> Host messages
export type WebviewMessage =
  | { type: "startScan" }
  | { type: "chatMessage"; text: string; context?: SuggestionContext | null }
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
  | { type: "scanProgress"; file: string; index: number; total: number; endpointsSoFar: number }
  | { type: "scanComplete" }
  | { type: "scanResults"; endpoints: EndpointRecord[]; suggestions: Suggestion[]; summary: ScanSummary }
  | { type: "chatStreaming"; chunk: string }
  | { type: "chatDone"; fullContent: string }
  | { type: "error"; message: string };
