export type SortOrder = "asc" | "desc";

export interface ApiCallInput {
  file: string;
  line: number;
  method: string;
  url: string;
  library: string;
  frequency?: string;
}

export interface ProjectInput {
  name: string;
  description?: string;
  apiCalls?: ApiCallInput[];
}

export interface ScanInput {
  apiCalls: ApiCallInput[];
}

export interface Project {
  id: string;
  name: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
  latestScanId?: string;
}

export interface ProjectWithSummary extends Project {
  summary: {
    scans: number;
    endpoints: number;
    callsPerDay: number;
    monthlyCost: number;
  };
}

export interface Scan {
  id: string;
  projectId: string;
  createdAt: string;
  endpointIds: string[];
  suggestionIds: string[];
  graph: GraphData;
  summary: ScanSummary;
}

export interface ScanSummary {
  totalEndpoints: number;
  totalCallsPerDay: number;
  totalMonthlyCost: number;
  highRiskCount: number;
}

export type EndpointStatus =
  | "normal"
  | "redundant"
  | "cacheable"
  | "batchable"
  | "n_plus_one_risk"
  | "rate_limit_risk";

export interface EndpointRecord {
  id: string;
  projectId: string;
  scanId: string;
  provider: string;
  method: string;
  url: string;
  files: string[];
  callSites: EndpointCallSite[];
  callsPerDay: number;
  monthlyCost: number;
  status: EndpointStatus;
}

export interface EndpointCallSite {
  file: string;
  line: number;
  library: string;
  frequency?: string;
}

export type SuggestionType =
  | "cache"
  | "batch"
  | "redundancy"
  | "n_plus_one"
  | "rate_limit";

export type Severity = "high" | "medium" | "low";

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

export interface GraphNode {
  id: string;
  label: string;
  provider: string;
  monthlyCost: number;
  callsPerDay: number;
  status: EndpointStatus;
  group: string;
}

export interface GraphEdge {
  source: string;
  target: string;
  line: number;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface CostSummary {
  totalMonthlyCost: number;
  totalCallsPerDay: number;
  endpointCount: number;
}

export interface ProviderCost {
  provider: string;
  monthlyCost: number;
  callsPerDay: number;
  endpointCount: number;
}

export interface SustainabilityData {
  electricity: { dailyKwh: number; monthlyKwh: number };
  water: { dailyLiters: number; monthlyLiters: number };
  co2: { dailyGrams: number; monthlyGrams: number };
  aiCallsPerDay: number;
  totalCallsPerDay: number;
  aiCallsPercentage: number;
  byProvider: {
    provider: string;
    isAi: boolean;
    callsPerDay: number;
    dailyKwh: number;
    dailyWaterLiters: number;
    dailyCo2Grams: number;
  }[];
}

export interface PaginationMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasNext: boolean;
  hasPrev: boolean;
}

// ─── Simulator types ──────────────────────────────────────────────────────────

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

export interface SavedScenario {
  id: string;
  label: string;
  input: SimulatorInput;
  result: SimulatorResult;
  createdAt: string;
}

export const SCALE_PRESETS = [
  { label: "1K", dau: 1_000, volume: 1_000 },
  { label: "10K", dau: 10_000, volume: 10_000 },
  { label: "50K", dau: 50_000, volume: 100_000 },
  { label: "100K", dau: 100_000, volume: 1_000_000 },
] as const;
