// ─── Input ───────────────────────────────────────────────────────────────────

export type InputMode = "user-centric" | "volume-centric";

export interface SimulatorInput {
  mode: InputMode;
  /** User-centric mode: daily active users */
  dau?: number;
  /** User-centric mode: calls per user per day (default: 1) */
  callsPerUserPerDay?: number;
  /** Volume-centric mode: total calls per day */
  totalCallsPerDay?: number;
  /** Per-endpoint frequency multiplier overrides, keyed by endpoint id */
  frequencyOverrides?: Record<string, number>;
}

// ─── Data source abstraction (enables future telemetry swap-in) ───────────────

export interface EndpointSnapshot {
  id: string;
  provider: string;
  method: string;
  url: string;
  /** Baseline daily calls from scan (used to compute per-endpoint share) */
  baseCallsPerDay: number;
  /** Estimated cost per single call in USD */
  perCallCost: number;
}

export interface SimulatorDataSource {
  getEndpoints(): EndpointSnapshot[];
}

// ─── Output ───────────────────────────────────────────────────────────────────

export type ConfidenceLevel = "low" | "medium" | "high";

/** A cost expressed as a ±30% range */
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

// ─── Scenarios (dashboard) ────────────────────────────────────────────────────

export interface SavedScenario {
  id: string;
  label: string;
  input: SimulatorInput;
  result: SimulatorResult;
  createdAt: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

export const UNCERTAINTY_FACTOR = 0.3;

export const SCALE_PRESETS = [
  { label: "1K", dau: 1_000, volume: 1_000 },
  { label: "10K", dau: 10_000, volume: 10_000 },
  { label: "50K", dau: 50_000, volume: 100_000 },
  { label: "100K", dau: 100_000, volume: 1_000_000 },
] as const;
