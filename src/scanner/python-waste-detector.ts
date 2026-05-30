import * as path from "path";
import type { SuggestionType, Severity } from "../analysis/types";
import type { AstCallMatch } from "../ast/ast-scanner";
import type { LocalWasteFinding } from "./local-waste-detector";

const PYTHON_EXTENSIONS = new Set([".py", ".pyw"]);

const PYTHON_DENYLIST = new Set([
  "os", "sys", "pathlib", "subprocess", "json", "re", "collections",
  "itertools", "functools", "typing", "asyncio", "threading", "glob",
  "warnings", "logging", "datetime", "time", "math", "random",
  "io", "abc", "copy", "enum", "dataclasses", "contextlib",
  "pytest", "unittest", "hypothesis", "nose", "mock",
  "fastapi", "flask", "django", "starlette", "uvicorn",
  "pydantic", "attrs", "click", "typer", "rich", "tqdm",
]);

const LANGCHAIN_PROVIDERS = new Set([
  "langchain", "langchain_openai", "langchain_anthropic",
  "langchain_community", "langchain_core", "langchain_google_genai",
  "langchain_cohere", "langchain_mistralai",
]);

const LLAMAINDEX_PROVIDERS = new Set([
  "llama_index", "llama-index", "llama_index.core",
  "llama_index.llms", "llama_index.embeddings",
]);

const RAW_SDK_PROVIDERS = new Set([
  "openai", "anthropic", "cohere", "mistralai", "google.generativeai",
  "boto3", "stripe", "supabase", "firebase_admin",
]);

const LOOP_FREQUENCIES = new Set(["bounded-loop", "unbounded-loop"]);
const NON_LOOP_FREQUENCIES = new Set(["single", "conditional", "cache-guarded"]);
const CONCURRENCY_GUARD = /\b(semaphore|bounded_sem|limit(?:er)?|pool|throttle|rate_limit|max_concurrency)\b/i;
const CACHE_GUARD = /@(?:functools\.)?(?:lru_cache|cache)\b|@(?:cached|cachedmethod)\b|\b(redis|cache|memoize|ttlcache)\b/i;
const LANGCHAIN_LOOP_CALL = /\.(invoke|run)\b/i;
const PYTHON_READ_CALL = /\b(get|list|retrieve|fetch|query|search|lookup|read|describe|embed(?:dings?)?|invoke|run)\b/i;
const PYTHON_WRITE_CALL = /\b(create|insert|update|delete|submit|upload|write|stream|publish)\b/i;
const PYTHON_GENERATIVE_METHOD = /\b(chat\.completions|messages|responses|generate|generate_content|invoke|run|stream|images?\.generate|audio\.(speech|transcriptions)|tts|stt)\b/i;
const ASYNCIO_GATHER = /\basyncio\.gather\s*\(/i;

type ProviderKind = "langchain" | "llamaindex" | "raw-sdk" | "other";

interface ClassifiedMatch {
  match: AstCallMatch;
  providerKey: string;
  kind: ProviderKind;
}

function clampConfidence(value: number): number {
  return Number(Math.max(0, Math.min(1, value)).toFixed(2));
}

function scoreToSeverity(score: number): Severity {
  if (score >= 5) return "high";
  if (score >= 3) return "medium";
  return "low";
}

function normalizeModuleName(value: string | undefined): string | null {
  if (!value) return null;
  return value.replace(/-/g, "_").trim().toLowerCase();
}

function topLevelModule(value: string | null): string | null {
  if (!value) return null;
  return value.split(".")[0] ?? value;
}

function matchesProviderSet(value: string | null, set: Set<string>): boolean {
  if (!value) return false;
  const normalizedEntries = [...set].map((entry) => normalizeModuleName(entry)).filter(Boolean) as string[];
  return normalizedEntries.some((entry) => value === entry || value.startsWith(`${entry}.`));
}

function classifyPythonProvider(match: AstCallMatch): ClassifiedMatch | null {
  const packageName = normalizeModuleName(match.packageName);
  const provider = normalizeModuleName(match.provider);
  const packageTop = topLevelModule(packageName);
  const providerTop = topLevelModule(provider);
  const candidates = [packageName, provider, packageTop, providerTop].filter(Boolean) as string[];

  for (const candidate of candidates) {
    if (PYTHON_DENYLIST.has(candidate)) return null;
  }

  for (const candidate of candidates) {
    if (matchesProviderSet(candidate, LANGCHAIN_PROVIDERS)) {
      return { match, providerKey: candidate, kind: "langchain" };
    }
  }

  for (const candidate of candidates) {
    if (matchesProviderSet(candidate, LLAMAINDEX_PROVIDERS)) {
      return { match, providerKey: candidate, kind: "llamaindex" };
    }
  }

  for (const candidate of candidates) {
    if (matchesProviderSet(candidate, RAW_SDK_PROVIDERS)) {
      return { match, providerKey: candidate, kind: "raw-sdk" };
    }
  }

  return null;
}

function surroundingWindow(lines: string[], line: number, radius = 8): string {
  const idx = Math.max(0, line - 1);
  return lines.slice(Math.max(0, idx - radius), Math.min(lines.length, idx + radius + 1)).join("\n");
}

function precedingWindow(lines: string[], line: number, radius = 10): string {
  const idx = Math.max(0, line - 1);
  return lines.slice(Math.max(0, idx - radius), idx + 1).join("\n");
}

function betweenWindow(lines: string[], startLine: number, endLine: number, padding = 4): string {
  const start = Math.max(0, startLine - 1 - padding);
  const end = Math.min(lines.length, endLine + padding);
  return lines.slice(start, end).join("\n");
}

function isReadLikeCall(match: AstCallMatch): boolean {
  const method = (match.method ?? "").toUpperCase();
  const signature = [match.methodChain, match.endpoint].filter(Boolean).join(" ");

  // Generative endpoints are conceptually non-cacheable even when the registry
  // marks them cacheCapable. Suppress before any other "read-like" inference.
  if (PYTHON_GENERATIVE_METHOD.test(signature)) return false;

  // Explicit write verbs always win — even over fingerprint cacheCapable.
  if (PYTHON_WRITE_CALL.test(signature)) return false;

  // Explicit write HTTP methods are authoritative — POST /v1/embed is a remote
  // computation request, not a read, even if the URL path contains a read keyword.
  if (method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE") return false;

  if (match.cacheCapable) return true;
  if (method === "GET") return true;
  return PYTHON_READ_CALL.test(signature);
}

function dedupeFindings(findings: LocalWasteFinding[]): LocalWasteFinding[] {
  const seen = new Map<string, LocalWasteFinding>();
  for (const finding of findings) {
    const key = `${finding.type}:${finding.affectedFile}:${finding.line ?? 0}`;
    const existing = seen.get(key);
    if (!existing || finding.confidence > existing.confidence) {
      seen.set(key, finding);
    }
  }
  return [...seen.values()];
}

function makeFinding(
  type: SuggestionType,
  filePath: string,
  line: number,
  score: number,
  confidence: number,
  description: string,
  evidence: string[]
): LocalWasteFinding {
  return {
    id: `python-${type}-${filePath}:${line}`,
    type,
    severity: scoreToSeverity(score),
    confidence: clampConfidence(confidence),
    riskScore: score,
    description,
    affectedFile: filePath,
    line,
    evidence,
  };
}

function detectLoopWaste(matches: ClassifiedMatch[], lines: string[], filePath: string): LocalWasteFinding[] {
  const findings: LocalWasteFinding[] = [];

  for (const classified of matches) {
    const { match, kind, providerKey } = classified;
    if (!LOOP_FREQUENCIES.has(match.frequency)) continue;

    const loopWindow = surroundingWindow(lines, match.line, 6);
    const guarded = CONCURRENCY_GUARD.test(loopWindow);
    if (guarded) continue;

    if (kind === "langchain" && LANGCHAIN_LOOP_CALL.test(match.methodChain)) {
      findings.push(
        makeFinding(
          "n_plus_one",
          filePath,
          match.line,
          5,
          0.82,
          "LangChain chain invocation runs inside a loop, multiplying LLM calls per item.",
          [
            `LangChain call "${match.methodChain}" executes in a "${match.frequency}" context.`,
            "Chain-level invoke/run inside iteration is a high-signal Python N+1 pattern.",
          ]
        )
      );
      continue;
    }

    findings.push(
      makeFinding(
        "n_plus_one",
        filePath,
        match.line,
        3,
        kind === "raw-sdk" || kind === "llamaindex" ? 0.7 : 0.62,
        "Provider call runs inside a loop, causing one remote request per iteration.",
        [
          `Provider "${providerKey}" call "${match.methodChain}" executes in a "${match.frequency}" context.`,
          "Per-item remote calls scale linearly with collection size and often need batching or restructuring.",
        ]
      )
    );
  }

  return findings;
}

function detectSequentialBatching(matches: ClassifiedMatch[], lines: string[], filePath: string): LocalWasteFinding[] {
  const findings: LocalWasteFinding[] = [];
  const byBucket = new Map<string, { providerKey: string; matches: ClassifiedMatch[] }>();

  for (const classified of matches) {
    if (!NON_LOOP_FREQUENCIES.has(classified.match.frequency)) continue;
    // Bucket by (providerKey, enclosingFunction): calls in different functions
    // can't be batched together — they execute on independent code paths.
    const fnKey = classified.match.enclosingFunction ?? "<module>";
    const key = `${classified.providerKey}::${fnKey}`;
    const bucket = byBucket.get(key) ?? { providerKey: classified.providerKey, matches: [] };
    bucket.matches.push(classified);
    byBucket.set(key, bucket);
  }

  for (const { providerKey, matches: group } of byBucket.values()) {
    const sorted = [...group].sort((a, b) => a.match.line - b.match.line);
    let start = 0;

    while (start < sorted.length) {
      let end = start;
      while (end + 1 < sorted.length && sorted[end + 1].match.line - sorted[start].match.line <= 30) {
        end += 1;
      }

      const cluster = sorted.slice(start, end + 1);
      if (cluster.length >= 3) {
        const firstLine = cluster[0].match.line;
        const lastLine = cluster[cluster.length - 1].match.line;
        const window = betweenWindow(lines, firstLine, lastLine, 5);
        if (!ASYNCIO_GATHER.test(window) && !CONCURRENCY_GUARD.test(window)) {
          findings.push(
            makeFinding(
              "batch",
              filePath,
              firstLine,
              4,
              0.73,
              `${cluster.length} sequential ${providerKey} calls appear close together and could likely be batched or awaited concurrently.`,
              [
                `${cluster.length} calls to "${providerKey}" appear within ${lastLine - firstLine} lines (${cluster.map((item) => item.match.line).join(", ")}).`,
                "No nearby asyncio.gather or concurrency limiter was detected for this call cluster.",
              ]
            )
          );
        }
        start = end + 1;
      } else {
        start += 1;
      }
    }
  }

  return findings;
}

function detectMissingCache(matches: ClassifiedMatch[], lines: string[], filePath: string): LocalWasteFinding[] {
  const findings: LocalWasteFinding[] = [];

  for (const classified of matches) {
    const { match, providerKey } = classified;
    if (!isReadLikeCall(match)) continue;
    const window = precedingWindow(lines, match.line, 10);
    if (CACHE_GUARD.test(window)) continue;

    findings.push(
      makeFinding(
        "cache",
        filePath,
        match.line,
        4,
        0.66,
        "Read-like provider call appears without a nearby Python cache or memoization guard.",
        [
          `Read-like call "${match.methodChain}" for provider "${providerKey}" has no nearby lru_cache/cache/redis signal.`,
          "Python read paths often benefit from memoization, decorator-based caching, or shared result reuse.",
        ]
      )
    );
  }

  return findings;
}

function detectGatherConcurrency(matches: ClassifiedMatch[], lines: string[], filePath: string): LocalWasteFinding[] {
  const findings: LocalWasteFinding[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!ASYNCIO_GATHER.test(line)) continue;

    const snippet = lines.slice(index, Math.min(lines.length, index + 8)).join("\n");
    const unpackedList = /asyncio\.gather\s*\(\s*\*[A-Za-z_][\w.]*/i.test(snippet);
    const listComprehension =
      /asyncio\.gather\s*\([^)]*\[[\s\S]{0,200}\bfor\b[\s\S]{0,200}\]/i.test(snippet) ||
      /asyncio\.gather\s*\([^)]*\([\s\S]{0,200}\bfor\b[\s\S]{0,200}\)/i.test(snippet);

    if (!unpackedList && !listComprehension) continue;
    if (CONCURRENCY_GUARD.test(snippet)) continue;

    const nearbyProviders = matches.filter((classified) => Math.abs(classified.match.line - (index + 1)) <= 20);
    if (nearbyProviders.length === 0) continue;

    const providers = [...new Set(nearbyProviders.map((classified) => classified.providerKey))];
    findings.push(
      makeFinding(
        "concurrency_control",
        filePath,
        index + 1,
        5,
        0.84,
        "asyncio.gather fan-out appears unbounded and can launch too many provider calls at once.",
        [
          unpackedList
            ? "asyncio.gather is called with an unpacked task list."
            : "asyncio.gather is called over a comprehension-built task list.",
          `Nearby provider calls detected for: ${providers.join(", ")}.`,
        ]
      )
    );
  }

  return findings;
}

export function detectPythonWaste(
  matches: AstCallMatch[],
  source: string,
  relativePath: string
): LocalWasteFinding[] {
  const ext = path.extname(relativePath).toLowerCase();
  if (!PYTHON_EXTENSIONS.has(ext)) return [];

  const lines = source.split("\n");
  const classified = matches
    .map((match) => classifyPythonProvider(match))
    .filter((match): match is ClassifiedMatch => match !== null);

  if (classified.length === 0) return [];

  const findings = [
    ...detectLoopWaste(classified, lines, relativePath),
    ...detectSequentialBatching(classified, lines, relativePath),
    ...detectMissingCache(classified, lines, relativePath),
    ...detectGatherConcurrency(classified, lines, relativePath),
  ];

  return dedupeFindings(findings);
}
