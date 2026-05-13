import * as path from "path";
import type { ApiCallInput } from "../analysis/types";
import type { SourceSpan } from "./source-span";
import { matchLine, matchRouteDefinitionLine, isInsideLoop } from "./patterns";
import { detectLocalWasteFindingsInText, type LocalWasteFinding } from "./local-waste-detector";
import { scanFileWithAst, type AstCallMatch } from "../ast/ast-scanner";
import { getLanguageForExtension } from "../ast/parser-loader";
import { runCrossFileResolution, type PerFileResult } from "../ast/cross-file-resolver";
import { detectCacheWaste } from "../ast/waste/cache-detector";
import { detectBatchWaste } from "../ast/waste/batch-detector";
import { detectConcurrencyWaste } from "../ast/waste/concurrency-detector";
import { lookupMethod, isRegisteredProvider } from "./fingerprints/registry";
import { STDLIB_DENYLIST } from "./fingerprints/index";
import { detectPythonWaste } from "./python-waste-detector";

const HTTP_CALL_HINT =
  /\b(fetch|axios|got|superagent|ky|requests|http\.|\$http|openai|responses|completions|embeddings|moderations|vector_stores|vectorStores|assistants|threads|realtime|uploads|batches|containers|skills|videos|evals|images|audio|files|models|anthropic|claude|gemini|genai|bedrock|vertex|cohere|mistral|stripe|graphql|apollo|urql|relay|supabase|firebase|trpc|grpc)\b/i;
const GENERIC_TEMPLATE_SEGMENT = /\$\{\s*(endpoint|url|path|uri|route)\s*\}/i;
const JS_TS_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const PYTHON_EXTENSIONS = new Set([".py", ".pyw"]);

export interface ScanProgress {
  file: string;
  fileIndex: number;
  fileTotal: number;
}

export interface ScanInputFile {
  absolutePath: string;
  relativePath: string;
}

export interface ScanFileAccess {
  files: ScanInputFile[];
  readFile: (absolutePath: string) => Promise<string>;
}

function isGenericDynamicUrl(url: string): boolean {
  const dynamic = url.match(/^<dynamic:([^>]+)>$/i);
  if (dynamic) {
    const token = dynamic[1].trim().toLowerCase();
    return ["endpoint", "url", "path", "uri", "route"].includes(token);
  }
  return false;
}

function isHighConfidenceUrl(url: string): boolean {
  if (!url) return false;
  if (/^https?:\/\//i.test(url)) return true;
  if (url.startsWith("/")) return true;
  if (GENERIC_TEMPLATE_SEGMENT.test(url)) return false;
  if (/^<dynamic:/i.test(url)) {
    if (isGenericDynamicUrl(url)) return false;
    const token = (url.match(/^<dynamic:([^>]+)>$/i)?.[1] ?? "").toLowerCase();
    if (/base[_-]?url/.test(token)) return false;
    return true;
  }
  return false;
}

function astMatchToApiCallInput(match: AstCallMatch, file: string): ApiCallInput {
  const method = match.method ?? "CALL";
  const url =
    match.endpoint ??
    (match.provider
      ? `sdk://${match.provider}/${match.methodChain}`
      : `ast:${match.methodChain}`);
  const library =
    match.packageName ?? match.provider ?? match.methodChain.split(".")[0];
  const isHighFreq =
    match.isMiddleware ||
    match.frequency === "unbounded-loop" ||
    match.frequency === "polling" ||
    match.frequency === "parallel" ||
    match.frequency === "bounded-loop";
  const frequency = isHighFreq ? "per-request" : "daily";

  let costModel: ApiCallInput["costModel"];
  if (match.provider && match.methodChain) {
    const fingerprint = lookupMethod(match.provider, match.methodChain);
    if (fingerprint) {
      costModel = fingerprint.costModel;
    }
  }

  const crossFileOrigin =
    match.crossFile && match.sourceFile
      ? { file: match.sourceFile, functionName: match.methodChain }
      : null;

  return {
    file,
    line: match.line,
    span: match.span,
    method,
    url,
    library,
    frequency,
    frequencyClass: match.frequency,
    provider: match.provider,
    methodSignature: match.methodChain,
    enclosingFunction: match.enclosingFunction,
    costModel,
    batchCapable: match.batchCapable,
    cacheCapable: match.cacheCapable,
    streaming: match.streaming,
    isMiddleware: match.isMiddleware,
    crossFileOrigin,
  };
}

export async function scanFiles(
  access: ScanFileAccess,
  onProgress?: (progress: ScanProgress) => void
): Promise<ApiCallInput[]> {
  const files = [...access.files].sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  const allCalls: ApiCallInput[] = [];
  const dedupe = new Set<string>();

  for (let i = 0; i < files.length; i++) {
    const entry = files[i];

    try {
      const text = await access.readFile(entry.absolutePath);
      const lines = text.split("\n");

      const astCoveredLines = new Set<number>();
      const ext = path.extname(entry.relativePath);
      if (getLanguageForExtension(ext)) {
        try {
          const astResult = await scanFileWithAst(entry.absolutePath, async (fp: string) => {
            try {
              return await access.readFile(fp);
            } catch {
              return null;
            }
          });
          for (const match of astResult.matches) {
            // Phase 1: skip stdlib, framework, and build-tool imports
            if (match.packageName && STDLIB_DENYLIST.has(match.packageName)) continue;

            // Phase 2: require a registry match — drop silently if nothing is registered
            const fp = (match.provider && match.methodChain)
              ? lookupMethod(match.provider, match.methodChain)
              : null;
            const knownSdkProvider = match.provider ? isRegisteredProvider(match.provider) : false;
            // http-kind: match.provider is set iff lookupHost() already resolved the host in ast-scanner
            const knownHttpHost = match.kind === "http" && !!match.provider;
            if (!fp && !knownSdkProvider && !knownHttpHost) continue;

            const apiCall = astMatchToApiCallInput(match, entry.relativePath);
            const key = `${entry.relativePath}:${match.line}:${apiCall.method}:${apiCall.url}`;
            if (dedupe.has(key)) continue;
            dedupe.add(key);
            astCoveredLines.add(match.line);
            allCalls.push(apiCall);
          }
        } catch {
          // AST failed — fall through to regex-only for this file
        }
      }

      for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
        const lineNum = lineIndex + 1;
        if (astCoveredLines.has(lineNum)) continue;

        const line = lines[lineIndex];
        const routeMatches = matchRouteDefinitionLine(line);
        for (const route of routeMatches) {
          if (!isHighConfidenceUrl(route.url)) continue;
          const key = `${entry.relativePath}:${lineNum}:${route.method}:${route.url}:${route.library}`;
          if (dedupe.has(key)) continue;
          dedupe.add(key);
          // span: regex matched a substring on this line; we can't recover the
          // exact match offset here without a richer matchLine API, so report a
          // line-wide span: column 0 → end of line.
          const span: SourceSpan = {
            startLine: lineNum,
            startColumn: 0,
            endLine: lineNum,
            endColumn: line.length,
          };
          allCalls.push({
            file: entry.relativePath,
            line: lineNum,
            span,
            method: route.method,
            url: route.url,
            library: route.library,
            frequency: "daily",
          });
        }

        let matches = matchLine(line);
        if (matches.length === 0 && HTTP_CALL_HINT.test(line)) {
          const multiLine = lines.slice(lineIndex, Math.min(lines.length, lineIndex + 6)).join("\n");
          matches = matchLine(multiLine);
        }

        for (const match of matches) {
          if (!isHighConfidenceUrl(match.url)) continue;
          const key = `${entry.relativePath}:${lineNum}:${match.method}:${match.url}:${match.library}`;
          if (dedupe.has(key)) continue;
          dedupe.add(key);
          // span: regex matched a substring on this line; we can't recover the
          // exact match offset here without a richer matchLine API, so report a
          // line-wide span: column 0 → end of line.
          const span: SourceSpan = {
            startLine: lineNum,
            startColumn: 0,
            endLine: lineNum,
            endColumn: line.length,
          };
          allCalls.push({
            file: entry.relativePath,
            line: lineNum,
            span,
            method: match.method,
            url: match.url,
            library: match.library,
            frequency: isInsideLoop(lines, lineIndex) ? "per-request" : "daily",
          });
        }
      }
    } catch {
      // Skip files that can't be read
    }

    onProgress?.({
      file: entry.relativePath,
      fileIndex: i + 1,
      fileTotal: files.length,
    });
  }

  return allCalls;
}

export async function detectLocalWastePatternsInFiles(access: ScanFileAccess): Promise<LocalWasteFinding[]> {
  const files = [...access.files].sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  const perFileResults: PerFileResult[] = [];
  const nonAstFindings: LocalWasteFinding[] = [];

  for (const entry of files) {
    try {
      const text = await access.readFile(entry.absolutePath);
      const ext = path.extname(entry.relativePath);

      if (getLanguageForExtension(ext)) {
        try {
          const result = await scanFileWithAst(entry.absolutePath, async (fp: string) => {
            try {
              return await access.readFile(fp);
            } catch {
              return null;
            }
          });
          perFileResults.push({
            filePath: entry.absolutePath,
            relativePath: entry.relativePath,
            source: text,
            result,
          });
        } catch {
          nonAstFindings.push(...detectLocalWasteFindingsInText(entry.relativePath, text));
        }
      } else {
        nonAstFindings.push(...detectLocalWasteFindingsInText(entry.relativePath, text));
      }
    } catch {
      // Skip files that can't be read
    }
  }

  let augmented: Map<string, AstCallMatch[]>;
  try {
    augmented = runCrossFileResolution(perFileResults);
  } catch {
    augmented = new Map(perFileResults.map((pf) => [pf.relativePath, pf.result.matches]));
  }

  const astFindings: LocalWasteFinding[] = [];
  for (const pf of perFileResults) {
    const ext = path.extname(pf.relativePath).toLowerCase();
    const rawMatches = augmented.get(pf.relativePath) ?? pf.result.matches;

    if (JS_TS_EXTENSIONS.has(ext)) {
      // Phase 1 gate only: remove stdlib, framework, and build-tool calls.
      // Phase 2 (registry match) is intentionally NOT applied here — the waste
      // detectors do code pattern analysis and do not require a known provider match.
      const matches = rawMatches.filter((match) => {
        if (match.packageName && STDLIB_DENYLIST.has(match.packageName)) return false;
        return true;
      });

      astFindings.push(...detectCacheWaste(matches, pf.source, pf.relativePath));
      astFindings.push(...detectBatchWaste(matches, pf.source, pf.relativePath));
      astFindings.push(...detectConcurrencyWaste(matches, pf.source, pf.relativePath));
    } else if (PYTHON_EXTENSIONS.has(ext)) {
      astFindings.push(...detectPythonWaste(rawMatches, pf.source, pf.relativePath));
    }
  }

  const seen = new Map<string, LocalWasteFinding>();
  for (const finding of [...astFindings, ...nonAstFindings]) {
    const key = `${finding.type}:${finding.affectedFile}:${finding.line ?? 0}`;
    const existing = seen.get(key);
    if (!existing || finding.confidence > existing.confidence) {
      seen.set(key, finding);
    }
  }

  return [...seen.values()];
}
