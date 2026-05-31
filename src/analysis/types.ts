import type { SourceSpan } from "../scanner/source-span";

export interface ApiCallInput {
  file: string;
  line: number;
  /** Full span of the call expression. Optional only because synthetic test inputs may omit it. */
  span?: SourceSpan;
  method: string;
  url: string;
  library?: string;
  frequency?: string;
  // Enriched fields from AST engine
  provider?: string;
  methodSignature?: string;
  /** Populated by the AST path only; undefined when the regex fallback emits the call. */
  enclosingFunction?: string | null;
  costModel?: "per_token" | "per_transaction" | "per_request" | "free";
  frequencyClass?: "single" | "bounded-loop" | "unbounded-loop" | "parallel" | "polling" | "conditional" | "cache-guarded";
  batchCapable?: boolean;
  inlineParallelCapable?: boolean;
  cacheCapable?: boolean;
  streaming?: boolean;
  isMiddleware?: boolean;
  crossFileOrigin?: { file: string; functionName: string } | null;
  /** Dual-location trace. Set by the AST path for cross-file calls; undefined otherwise. */
  callTrace?: import("../scanner/call-trace").CallTrace;
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
  scope?: "internal" | "external" | "unknown";
  method: string;
  url: string;
  files: string[];
  callSites: EndpointCallSite[];
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

export interface EndpointCallSite {
  file: string;
  line: number;
  /** Full span of the call expression. Optional only because synthetic test inputs may omit it. */
  span?: SourceSpan;
  library: string;
  frequency?: string;
  // Enriched fields from AST engine
  frequencyClass?: string;
  crossFileOrigin?: { file: string; functionName: string } | null;
  /** Dual-location trace for this call site. Degenerate (hops=0) for direct calls. */
  callTrace?: import("../scanner/call-trace").CallTrace;
}

export type SuggestionType =
  | "cache"
  | "batch"
  | "redundancy"
  | "n_plus_one"
  | "rate_limit"
  | "concurrency_control"
  | "unbatched_parallel";

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
  sources?: string[];
  costImpactUsd?: number | null;
  confidence?: number;
  evidence?: string[];
  reviewedAt?: string;
  pricingClass?: "paid" | "free" | "unknown";
}

export interface GraphNode {
  id: string;
  label: string;
  provider: string;
  monthlyCost: number;
  callsPerDay: number;
  status: EndpointStatus;
  group: string;
  frequencyClass?: string;
  costModel?: "per_token" | "per_transaction" | "per_request" | "free";
}

export interface GraphEdge {
  source: string;
  target: string;
  line: number;
  crossFile?: boolean;
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
