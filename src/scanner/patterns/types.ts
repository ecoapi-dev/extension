import type { SourceSpan } from "../source-span";

export type ApiCallKind = "http" | "sdk" | "route" | "graphql" | "rpc";

export interface HttpCallMatch {
  method: string;
  url: string;
  library: string;
  span?: SourceSpan;
}

export interface ApiCallMatch {
  kind: ApiCallKind;
  provider?: string;
  sdk?: string;
  method?: string;
  endpoint?: string;
  resource?: string;
  action?: string;
  operationName?: string;
  host?: string;
  loopContext?: boolean;
  streaming?: boolean;
  batchCapable?: boolean;
  cacheCapable?: boolean;
  inferredCostRisk?: string[];
  rawMatch?: string;
  span?: SourceSpan;
}

export interface LineMatcher {
  name: string;
  matchLine: (line: string) => ApiCallMatch[];
}
