import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { get, post, del } from "./api";
import type {
  Project,
  ProjectWithSummary,
  ProjectInput,
  Scan,
  ScanInput,
  EndpointRecord,
  Suggestion,
  GraphData,
  CostSummary,
  ProviderCost,
  PaginationMeta,
} from "./types";

// ── Projects ──

export function useProjects(params?: { page?: number; limit?: number; name?: string }) {
  return useQuery({
    queryKey: ["projects", params],
    queryFn: () =>
      get<{ data: Project[]; pagination: PaginationMeta }>("/projects", {
        page: params?.page,
        limit: params?.limit,
        name: params?.name,
      }),
  });
}

export function useProject(id: string | undefined) {
  return useQuery({
    queryKey: ["project", id],
    queryFn: () => get<{ data: ProjectWithSummary }>(`/projects/${id}`),
    enabled: !!id,
  });
}

export function useCreateProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: ProjectInput) => post<{ data: Project }>("/projects", input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["projects"] }),
  });
}

export function useDeleteProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => del(`/projects/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["projects"] }),
  });
}

// ── Scans ──

export function useScans(projectId: string | undefined, params?: { page?: number; limit?: number }) {
  return useQuery({
    queryKey: ["scans", projectId, params],
    queryFn: () =>
      get<{ data: Scan[]; pagination: PaginationMeta }>(`/projects/${projectId}/scans`, {
        page: params?.page,
        limit: params?.limit,
      }),
    enabled: !!projectId,
  });
}

export function useLatestScan(projectId: string | undefined) {
  return useQuery({
    queryKey: ["scans", projectId, "latest"],
    queryFn: () => get<{ data: Scan }>(`/projects/${projectId}/scans/latest`),
    enabled: !!projectId,
  });
}

export function useCreateScan(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: ScanInput) => post<{ data: Scan }>(`/projects/${projectId}/scans`, input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["project", projectId] });
      qc.invalidateQueries({ queryKey: ["scans", projectId] });
      qc.invalidateQueries({ queryKey: ["cost", projectId] });
      qc.invalidateQueries({ queryKey: ["endpoints", projectId] });
      qc.invalidateQueries({ queryKey: ["suggestions", projectId] });
      qc.invalidateQueries({ queryKey: ["graph", projectId] });
    },
  });
}

// ── Cost ──

export function useCost(projectId: string | undefined) {
  return useQuery({
    queryKey: ["cost", projectId],
    queryFn: () => get<{ data: CostSummary }>(`/projects/${projectId}/cost`),
    enabled: !!projectId,
  });
}

export function useCostByProvider(projectId: string | undefined) {
  return useQuery({
    queryKey: ["cost", projectId, "by-provider"],
    queryFn: () =>
      get<{ data: ProviderCost[]; pagination: PaginationMeta }>(
        `/projects/${projectId}/cost/by-provider`,
      ),
    enabled: !!projectId,
  });
}

// ── Endpoints ──

export function useEndpoints(
  projectId: string | undefined,
  params?: {
    provider?: string;
    status?: string;
    method?: string;
    sort?: string;
    order?: string;
    page?: number;
    limit?: number;
  },
) {
  return useQuery({
    queryKey: ["endpoints", projectId, params],
    queryFn: () =>
      get<{ data: EndpointRecord[]; pagination: PaginationMeta }>(
        `/projects/${projectId}/endpoints`,
        params as Record<string, string | number | undefined>,
      ),
    enabled: !!projectId,
  });
}

// ── Suggestions ──

export function useSuggestions(
  projectId: string | undefined,
  params?: {
    type?: string;
    severity?: string;
    sort?: string;
    order?: string;
    page?: number;
    limit?: number;
  },
) {
  return useQuery({
    queryKey: ["suggestions", projectId, params],
    queryFn: () =>
      get<{ data: Suggestion[]; pagination: PaginationMeta }>(
        `/projects/${projectId}/suggestions`,
        params as Record<string, string | number | undefined>,
      ),
    enabled: !!projectId,
  });
}

// ── Graph ──

export function useGraph(projectId: string | undefined, clusterBy?: string) {
  return useQuery({
    queryKey: ["graph", projectId, clusterBy],
    queryFn: () =>
      get<{ data: GraphData }>(`/projects/${projectId}/graph`, {
        cluster_by: clusterBy,
      }),
    enabled: !!projectId,
  });
}
