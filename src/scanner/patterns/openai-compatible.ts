import { ApiCallMatch, LineMatcher } from "./types";
import { parseHost, toSnakeCase } from "./utils";
import { lookupMethod, lookupHost } from "../fingerprints/registry";

const OPENAI_ACTION_REGEX =
  /\b([A-Za-z_$][\w$]*(?:\.[A-Za-z_][\w$]*){1,14})\.(create_and_run_stream|create_and_run_poll|create_and_run|create_and_stream|create_and_poll|upload_and_poll|submit_tool_outputs_and_poll|submit_tool_outputs_stream|submit_tool_outputs|wait_for_processing|download_content|retrieve_content|verify_signature|create_variation|list_events|list_files|generate|unwrap|retrieve|update|delete|cancel|search|validate|stream|upload|content|complete|create|list|poll|edit|run|remix|pause|resume)\s*\(/gi;

const OPENAI_ROOTS = new Set([
  "completions",
  "chat",
  "embeddings",
  "files",
  "images",
  "audio",
  "moderations",
  "models",
  "fine_tuning",
  "fineTuning",
  "vectorStores",
  "vector_stores",
  "batches",
  "uploads",
  "responses",
  "realtime",
  "conversations",
  "evals",
  "containers",
  "skills",
  "videos",
  "assistants",
  "threads",
  "webhooks",
]);

function mapActionToMethod(action: string): string {
  if (action === "delete") return "DELETE";
  if (
    action === "retrieve" ||
    action === "list" ||
    action === "poll" ||
    action === "wait_for_processing" ||
    action === "list_events" ||
    action === "list_files" ||
    action === "content" ||
    action === "retrieve_content" ||
    action === "download_content"
  ) {
    return "GET";
  }
  return "POST";
}

function mapHostToProvider(host: string | undefined): string {
  if (!host) return "openai";
  const provider = lookupHost(host);
  if (provider) return provider;
  return "openai-compatible";
}

function buildOpenAiPath(chain: string, action: string): string | null {
  const parts = chain.split(".");
  if (parts.length < 2) return null;

  let resources = parts.slice(1);
  if (resources[0] === "beta") resources = resources.slice(1);
  if (resources.length === 0) return null;
  if (!OPENAI_ROOTS.has(resources[0])) return null;

  const normalized = resources.map((segment) => toSnakeCase(segment));
  const basePath = normalized.join("/");

  let suffix = "";
  if (action === "create_variation") suffix = "/variations";
  if (action === "generate") suffix = "/generations";
  if (action === "edit") suffix = "/edits";
  if (action === "remix") suffix = "/remix";
  if (action === "list_events") suffix = "/events";
  if (action === "list_files") suffix = "/files";
  if (action === "content" || action === "retrieve_content" || action === "download_content") suffix = "/content";

  if (
    action === "cancel" ||
    action === "pause" ||
    action === "resume" ||
    action === "complete" ||
    action === "submit_tool_outputs"
  ) {
    suffix = `/${action}`;
  }

  if (action === "submit_tool_outputs_and_poll" || action === "submit_tool_outputs_stream") {
    suffix = "/submit_tool_outputs";
  }

  if (action === "create_and_run" || action === "create_and_run_poll" || action === "create_and_run_stream") {
    if (basePath.endsWith("threads")) suffix = "/runs";
  }

  return `/v1/${basePath}${suffix}`;
}

function readBaseUrlMap(line: string): Map<string, string> {
  const baseUrlByClient = new Map<string, string>();

  const jsCtor = /(const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*new\s+OpenAI\s*\(\s*\{[\s\S]{0,200}?baseURL\s*:\s*(["'`])([^"'`]+)\3[\s\S]{0,200}?\}\s*\)/gi;
  let match: RegExpExecArray | null;
  while ((match = jsCtor.exec(line)) !== null) {
    baseUrlByClient.set(match[2], match[4]);
  }

  const jsCtorDynamic = /(const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*new\s+OpenAI\s*\(\s*\{[\s\S]{0,200}?baseURL\s*:\s*([A-Za-z_$][\w$.]*)/gi;
  while ((match = jsCtorDynamic.exec(line)) !== null) {
    baseUrlByClient.set(match[2], `<dynamic:${match[3]}>`);
  }

  const pyCtor = /([A-Za-z_][\w]*)\s*=\s*OpenAI\s*\([\s\S]{0,200}?base_url\s*=\s*(["'])([^"']+)\2[\s\S]{0,200}?\)/gi;
  while ((match = pyCtor.exec(line)) !== null) {
    baseUrlByClient.set(match[1], match[3]);
  }

  const pyCtorDynamic = /([A-Za-z_][\w]*)\s*=\s*OpenAI\s*\([\s\S]{0,200}?base_url\s*=\s*([A-Za-z_][\w.]*)/gi;
  while ((match = pyCtorDynamic.exec(line)) !== null) {
    baseUrlByClient.set(match[1], `<dynamic:${match[2]}>`);
  }

  return baseUrlByClient;
}

function buildAbsoluteEndpoint(baseUrl: string | undefined, path: string): { endpoint: string; host?: string } {
  if (!baseUrl) {
    const endpoint = `https://api.openai.com${path}`;
    return { endpoint, host: "api.openai.com" };
  }

  if (/^<dynamic:/i.test(baseUrl)) {
    return { endpoint: `${baseUrl}${path}` };
  }

  const normalizedBase = baseUrl.replace(/\/+$/, "");
  const normalizedPath = normalizedBase.endsWith("/v1") && path.startsWith("/v1/") ? path.slice(3) : path;
  const endpoint = `${normalizedBase}${normalizedPath}`;
  return { endpoint, host: parseHost(endpoint) };
}

export const openAiCompatibleMatcher: LineMatcher = {
  name: "openai-compatible",
  matchLine(line: string): ApiCallMatch[] {
    const results: ApiCallMatch[] = [];
    const baseUrlByClient = readBaseUrlMap(line);

    OPENAI_ACTION_REGEX.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = OPENAI_ACTION_REGEX.exec(line)) !== null) {
      const chain = match[1];
      const action = match[2];
      if (action === "unwrap" || action === "verify_signature") continue;

      const path = buildOpenAiPath(chain, action);
      if (!path) continue;

      const rootClient = chain.split(".")[0];
      const configuredBaseUrl = baseUrlByClient.get(rootClient);
      const built = buildAbsoluteEndpoint(configuredBaseUrl, path);
      const method = mapActionToMethod(action);
      const host = built.host;
      const provider = mapHostToProvider(host);
      // Build the method chain without the variable prefix for registry lookup
      // e.g. chain = "client.chat.completions", action = "create"
      // → methodChain = "chat.completions.create"
      const chainParts = chain.split(".");
      const methodChain = [...chainParts.slice(1), action].join(".");
      const reg = lookupMethod(provider, methodChain);

      const streaming = reg?.streaming ?? /stream/i.test(action);
      const batchCapable = reg?.batchCapable ?? /batches|batch/.test(path);
      // No hint-regex fallback: inline-parallel capability (an n/count param)
      // is a registry-only signal — there is no reliable lexical hint for it.
      const inlineParallelCapable = reg?.inlineParallelCapable ?? false;
      const cacheCapable = reg?.cacheCapable ?? /responses|chat|assistants|threads/.test(path);

      results.push({
        kind: "sdk",
        provider,
        sdk: "openai-compatible",
        method,
        // Keep dynamically built endpoint (may include custom baseURL)
        endpoint: built.endpoint,
        resource: path,
        action,
        host,
        streaming,
        batchCapable,
        inlineParallelCapable,
        cacheCapable,
        rawMatch: match[0],
      });
    }

    return results;
  },
};
