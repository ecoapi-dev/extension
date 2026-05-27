import * as path from "path";
import type { ApiCallInput } from "../analysis/types";
import type { SourceSpan } from "./source-span";
import { matchLine, matchRouteDefinitionLine, isInsideLoop, type HttpCallMatch } from "./patterns";
import { detectLocalWasteFindingsInText, type LocalWasteFinding } from "./local-waste-detector";
import { scanFileWithAst, type AstCallMatch } from "../ast/ast-scanner";
import { getLanguageForExtension } from "../ast/parser-loader";
import { runCrossFileResolution, type PerFileResult } from "../ast/cross-file-resolver";
import { detectCacheWaste } from "../ast/waste/cache-detector";
import { detectBatchWaste } from "../ast/waste/batch-detector";
import { detectConcurrencyWaste } from "../ast/waste/concurrency-detector";
import { lookupMethod, isRegisteredProvider, lookupHost } from "./fingerprints/registry";
import { STDLIB_DENYLIST } from "./fingerprints/index";
import { detectPythonWaste } from "./python-waste-detector";
import { foldStringConstants } from "./constant-fold";
import { parseHost } from "./patterns/utils";

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

/**
 * A2 (issue #74): when a regex match produces a dynamic URL (template literal
 * with same-file const interpolations, or a bare identifier wrapped in
 * `<dynamic:NAME>`), try to fold it to a concrete URL using same-file string
 * constants. If folding yields an http(s) URL whose host maps to a known
 * provider in the fingerprint registry, re-classify `library` from the
 * fallback "generic-http" to the resolved provider.
 *
 * Returns the original match if folding is not applicable or fails.
 */
function tryFoldRegexMatchUrl(match: HttpCallMatch, fileSource: string): HttpCallMatch {
  const url = match.url;
  if (!url) return match;
  // Only attempt folding for matches that the high-confidence filter would
  // otherwise drop. If the URL already starts with http(s)://, it has a
  // provider attribution already (or will not benefit from folding).
  if (/^https?:\/\//i.test(url)) return match;

  // Build the expression to fold. Cases:
  //  - "<dynamic:NAME>"  → fold NAME as a bare identifier
  //  - URL containing "${…}"  → re-wrap in backticks and fold as template
  //  - Otherwise no fold
  let expression: string | null = null;
  const dynamicMatch = url.match(/^<dynamic:([^>]+)>$/i);
  if (dynamicMatch) {
    expression = dynamicMatch[1].trim();
  } else if (url.includes("${")) {
    expression = "`" + url + "`";
  }
  if (!expression) return match;

  const folded = foldStringConstants(expression, fileSource);
  if (!folded) return match;

  // Re-classify library via host lookup only when the folded URL is a real
  // http URL with a known provider host. Path-only folds (e.g. "/users/123")
  // are accepted as URL updates but keep the original library.
  let library = match.library;
  if (/^https?:\/\//i.test(folded)) {
    const host = parseHost(folded);
    const provider = host ? lookupHost(host) : null;
    if (provider) library = provider;
  }
  return { ...match, url: folded, library };
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
    inlineParallelCapable: match.inlineParallelCapable,
    cacheCapable: match.cacheCapable,
    streaming: match.streaming,
    isMiddleware: match.isMiddleware,
    crossFileOrigin,
  };
}

// ── Internal result type for the shared AST gather helper ────────────────────

interface ResolvedFileResult {
  filePath: string;
  relativePath: string;
  source: string;
  matches: AstCallMatch[];
  astSucceeded: boolean;
}

/**
 * Scan all files in `access`, run cross-file resolution over the AST results,
 * and return augmented per-file data. Files without AST coverage (unsupported
 * extension) are still included with empty `matches` so the regex pass in
 * `scanFiles()` can still see their source.
 *
 * This is the single call-site for `runCrossFileResolution` — both `scanFiles`
 * and `detectLocalWastePatternsInFiles` delegate to it so resolution is applied
 * consistently across all consumers.
 */
async function gatherResolvedAstMatches(
  access: ScanFileAccess,
  onProgress?: (progress: ScanProgress) => void
): Promise<ResolvedFileResult[]> {
  const files = [...access.files].sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  const perFileResults: PerFileResult[] = [];
  // Track all files including non-AST ones so regex passes still see them.
  const allFiles: Array<{ filePath: string; relativePath: string; source: string; hasAst: boolean }> = [];

  for (let i = 0; i < files.length; i++) {
    const entry = files[i];
    try {
      const text = await access.readFile(entry.absolutePath);
      const ext = path.extname(entry.relativePath);
      if (getLanguageForExtension(ext)) {
        try {
          const result = await scanFileWithAst(entry.absolutePath, async (fp: string) => {
            try { return await access.readFile(fp); } catch { return null; }
          });
          perFileResults.push({
            filePath: entry.absolutePath,
            relativePath: entry.relativePath,
            source: text,
            result,
          });
          allFiles.push({ filePath: entry.absolutePath, relativePath: entry.relativePath, source: text, hasAst: true });
        } catch {
          // AST failed — include with empty matches so regex pass still runs
          allFiles.push({ filePath: entry.absolutePath, relativePath: entry.relativePath, source: text, hasAst: false });
        }
      } else {
        // Non-AST extension — include for regex-only processing
        allFiles.push({ filePath: entry.absolutePath, relativePath: entry.relativePath, source: text, hasAst: false });
      }
    } catch {
      // Skip unreadable files entirely
    }
    onProgress?.({ file: entry.relativePath, fileIndex: i + 1, fileTotal: files.length });
  }

  // Run cross-file resolution over all successfully parsed files.
  let augmented: Map<string, AstCallMatch[]>;
  try {
    augmented = runCrossFileResolution(perFileResults);
  } catch (err) {
    console.warn(`[recost] cross-file resolution failed; using per-file matches:`, err);
    augmented = new Map(perFileResults.map((pf) => [pf.relativePath, pf.result.matches]));
  }

  // Build the final per-file result, merging augmented AST matches back in.
  return allFiles.map((f) => ({
    filePath: f.filePath,
    relativePath: f.relativePath,
    source: f.source,
    matches: augmented.get(f.relativePath) ?? [],
    astSucceeded: f.hasAst,
  }));
}

export async function scanFiles(
  access: ScanFileAccess,
  onProgress?: (progress: ScanProgress) => void
): Promise<ApiCallInput[]> {
  const allCalls: ApiCallInput[] = [];
  const dedupe = new Set<string>();

  // Gather all files with cross-file-resolved AST matches in a single pass.
  const resolvedFiles = await gatherResolvedAstMatches(access, onProgress);

  for (const rf of resolvedFiles) {
    const { relativePath: relPath, source: text, matches: astMatches } = rf;
    const lines = text.split("\n");

    const astCoveredLines = new Set<number>();

    // Process AST matches (already cross-file-resolved).
    for (const match of astMatches) {
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

      const apiCall = astMatchToApiCallInput(match, relPath);
      const key = `${relPath}:${match.line}:${apiCall.method}:${apiCall.url}`;
      if (dedupe.has(key)) continue;
      dedupe.add(key);
      astCoveredLines.add(match.line);
      allCalls.push(apiCall);
    }

    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
        const lineNum = lineIndex + 1;
        if (astCoveredLines.has(lineNum)) continue;

        const line = lines[lineIndex];
        const routeMatches = matchRouteDefinitionLine(line);
        for (const route of routeMatches) {
          if (!isHighConfidenceUrl(route.url)) continue;
          const key = `${relPath}:${lineNum}:${route.method}:${route.url}:${route.library}`;
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
            file: relPath,
            line: lineNum,
            span,
            method: route.method,
            url: route.url,
            library: route.library,
            frequency: "daily",
          });
        }

        let matches = matchLine(line);
        let multiLineExpansion = false;
        if (matches.length === 0 && HTTP_CALL_HINT.test(line)) {
          // Multi-line regex expansion: catches SDK call patterns whose
          // argument object spans several lines. To avoid phantom matches
          // (e.g. `import OpenAI from "openai"` on line 1 absorbing a real
          // `client.chat.completions.create(...)` from line 5 and re-emitting
          // it as a call at line 1), we bound the expansion at the first
          // AST-covered line in the look-ahead window. Lines strictly before
          // that boundary may still legitimately participate in a multi-line
          // regex match. Fixes A6 / issue #78.
          const windowEnd = Math.min(lines.length, lineIndex + 6);
          let firstAstCovered = -1;
          for (let k = lineIndex; k < windowEnd; k++) {
            if (astCoveredLines.has(k + 1)) { firstAstCovered = k; break; }
          }
          const expansionEnd = firstAstCovered === -1 ? windowEnd : firstAstCovered;
          if (expansionEnd > lineIndex) {
            const multiLine = lines.slice(lineIndex, expansionEnd).join("\n");
            matches = matchLine(multiLine);
            if (matches.length > 0) {
              multiLineExpansion = true;
            }
          }
        }

        for (const rawMatch of matches) {
          // A2 (issue #74): try to fold same-file string constants in the URL
          // before the high-confidence filter, so e.g. `fetch(\`${BASE}/path\`)`
          // with `const BASE = "https://api.openai.com"` becomes a concrete
          // provider-attributed call.
          const folded = tryFoldRegexMatchUrl(rawMatch, text);
          const didFold = folded.url !== rawMatch.url;
          const match = folded;
          if (!isHighConfidenceUrl(match.url)) continue;

          // When folding fires inside a multi-line expansion, the expansion's
          // starting line may be several lines above the actual call site
          // (e.g. line 1 is `const OPENAI_BASE = "https://api.openai.com"`,
          // line 5 is the real fetch — line 1's mention of "openai" triggered
          // HTTP_CALL_HINT and the multi-line scan absorbed the line-5 fetch).
          // Re-anchor to the line within the expansion containing the HTTP
          // call kind so dedupe collapses redundant expansion starts onto the
          // real call line. We scope this strictly to folded matches so that
          // pre-A2 behaviour for non-folded multi-line matches is preserved.
          let reportedLineIndex = lineIndex;
          if (multiLineExpansion && didFold) {
            const expansionEnd = Math.min(lines.length, lineIndex + 6);
            for (let k = lineIndex; k < expansionEnd; k++) {
              if (/\b(fetch|axios|got|ky|superagent|requests|httpx)\s*[.(]|http\.\w+\s*\(|\$http\.\w+\s*\(/.test(lines[k])) {
                reportedLineIndex = k;
                break;
              }
            }
          }
          const reportedLineNum = reportedLineIndex + 1;
          const reportedLine = lines[reportedLineIndex] ?? line;

          const key = `${relPath}:${reportedLineNum}:${match.method}:${match.url}:${match.library}`;
          if (dedupe.has(key)) continue;
          dedupe.add(key);
          // span: regex matched a substring on this line; we can't recover the
          // exact match offset here without a richer matchLine API, so report a
          // line-wide span: column 0 → end of line.
          const span: SourceSpan = {
            startLine: reportedLineNum,
            startColumn: 0,
            endLine: reportedLineNum,
            endColumn: reportedLine.length,
          };
          allCalls.push({
            file: relPath,
            line: reportedLineNum,
            span,
            method: match.method,
            url: match.url,
            library: match.library,
            frequency: isInsideLoop(lines, reportedLineIndex) ? "per-request" : "daily",
          });
        }
    }
  }

  return allCalls;
}

export async function detectLocalWastePatternsInFiles(access: ScanFileAccess): Promise<LocalWasteFinding[]> {
  // Use the shared helper so cross-file resolution is applied in one place.
  const resolvedFiles = await gatherResolvedAstMatches(access);

  const astFindings: LocalWasteFinding[] = [];
  const nonAstFindings: LocalWasteFinding[] = [];

  for (const rf of resolvedFiles) {
    const ext = path.extname(rf.relativePath).toLowerCase();

    if (rf.astSucceeded && JS_TS_EXTENSIONS.has(ext)) {
      // Phase 1 gate only: remove stdlib, framework, and build-tool calls.
      // Phase 2 (registry match) is intentionally NOT applied here — the waste
      // detectors do code pattern analysis and do not require a known provider match.
      const matches = rf.matches.filter((match) => {
        if (match.packageName && STDLIB_DENYLIST.has(match.packageName)) return false;
        return true;
      });

      astFindings.push(...detectCacheWaste(matches, rf.source, rf.relativePath));
      astFindings.push(...detectBatchWaste(matches, rf.source, rf.relativePath));
      astFindings.push(...detectConcurrencyWaste(matches, rf.source, rf.relativePath));
    } else if (rf.astSucceeded && PYTHON_EXTENSIONS.has(ext)) {
      astFindings.push(...detectPythonWaste(rf.matches, rf.source, rf.relativePath));
    } else {
      // AST failed (or non-AST extension) → regex text fallback
      nonAstFindings.push(...detectLocalWasteFindingsInText(rf.relativePath, rf.source));
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
