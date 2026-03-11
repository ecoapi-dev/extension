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
  targetLine?: number;
  estimatedMonthlySavings: number;
  description: string;
  codeFix: string;
  source?: "remote" | "local-rule" | "ai";
  confidence?: number;
  evidence?: string[];
  reviewedAt?: string;
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
  targetFile?: string;
  targetLine?: number;
}

// ─── Simulator types (mirrors src/simulator/types.ts) ─────────────────────────

export type InputMode = "user-centric" | "volume-centric";

export interface SimulatorInput {
  mode: InputMode;
  dau?: number;
  callsPerUserPerDay?: number;
  totalCallsPerDay?: number;
  frequencyOverrides?: Record<string, number>;
}

export type ConfidenceLevel = "low" | "medium" | "high";

export interface CostRange {
  low: number;
  mid: number;
  high: number;
}

export interface EndpointSimResult {
  endpointId: string;
  provider: string;
  method: string;
  url: string;
  scaledCallsPerDay: number;
  dailyCost: CostRange;
  monthlyCost: CostRange;
  percentOfTotal: number;
}

export interface ProviderSimResult {
  provider: string;
  endpoints: EndpointSimResult[];
  dailyCost: CostRange;
  monthlyCost: CostRange;
  percentOfTotal: number;
}

export interface SimulatorResult {
  input: SimulatorInput;
  totalDailyCost: CostRange;
  totalMonthlyCost: CostRange;
  byProvider: ProviderSimResult[];
  confidence: ConfidenceLevel;
  computedAt: string;
}

export const SCALE_PRESETS = [
  { label: "1K", dau: 1_000, volume: 1_000 },
  { label: "10K", dau: 10_000, volume: 10_000 },
  { label: "50K", dau: 50_000, volume: 100_000 },
  { label: "100K", dau: 100_000, volume: 1_000_000 },
] as const;

// Host -> Webview messages
export type HostMessage =
  | { type: "triggerScan" }
  | { type: "scanProgress"; file: string; index: number; total: number; endpointsSoFar: number }
  | { type: "scanComplete" }
  | { type: "scanResults"; endpoints: EndpointRecord[]; suggestions: Suggestion[]; summary: ScanSummary }
  | { type: "aiReviewProgress"; stage: string; current?: number; total?: number }
  | { type: "aiReviewComplete"; added: number; filtered: number }
  | { type: "aiReviewError"; message: string }
  | { type: "chatStreaming"; chunk: string }
  | { type: "chatDone"; fullContent: string }
  | { type: "chatError"; message: string }
  | { type: "needsApiKey"; message?: string }
  | { type: "apiKeyStored" }
  | { type: "apiKeyError"; message: string }
  | { type: "apiKeyCleared" }
  | { type: "error"; message: string }
  | { type: "simulationResult"; result: SimulatorResult }
  | { type: "simulationError"; message: string };
