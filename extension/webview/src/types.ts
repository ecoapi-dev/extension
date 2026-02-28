// Mirrors the types from the extension host for use in the webview

export type EndpointStatus =
  | "normal"
  | "redundant"
  | "cacheable"
  | "batchable"
  | "n_plus_one_risk"
  | "rate_limit_risk";

export type SuggestionType = "cache" | "batch" | "redundancy" | "n_plus_one" | "rate_limit";
export type Severity = "high" | "medium" | "low";

export interface EndpointRecord {
  id: string;
  projectId: string;
  scanId: string;
  provider: string;
  method: string;
  url: string;
  files: string[];
  callSites: { file: string; line: number; library: string; frequency?: string }[];
  callsPerDay: number;
  monthlyCost: number;
  status: EndpointStatus;
}

export interface Suggestion {
  id: string;
  projectId: string;
  scanId: string;
  type: SuggestionType;
  severity: Severity;
  affectedEndpoints: string[];
  affectedFiles: string[];
  estimatedMonthlySavings: number;
  description: string;
  codeFix: string;
}

export interface ScanSummary {
  totalEndpoints: number;
  totalCallsPerDay: number;
  totalMonthlyCost: number;
  highRiskCount: number;
}

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
