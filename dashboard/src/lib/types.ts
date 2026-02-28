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

export interface PaginationMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasNext: boolean;
  hasPrev: boolean;
}
