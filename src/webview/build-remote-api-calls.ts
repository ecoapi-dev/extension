import type { ApiCallInput } from "../analysis/types";

export interface RemoteSubmitBuild {
  submitted: ApiCallInput[];
  unknownProviderCount: number;
  unknownProviderHosts: Record<string, number>;
}

export function buildRemoteApiCalls(_apiCalls: ApiCallInput[]): RemoteSubmitBuild {
  throw new Error("not implemented");
}
