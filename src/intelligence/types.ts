import type { ApiCallInput, Severity, SuggestionType } from "../analysis/types";
import type { SourceSpan } from "../scanner/source-span";

export interface FileNode {
  id: string;
  filePath: string;
  apiCallIds: string[];
  findingIds: string[];
  providers: string[];
}

export interface ApiCallNode {
  id: string;
  fileId: string;
  filePath: string;
  line: number;
  span: SourceSpan | null;
  provider: string | null;
  method: string;
  url: string;
  library: string | null;
  costModel: ApiCallInput["costModel"] | null;
  frequencyClass: ApiCallInput["frequencyClass"] | null;
  batchCapable: boolean;
  inlineParallelCapable: boolean;
  cacheCapable: boolean;
  streaming: boolean;
  isMiddleware: boolean;
  crossFileOrigin: { file: string; functionName: string } | null;
  callTrace?: import("../scanner/call-trace").CallTrace;
}

export interface FindingNode {
  id: string;
  fileId: string;
  filePath: string;
  line: number | null;
  type: SuggestionType;
  severity: Severity;
  confidence: number;
  description: string;
  evidence: string[];
  sources: string[];
  costImpactUsd: number | null;
}

export interface ProviderNode {
  name: string;
  fileIds: string[];
  apiCallIds: string[];
  findingIds: string[];
  urls: string[];
  costModels: Array<NonNullable<ApiCallInput["costModel"]>>;
}

export interface RepoIntelligenceSnapshot {
  createdAt: string;
  repoRoot?: string;
  files: Record<string, FileNode>;
  apiCalls: Record<string, ApiCallNode>;
  findings: Record<string, FindingNode>;
  providers: Record<string, ProviderNode>;
  totalFilesScanned: number;
}

export interface FileScores {
  importance: number;
  costLeak: number;
  reliabilityRisk: number;
  aiReviewPriority: number;
}

export interface ScoredFile {
  filePath: string;
  fileId: string;
  scores: FileScores;
  reasons: string[];
}

export interface ScoredSnapshot {
  snapshot: RepoIntelligenceSnapshot;
  scoredFiles: ScoredFile[];
  rankedProviders: ProviderNode[];
  rankedFindings: FindingNode[];
}

export interface RelatedFile {
  filePath: string;
  relationship: string;
}

export interface ReviewCluster {
  id: string;
  primaryFile: ScoredFile;
  relatedFiles: RelatedFile[];
  topFindings: FindingNode[];
  providers: string[];
  estimatedMonthlyCost: number | null;
  reviewQuestion: string;
}

export interface FileSummary {
  filePath: string;
  description: string;
  providers: string[];
  topRisks: string[];
  estimatedMonthlyCost: number | null;
  whyItMatters: string;
}

export interface CompressedSnippet {
  filePath: string;
  startLine: number;
  endLine: number;
  code: string;
  label: string;
}

export interface CompressedCluster {
  id: string;
  primarySummary: FileSummary;
  relatedSummaries: FileSummary[];
  findings: Array<{
    title: string;
    severity: string;
    description: string;
    estimatedMonthlyCost: number | null;
  }>;
  snippets: CompressedSnippet[];
  providers: string[];
  estimatedMonthlyCost: number | null;
  reviewQuestion: string;
}

export interface ExportedContext {
  meta: {
    projectName: string;
    generatedAt: string;
    generatorVersion?: string;
    totalFiles: number;
    totalClusters: number;
    providers: string[];
    contextProviders?: string[];
  };
  summary: {
    topFiles: Array<{
      filePath: string;
      whyItMatters: string;
    }>;
    keyRisks: string[];
    costLeaks: Array<{
      filePath: string;
      costLeakScore: number;
      reasons: string[];
    }>;
  };
  providerSummary: Array<{
    provider: string;
    fileCount: number;
    callCount: number;
    findingCount: number;
    estimatedMonthlyCost: number | null;
  }>;
  clusters: CompressedCluster[];
}
