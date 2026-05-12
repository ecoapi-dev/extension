import type { ApiCallInput } from "../analysis/types";
import type { LocalWasteFinding } from "../scanner/local-waste-detector";
import type { ApiCallNode, FileNode, FindingNode, ProviderNode, RepoIntelligenceSnapshot } from "./types";

export interface BuildRepoIntelligenceSnapshotInput {
  apiCalls: ApiCallInput[];
  findings: LocalWasteFinding[];
  repoRoot?: string;
  totalFilesScanned?: number;
}

function normalizeRepoPath(filePath: string): string {
  return filePath.replace(/\\/g, "/").replace(/^\.\/+/, "");
}

function normalizeProvider(provider: string | undefined): string | null {
  return provider ?? null;
}

function normalizeCrossFileOrigin(
  origin: ApiCallInput["crossFileOrigin"]
): { file: string; functionName: string } | null {
  if (!origin) return null;
  return {
    file: normalizeRepoPath(origin.file),
    functionName: origin.functionName,
  };
}

function makeStableApiCallFingerprint(call: ApiCallInput): string {
  const origin = normalizeCrossFileOrigin(call.crossFileOrigin);
  const source = [
    call.method,
    call.url,
    call.provider ?? "null",
    call.library ?? "null",
    call.methodSignature ?? "null",
    call.costModel ?? "null",
    call.frequencyClass ?? "null",
    call.batchCapable ? "1" : "0",
    call.cacheCapable ? "1" : "0",
    call.streaming ? "1" : "0",
    call.isMiddleware ? "1" : "0",
    origin ? `${origin.file}:${origin.functionName}` : "null",
  ].join("|");

  let hash = 2166136261;
  for (let i = 0; i < source.length; i += 1) {
    hash ^= source.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function makeApiCallId(filePath: string, call: ApiCallInput): string {
  return `${filePath}:${call.line}:${makeStableApiCallFingerprint(call)}`;
}

function makeStableFingerprint(finding: LocalWasteFinding): string {
  const source = `${finding.description}|${finding.evidence.join("|")}`;
  let hash = 2166136261;
  for (let i = 0; i < source.length; i += 1) {
    hash ^= source.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function makeFindingId(filePath: string, finding: LocalWasteFinding, index: number): string {
  if (finding.id) return finding.id;
  return `finding:${filePath}:${finding.line ?? "null"}:${finding.type}:${makeStableFingerprint(finding)}:${index}`;
}

function ensureUniqueId<T>(collection: Record<string, T>, id: string, label: string): void {
  if (collection[id]) {
    throw new Error(`Duplicate ${label} id: ${id}`);
  }
}

function linkFindingToNearestCall(
  fileApiCalls: ApiCallNode[],
  line: number | null
): ApiCallNode | null {
  if (line === null || fileApiCalls.length === 0) return null;

  let nearest: ApiCallNode | null = null;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const apiCall of fileApiCalls) {
    const distance = Math.abs(apiCall.line - line);
    if (distance < nearestDistance) {
      nearest = apiCall;
      nearestDistance = distance;
    }
  }
  return nearest;
}

function validateSnapshot(snapshot: RepoIntelligenceSnapshot): void {
  for (const file of Object.values(snapshot.files)) {
    for (const apiCallId of file.apiCallIds) {
      if (!snapshot.apiCalls[apiCallId]) {
        throw new Error(`Invalid apiCall reference: ${apiCallId}`);
      }
    }
    for (const findingId of file.findingIds) {
      if (!snapshot.findings[findingId]) {
        throw new Error(`Invalid finding reference: ${findingId}`);
      }
    }

    const expectedProviders = Array.from(
      new Set(
        file.apiCallIds
          .map((apiCallId) => snapshot.apiCalls[apiCallId]?.provider)
          .filter((provider): provider is string => provider !== null)
      )
    ).sort();

    const actualProviders = [...file.providers].sort();
    if (expectedProviders.length !== actualProviders.length || expectedProviders.some((provider, index) => provider !== actualProviders[index])) {
      throw new Error(`Provider drift in file node: ${file.filePath}`);
    }
  }

  for (const provider of Object.values(snapshot.providers)) {
    for (const fileId of provider.fileIds) {
      if (!snapshot.files[fileId]) {
        throw new Error(`Invalid provider file reference: ${fileId}`);
      }
    }
    for (const apiCallId of provider.apiCallIds) {
      if (!snapshot.apiCalls[apiCallId]) {
        throw new Error(`Invalid provider apiCall reference: ${apiCallId}`);
      }
    }
    for (const findingId of provider.findingIds) {
      if (!snapshot.findings[findingId]) {
        throw new Error(`Invalid provider finding reference: ${findingId}`);
      }
    }
  }
}

export function buildRepoIntelligenceSnapshot(
  input: BuildRepoIntelligenceSnapshotInput
): RepoIntelligenceSnapshot {
  const files: Record<string, FileNode> = {};
  const apiCalls: Record<string, ApiCallNode> = {};
  const findings: Record<string, FindingNode> = {};
  const providers: Record<string, ProviderNode> = {};

  const apiCallsByFile = new Map<string, ApiCallInput[]>();
  const findingsByFile = new Map<string, LocalWasteFinding[]>();
  const allFilePaths = new Set<string>();

  for (const apiCall of input.apiCalls) {
    const filePath = normalizeRepoPath(apiCall.file);
    allFilePaths.add(filePath);
    const current = apiCallsByFile.get(filePath) ?? [];
    current.push({
      ...apiCall,
      file: filePath,
      provider: normalizeProvider(apiCall.provider) ?? undefined,
      crossFileOrigin: normalizeCrossFileOrigin(apiCall.crossFileOrigin),
    });
    apiCallsByFile.set(filePath, current);
  }

  for (const finding of input.findings) {
    const filePath = normalizeRepoPath(finding.affectedFile);
    allFilePaths.add(filePath);
    const current = findingsByFile.get(filePath) ?? [];
    current.push({
      ...finding,
      affectedFile: filePath,
    });
    findingsByFile.set(filePath, current);
  }

  for (const filePath of Array.from(allFilePaths).sort()) {
    ensureUniqueId(files, filePath, "file");
    files[filePath] = {
      id: filePath,
      filePath,
      apiCallIds: [],
      findingIds: [],
      providers: [],
    };
  }

  const apiCallNodesByFile = new Map<string, ApiCallNode[]>();

  for (const [filePath, calls] of apiCallsByFile.entries()) {
    const fileNode = files[filePath];
    const fileApiCallNodes: ApiCallNode[] = [];

    for (const call of calls) {
      const provider = normalizeProvider(call.provider);
      const apiCallId = makeApiCallId(filePath, call);
      ensureUniqueId(apiCalls, apiCallId, "apiCall");

      const apiCallNode: ApiCallNode = {
        id: apiCallId,
        fileId: filePath,
        filePath,
        line: call.line,
        span: call.span ?? null,
        provider,
        method: call.method,
        url: call.url,
        library: call.library ?? null,
        costModel: call.costModel ?? null,
        frequencyClass: call.frequencyClass ?? null,
        batchCapable: Boolean(call.batchCapable),
        cacheCapable: Boolean(call.cacheCapable),
        streaming: Boolean(call.streaming),
        isMiddleware: Boolean(call.isMiddleware),
        crossFileOrigin: normalizeCrossFileOrigin(call.crossFileOrigin),
      };

      apiCalls[apiCallId] = apiCallNode;
      fileApiCallNodes.push(apiCallNode);
      fileNode.apiCallIds.push(apiCallId);

      if (provider !== null) {
        const providerNode = providers[provider] ?? {
          name: provider,
          fileIds: [],
          apiCallIds: [],
          findingIds: [],
          urls: [],
          costModels: [],
        };
        if (!providerNode.fileIds.includes(filePath)) providerNode.fileIds.push(filePath);
        if (!providerNode.apiCallIds.includes(apiCallId)) providerNode.apiCallIds.push(apiCallId);
        if (!providerNode.urls.includes(call.url)) providerNode.urls.push(call.url);
        if (call.costModel && !providerNode.costModels.includes(call.costModel)) {
          providerNode.costModels.push(call.costModel);
        }
        providers[provider] = providerNode;
      }
    }

    fileApiCallNodes.sort((a, b) => a.line - b.line);
    apiCallNodesByFile.set(filePath, fileApiCallNodes);
    fileNode.providers = Array.from(
      new Set(fileApiCallNodes.map((apiCall) => apiCall.provider).filter((provider): provider is string => provider !== null))
    ).sort();
  }

  for (const [filePath, fileFindings] of findingsByFile.entries()) {
    const fileNode = files[filePath];
    const fileApiCallNodes = apiCallNodesByFile.get(filePath) ?? [];
    const providerFindingIds = new Map<string, string[]>();

    for (let index = 0; index < fileFindings.length; index += 1) {
      const finding = fileFindings[index];
      const findingId = makeFindingId(filePath, finding, index);
      ensureUniqueId(findings, findingId, "finding");

      const findingNode: FindingNode = {
        id: findingId,
        fileId: filePath,
        filePath,
        line: finding.line ?? null,
        type: finding.type,
        severity: finding.severity,
        confidence: finding.confidence,
        description: finding.description,
        evidence: [...finding.evidence],
      };

      findings[findingId] = findingNode;
      fileNode.findingIds.push(findingId);

      const nearestApiCall = linkFindingToNearestCall(fileApiCallNodes, findingNode.line);
      if (nearestApiCall?.provider) {
        const providerFindingList = providerFindingIds.get(nearestApiCall.provider) ?? [];
        providerFindingList.push(findingId);
        providerFindingIds.set(nearestApiCall.provider, providerFindingList);
      }
    }

    for (const [providerName, findingIdsForProvider] of providerFindingIds.entries()) {
      const providerNode = providers[providerName];
      if (!providerNode) continue;
      for (const findingId of findingIdsForProvider) {
        if (!providerNode.findingIds.includes(findingId)) {
          providerNode.findingIds.push(findingId);
        }
      }
    }
  }

  for (const providerNode of Object.values(providers)) {
    providerNode.fileIds.sort();
    providerNode.apiCallIds.sort();
    providerNode.findingIds.sort();
    providerNode.urls.sort();
    providerNode.costModels.sort();
  }

  const snapshot: RepoIntelligenceSnapshot = {
    createdAt: new Date().toISOString(),
    repoRoot: input.repoRoot,
    files,
    apiCalls,
    findings,
    providers,
    totalFilesScanned: input.totalFilesScanned ?? Object.keys(files).length,
  };

  validateSnapshot(snapshot);
  return snapshot;
}

export function buildSnapshot(input: BuildRepoIntelligenceSnapshotInput): RepoIntelligenceSnapshot {
  return buildRepoIntelligenceSnapshot(input);
}
