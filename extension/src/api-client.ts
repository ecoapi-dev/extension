import type { ApiCallInput, EndpointRecord, Suggestion, ScanSummary } from "./analysis/types";

const BASE_URL = "https://api.ecoapi.dev";

interface ApiError {
  error?: { message?: string };
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as ApiError;
    const msg = body?.error?.message ?? `API error ${res.status}`;
    const err = new Error(msg) as Error & { status: number };
    err.status = res.status;
    throw err;
  }
  return res.json() as Promise<T>;
}

export async function createProject(name: string): Promise<string> {
  const { data } = await apiFetch<{ data: { id: string } }>("/projects", {
    method: "POST",
    body: JSON.stringify({ name }),
  });
  return data.id;
}

export interface ScanResult {
  scanId: string;
  summary: ScanSummary;
}

export async function submitScan(projectId: string, apiCalls: ApiCallInput[]): Promise<ScanResult> {
  const { data } = await apiFetch<{ data: { id: string; summary: ScanSummary } }>(
    `/projects/${projectId}/scans`,
    { method: "POST", body: JSON.stringify({ apiCalls }) }
  );
  return { scanId: data.id, summary: data.summary };
}

export async function getAllEndpoints(projectId: string, scanId: string): Promise<EndpointRecord[]> {
  const results: EndpointRecord[] = [];
  let page = 1;
  while (true) {
    const { data, pagination } = await apiFetch<{
      data: EndpointRecord[];
      pagination: { hasNext: boolean };
    }>(`/projects/${projectId}/endpoints?scanId=${scanId}&limit=100&page=${page}`);
    results.push(...data);
    if (!pagination.hasNext) break;
    page++;
  }
  return results;
}

export async function getAllSuggestions(projectId: string, scanId: string): Promise<Suggestion[]> {
  const results: Suggestion[] = [];
  let page = 1;
  while (true) {
    const { data, pagination } = await apiFetch<{
      data: Suggestion[];
      pagination: { hasNext: boolean };
    }>(`/projects/${projectId}/suggestions?scanId=${scanId}&limit=100&page=${page}`);
    results.push(...data);
    if (!pagination.hasNext) break;
    page++;
  }
  return results;
}
