export interface ApiCallInput {
  file: string;
  line: number;
  method: string;
  url: string;
  library: string;
  frequency?: string;
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
  targetLine?: number;
  estimatedMonthlySavings: number;
  description: string;
  codeFix: string;
  source?: "remote" | "local-rule" | "ai";
  confidence?: number;
  evidence?: string[];
  reviewedAt?: string;
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

export interface ProviderPricing {
  name: string;
  perCallCostUsd: number;
  notes?: string;
}
