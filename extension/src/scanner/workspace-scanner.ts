import * as vscode from "vscode";
import { ApiCallInput } from "../analysis/types";
import { matchLine, matchRouteDefinitionLine, isInsideLoop } from "./patterns";

const MAX_FILES = 5000;
const HTTP_CALL_HINT =
  /\b(fetch|axios|got|superagent|ky|requests|http\.|\$http|openai|responses|completions|embeddings|moderations|vector_stores|vectorStores|assistants|threads|realtime|uploads|batches|containers|skills|videos|evals|images|audio|files|models)\b/i;
const GENERIC_TEMPLATE_SEGMENT = /\$\{\s*(endpoint|url|path|uri|route)\s*\}/i;
const HARD_EXCLUDED_SEGMENTS = new Set([
  "node_modules",
  "docs",
  "examples",
  "dist",
  "build",
  "coverage",
  ".git",
  ".next",
  "vendor",
  "venv",
  ".venv",
  "__pycache__",
]);

export interface LocalWasteFinding {
  id: string;
  type: "cache" | "batch" | "redundancy" | "n_plus_one" | "rate_limit";
  severity: "high" | "medium" | "low";
  description: string;
  affectedFile: string;
  line?: number;
}

export interface ScanProgress {
  file: string;
  index: number;
  total: number;
  endpointsSoFar: number;
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
    // A lone base URL variable is not an endpoint route.
    if (/base[_-]?url/.test(token)) return false;
    return true;
  }
  return false;
}

async function readUriText(uri: vscode.Uri): Promise<string> {
  const openDoc = vscode.workspace.textDocuments.find((doc) => doc.uri.toString() === uri.toString());
  if (openDoc) {
    return openDoc.getText();
  }

  const content = await vscode.workspace.fs.readFile(uri);
  return Buffer.from(content).toString("utf-8");
}

function parseCsvGlobs(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function isHardExcludedPath(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, "/");
  const segments = normalized.split("/");
  return segments.some((segment) => HARD_EXCLUDED_SEGMENTS.has(segment));
}

async function findScopedUris(config: vscode.WorkspaceConfiguration): Promise<vscode.Uri[]> {
  const includeGlob = config.get<string>("scanGlob", "**/*.{ts,tsx,js,jsx,py,go,java,rb}");
  const scopedInclude = parseCsvGlobs(config.get<string>("scanIncludeGlobs", ""));
  const configuredExclude = config.get<string>(
    "excludeGlob",
    "**/node_modules/**,**/dist/**,**/build/**,**/.git/**,**/.next/**,**/vendor/**"
  );
  const hardExcludeGlob =
    "**/node_modules/**,**/docs/**,**/examples/**,**/dist/**,**/build/**,**/coverage/**,**/.git/**,**/.next/**,**/vendor/**,**/venv/**,**/.venv/**,**/__pycache__/**";
  const mergedExclude = configuredExclude ? `${configuredExclude},${hardExcludeGlob}` : hardExcludeGlob;

  const includePatterns = scopedInclude.length > 0 ? scopedInclude : [includeGlob];
  const uriByPath = new Map<string, vscode.Uri>();

  for (const pattern of includePatterns) {
    const uris = await vscode.workspace.findFiles(pattern, mergedExclude, MAX_FILES);
    for (const uri of uris) {
      const relativePath = vscode.workspace.asRelativePath(uri, false);
      if (isHardExcludedPath(relativePath)) continue;
      uriByPath.set(uri.toString(), uri);
    }
  }

  return Array.from(uriByPath.values());
}

export async function readWorkspaceFileExcerpt(
  relativePath: string,
  options?: { centerLine?: number; contextLines?: number; maxChars?: number }
): Promise<{ content: string; startLine: number; endLine: number } | null> {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) return null;

  try {
    const fileUri = vscode.Uri.joinPath(workspaceFolder.uri, relativePath);
    const text = await readUriText(fileUri);
    const lines = text.split("\n");
    const context = Math.max(options?.contextLines ?? 30, 5);
    const center = options?.centerLine ? Math.max(1, options.centerLine) : 1;
    const startLine = Math.max(1, center - context);
    const endLine = Math.min(lines.length, center + context);
    const selected = lines.slice(startLine - 1, endLine);
    let content = selected.join("\n");
    const maxChars = Math.max(options?.maxChars ?? 6000, 500);

    if (content.length > maxChars) {
      content = `${content.slice(0, maxChars)}\n/* ...truncated... */`;
    }

    return { content, startLine, endLine };
  } catch {
    return null;
  }
}

export async function scanWorkspace(
  onProgress?: (progress: ScanProgress) => void
): Promise<ApiCallInput[]> {
  const config = vscode.workspace.getConfiguration("eco");
  const uris = await findScopedUris(config);
  const allCalls: ApiCallInput[] = [];
  const dedupe = new Set<string>();
  const uniqueEndpointKeys = new Set<string>();

  for (let i = 0; i < uris.length; i++) {
    const uri = uris[i];
    const relativePath = vscode.workspace.asRelativePath(uri, false);

    try {
      const text = await readUriText(uri);
      const lines = text.split("\n");

      for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
        const line = lines[lineIndex];
        const routeMatches = matchRouteDefinitionLine(line);
        for (const route of routeMatches) {
          if (!isHighConfidenceUrl(route.url)) continue;
          const key = `${relativePath}:${lineIndex + 1}:${route.method}:${route.url}:${route.library}`;
          if (dedupe.has(key)) continue;
          dedupe.add(key);
          uniqueEndpointKeys.add(`${route.method} ${route.url}`);
          allCalls.push({
            file: relativePath,
            line: lineIndex + 1,
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
          const key = `${relativePath}:${lineIndex + 1}:${match.method}:${match.url}:${match.library}`;
          if (dedupe.has(key)) continue;
          dedupe.add(key);
          uniqueEndpointKeys.add(`${match.method} ${match.url}`);
          const inLoop = isInsideLoop(lines, lineIndex);
          allCalls.push({
            file: relativePath,
            line: lineIndex + 1,
            method: match.method,
            url: match.url,
            library: match.library,
            frequency: inLoop ? "per-request" : "daily",
          });
        }
      }
    } catch {
      // Skip files that can't be read
    }

    onProgress?.({
      file: relativePath,
      index: i,
      total: uris.length,
      endpointsSoFar: uniqueEndpointKeys.size,
    });
  }

  return allCalls;
}

interface FileContext {
  path: string;
  text: string;
  lines: string[];
}

function findLine(lines: string[], pattern: RegExp): number | undefined {
  for (let i = 0; i < lines.length; i += 1) {
    if (pattern.test(lines[i])) return i + 1;
  }
  return undefined;
}

function has(pattern: RegExp, text: string): boolean {
  return pattern.test(text);
}

function makeFinding(
  file: FileContext,
  id: string,
  type: LocalWasteFinding["type"],
  severity: LocalWasteFinding["severity"],
  description: string,
  linePattern: RegExp
): LocalWasteFinding {
  return {
    id: `${id}:${file.path}`,
    type,
    severity,
    description,
    affectedFile: file.path,
    line: findLine(file.lines, linePattern),
  };
}

function detectInFile(file: FileContext): LocalWasteFinding[] {
  const findings: LocalWasteFinding[] = [];
  const { text } = file;
  const fetchCallCount = (text.match(/\bfetch\(/g) ?? []).length;
  const axiosCallCount = (text.match(/\baxios(?:\.\w+)?\s*\(/g) ?? []).length;
  const requestsCallCount = (text.match(/\brequests\.(get|post|put|patch|delete)\(/g) ?? []).length;
  const openAiCallCount = (
    text.match(
      /\b[A-Za-z_$][\w$]*\.(?:beta\.)?(?:completions|chat|embeddings|files|images|audio|moderations|models|fine_tuning|fineTuning|vector_stores|vectorStores|batches|uploads|responses|realtime|conversations|evals|containers|skills|videos|assistants|threads)(?:\.[A-Za-z_][\w$]*){0,12}\.(?:create_and_run_stream|create_and_run_poll|create_and_run|create_and_stream|create_and_poll|upload_and_poll|submit_tool_outputs_and_poll|submit_tool_outputs_stream|submit_tool_outputs|wait_for_processing|download_content|retrieve_content|create_variation|list_events|list_files|generate|retrieve|update|delete|cancel|search|validate|stream|upload|content|complete|create|list|poll|edit|run|remix|pause|resume)\s*\(/gi
    ) ?? []
  ).length;
  const totalHttpCallCount = fetchCallCount + axiosCallCount + requestsCallCount + openAiCallCount;

  if (has(/Promise\.all\([\s\S]{0,300}length:\s*streamCount/gi, text) && has(/streamCount\s*=\s*200/g, text)) {
    findings.push(
      makeFinding(
        file,
        "local-concurrent-stream-fanout",
        "n_plus_one",
        "high",
        "High fan-out detected: 200 concurrent streams are launched per user action with Promise.all, which can trigger severe request storms.",
        /streamCount\s*=\s*200/
      )
    );
  }

  if (has(/randomInt\(\s*10\s*,\s*30\s*\)/g, text) && has(/jitterThatIncreasesCalls|baseCalls\s*\+\s*jitter/gi, text)) {
    findings.push(
      makeFinding(
        file,
        "local-random-call-amplification",
        "n_plus_one",
        "high",
        "Call amplification detected: per-stream call volume is randomized and explicitly increased with additional jitter.",
        /randomInt\(\s*10\s*,\s*30\s*\)/
      )
    );
  }

  if (has(/for\s*\(\s*let\s+attempt\s*=\s*0;\s*attempt\s*<\s*20/gi, text)) {
    findings.push(
      makeFinding(
        file,
        "local-excessive-retry-loop",
        "rate_limit",
        "high",
        "Excessive retry loop detected: up to 20 attempts per call can drastically increase request volume and cost.",
        /attempt\s*<\s*20/
      )
    );
  }

  if (has(/duplicateFanout\s*=|Array\.from\(\{\s*length:\s*duplicateFanout/gi, text)) {
    findings.push(
      makeFinding(
        file,
        "local-broken-backoff-fanout",
        "rate_limit",
        "high",
        "Broken backoff pattern detected: failures increase parallel duplicate requests, amplifying load instead of reducing it.",
        /duplicateFanout/
      )
    );
  }

  if (has(/AbortSignal\.timeout\(\s*1\s*\)/g, text) && has(/attempt\s*<\s*20/gi, text)) {
    findings.push(
      makeFinding(
        file,
        "local-timeout-retry-storm",
        "rate_limit",
        "high",
        "Retry storm risk detected: 1ms timeout combined with aggressive retries/fan-out is likely to create cascading failures.",
        /AbortSignal\.timeout\(\s*1\s*\)/
      )
    );
  }

  if (totalHttpCallCount > 0 && !has(/cache|memo|dedupe|circuit breaker|breaker/gi, text)) {
    findings.push(
      makeFinding(
        file,
        "local-missing-cache-dedupe-breaker",
        "cache",
        "medium",
        "Resilience/cost controls appear missing: no clear caching, deduplication, or circuit breaker behavior was detected near frequent API calls.",
        /\b(fetch|axios|requests)\b/
      )
    );
  }

  if (has(/Promise\.all\([\s\S]{0,500}\.map\(/gi, text) && has(/\b(fetch|axios|got|superagent|ky|openai|responses|completions|embeddings|moderations)\b/gi, text)) {
    findings.push(
      makeFinding(
        file,
        "local-bulk-parallel-call-map",
        "n_plus_one",
        "medium",
        "Potential request burst detected: Promise.all with map over API calls can create fan-out under load without throttling.",
        /Promise\.all\([\s\S]{0,500}\.map\(/
      )
    );
  }

  if (has(/new\s+Agent\(/g, text) && has(/function\s+noisyApiCall/gi, text)) {
    findings.push(
      makeFinding(
        file,
        "local-client-reinit-per-call",
        "redundancy",
        "medium",
        "HTTP client re-initialization detected inside a hot call path; reuse a shared client/dispatcher to avoid connection churn.",
        /new\s+Agent\(/
      )
    );
  }

  if (has(/loadConfigEveryCall\(\)/g, text) && has(/function\s+noisyApiCall/gi, text)) {
    findings.push(
      makeFinding(
        file,
        "local-config-reload-per-call",
        "redundancy",
        "medium",
        "Configuration is reloaded on every API call, adding avoidable per-request overhead.",
        /loadConfigEveryCall\(\)/
      )
    );
  }

  if (has(/\[FULL_PROMPT_LOG\]|\[FULL_RESPONSE_LOG\]/g, text)) {
    findings.push(
      makeFinding(
        file,
        "local-full-payload-logging",
        "rate_limit",
        "medium",
        "Verbose full prompt/response logging detected on hot paths; this increases IO cost and can leak sensitive data.",
        /\[FULL_PROMPT_LOG\]|\[FULL_RESPONSE_LOG\]/
      )
    );
  }

  const stringifyParseCount = (text.match(/JSON\.parse\(JSON\.stringify\(/g) ?? []).length;
  if (stringifyParseCount >= 3) {
    findings.push(
      makeFinding(
        file,
        "local-redundant-json-transform",
        "redundancy",
        "medium",
        "Repeated JSON stringify/parse chains detected without clear need, creating unnecessary CPU overhead.",
        /JSON\.parse\(JSON\.stringify\(/
      )
    );
  }

  if (has(/DISABLE_CALLS/g, text) && has(/still calling anyway/gi, text)) {
    findings.push(
      makeFinding(
        file,
        "local-inverted-disable-flag",
        "rate_limit",
        "high",
        "Feature-flag inversion detected: DISABLE_CALLS appears set but calls still proceed.",
        /DISABLE_CALLS/
      )
    );
  }

  if (has(/sharedMutableResponses/g, text) && has(/sharedMutableResponses\.push/g, text) && !has(/shift\(|splice\(|slice\(\s*-?\d+\s*\)/g, text)) {
    findings.push(
      makeFinding(
        file,
        "local-unbounded-global-growth",
        "redundancy",
        "high",
        "Unbounded shared mutable global array growth detected; memory pressure can accumulate indefinitely under load.",
        /sharedMutableResponses/
      )
    );
  }

  if (has(/setInterval\(/g, text) && has(/startRunawayLeakLoop|leakLoopStarted|LEAK_LOOP/gi, text)) {
    findings.push(
      makeFinding(
        file,
        "local-runaway-background-loop",
        "n_plus_one",
        "high",
        "Runaway background loop detected: recurring leaked calls continue indefinitely after first trigger.",
        /setInterval\(/
      )
    );
  }

  if (has(/calls_per_user_action|calls_per_minute_at_concurrency|projected_monthly_calls|projected_monthly_cost/gi, text)) {
    findings.push(
      makeFinding(
        file,
        "local-waste-metrics-present",
        "rate_limit",
        "low",
        "Waste metrics are emitted (calls per action/minute and projected monthly cost), indicating code paths with explicit high-volume behavior modeling.",
        /calls_per_user_action|projected_monthly_cost/
      )
    );
  }

  return findings;
}

export async function detectLocalWastePatterns(): Promise<LocalWasteFinding[]> {
  const config = vscode.workspace.getConfiguration("eco");
  const uris = await findScopedUris(config);
  const findings: LocalWasteFinding[] = [];

  for (const uri of uris) {
    try {
      const relativePath = vscode.workspace.asRelativePath(uri, false);
      const text = await readUriText(uri);
      const lines = text.split("\n");
      const file: FileContext = { path: relativePath, text, lines };

      findings.push(...detectInFile(file));
    } catch {
      // Skip files that can't be read
    }
  }

  return findings;
}
