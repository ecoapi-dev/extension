export type CostModel = "per_token" | "per_transaction" | "per_request" | "free";
export type Language =
  | "javascript"
  | "typescript"
  | "python"
  | "go"
  | "java"
  | "ruby"
  | "rust";

export interface MethodFingerprint {
  /**
   * SDK method chain pattern, e.g. "chat.completions.create".
   * Either `pattern` or `urlPathKey` must be set on every entry.
   */
  pattern?: string;
  /**
   * URL-path substring used by `lookupByUrlPath` when an API call has a known
   * provider but no SDK method chain (e.g. raw `fetch(...)`). The matcher tries
   * the longest `urlPathKey` first; the special value `"_default"` is a
   * provider-wide fallback (A7, issue #79).
   */
  urlPathKey?: string;
  /** HTTP verb: GET | POST | PUT | PATCH | DELETE | SUBSCRIBE | RPC */
  httpMethod: string;
  /** Full URL or URL template for the mapped endpoint */
  endpoint: string;
  costModel: CostModel;
  /** USD per 1M input tokens (for per_token cost model) */
  inputPricePer1M?: number;
  /** USD per 1M output tokens (for per_token cost model) */
  outputPricePer1M?: number;
  /** Flat USD fee per call (for per_transaction cost model) */
  fixedFee?: number;
  /** Fractional percentage fee, e.g. 0.029 for 2.9% */
  percentageFee?: number;
  /** Fixed USD cost per request (for per_request cost model) */
  perRequestCostUsd?: number;
  streaming?: boolean;
  batchCapable?: boolean;
  cacheCapable?: boolean;
  /** Human-readable description of what this method does */
  description?: string;
}

export interface HostPattern {
  /** Hostname string (exact) or regex string when isRegex is true */
  pattern: string;
  /** When true, pattern is a regex; when false/omitted, pattern is an exact hostname */
  isRegex?: boolean;
  /**
   * When set, lookupHost() returns this provider id instead of the file's top-level
   * provider. Useful for grouping multiple distinct providers into one JSON file.
   */
  provider?: string;
}

export interface ProviderFingerprint {
  schemaVersion: string;
  /** Machine-readable provider ID, e.g. "openai" */
  provider: string;
  /** Human-readable display name, e.g. "OpenAI" */
  displayName: string;
  languages: Language[];
  /** Package names (npm, pip, etc.) for this SDK */
  packages: string[];
  hosts: HostPattern[];
  methods: MethodFingerprint[];
}
