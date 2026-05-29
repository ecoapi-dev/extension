/** Mirror of src/scanner/source-span.ts — kept in sync manually. Lines 1-based, columns 0-based exclusive. */
export interface SourceSpan {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

export type EndpointStatus =
  | "normal"
  | "redundant"
  | "cacheable"
  | "batchable"
  | "n_plus_one_risk"
  | "rate_limit_risk";

export type SuggestionType = "cache" | "batch" | "redundancy" | "n_plus_one" | "rate_limit" | "concurrency_control";
export type Severity = "high" | "medium" | "low";

export interface EndpointRecord {
  id: string;
  projectId: string;
  scanId: string;
  provider: string;
  scope?: "internal" | "external" | "unknown";
  method: string;
  url: string;
  files: string[];
  callSites: {
    file: string;
    line: number;
    span?: SourceSpan;
    library: string;
    frequency?: string;
    frequencyClass?: string;
    crossFileOrigin?: { file: string; functionName: string } | null;
  }[];
  callsPerDay: number;
  monthlyCost: number;
  status: EndpointStatus;
  // Enriched fields from AST engine
  methodSignature?: string;
  costModel?: "per_token" | "per_transaction" | "per_request" | "free";
  frequencyClass?: string;
  batchCapable?: boolean;
  inlineParallelCapable?: boolean;
  cacheCapable?: boolean;
  streaming?: boolean;
  isMiddleware?: boolean;
  crossFileOrigins?: { file: string; functionName: string }[];
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
  pricingClass?: "paid" | "free" | "unknown";
  sources?: string[];
  costImpactUsd?: number | null;
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

export interface ChatModelOption {
  id: string;
  displayName: string;
  providerId: string;
  supportsStreaming: boolean;
}

export interface ChatProviderOption {
  id: string;
  displayName: string;
  envKeyName?: string;
  baseUrl: string;
  defaultChatEndpoint: string;
  authHeaderFormat: string;
  supportsStreaming: boolean;
  models: ChatModelOption[];
}

export type KeyServiceId =
  | "recost"
  | "openai"
  | "anthropic"
  | "gemini"
  | "xai"
  | "cohere"
  | "mistral"
  | "perplexity";

export type KeyStatusState =
  | "missing"
  | "saved"
  | "valid"
  | "invalid"
  | "from_environment"
  | "checking";

export type KeyStatusSource = "missing" | "secret" | "env";

export type ProjectIdStatusState = "missing" | "checking" | "valid" | "invalid";

export interface KeyStatusSummary {
  serviceId: KeyServiceId;
  displayName: string;
  kind: "recost" | "provider";
  providerId?: string;
  envKeyName?: string;
  source: KeyStatusSource;
  state: KeyStatusState;
  message?: string;
  maskedPreview?: string;
  lastCheckedAt?: string;
  supportsTest: boolean;
}

export interface ProjectIdStatusSummary {
  value: string | null;
  state: ProjectIdStatusState;
  message?: string;
  lastCheckedAt?: string;
}

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
  costModel?: "per_token" | "per_transaction" | "per_request" | "free";
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

export type HostMessage =
  | { type: "triggerScan" }
  | { type: "scanProgress"; stage: "scanning"; file: string; fileIndex: number; fileTotal: number }
  | { type: "scanProgress"; stage: "analyzing" | "detecting" | "resolving" }
  | { type: "scanComplete" }
  | { type: "scanResults"; endpoints: EndpointRecord[]; suggestions: Suggestion[]; summary: ScanSummary }
  | { type: "aiReviewProgress"; stage: string; current?: number; total?: number }
  | { type: "aiReviewComplete"; added: number; filtered: number }
  | { type: "aiReviewError"; message: string }
  | { type: "chatStreaming"; chunk: string }
  | { type: "chatDone"; fullContent: string }
  | { type: "chatError"; message: string }
  | { type: "chatConfig"; providers: ChatProviderOption[]; selectedProvider: string; selectedModel: string }
  | { type: "allKeyStatuses"; statuses: KeyStatusSummary[]; focusServiceId?: KeyServiceId }
  | { type: "keyStatusUpdated"; status: KeyStatusSummary; focusServiceId?: KeyServiceId }
  | { type: "keyActionError"; serviceId: KeyServiceId; message: string }
  | { type: "projectIdStatus"; status: ProjectIdStatusSummary }
  | { type: "navigate"; screen: "landing" | "findings" | "chat" | "simulate" | "keys"; focusServiceId?: KeyServiceId }
  | { type: "error"; message: string }
  | { type: "scanNotification"; message: string }
  | { type: "simulationResult"; result: SimulatorResult }
  | { type: "simulationError"; message: string };
