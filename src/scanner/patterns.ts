export interface HttpCallMatch {
  method: string;
  url: string;
  library: string;
}

interface PatternDef {
  library: string;
  regex: RegExp;
  methodGroup: number | null;
  urlGroup: number;
  fixedMethod?: string;
  normalizeUrl?: (raw: string) => string;
}

const PATTERN_DEFS: PatternDef[] = [
  {
    library: "fetch",
    regex: /fetch\(\s*['"`]([^'"`\n]+)['"`]\s*,\s*\{[^}]*method:\s*['"`](GET|POST|PUT|PATCH|DELETE)['"`]/gi,
    urlGroup: 1,
    methodGroup: 2,
  },
  {
    library: "fetch",
    regex: /fetch\(\s*['"`]([^'"`\n]+)['"`]/gi,
    urlGroup: 1,
    methodGroup: null,
  },
  {
    library: "fetch",
    regex: /fetch\(\s*`([^`]+)`/gi,
    urlGroup: 1,
    methodGroup: null,
  },
  {
    library: "fetch",
    regex: /fetch\(\s*([A-Za-z_$][\w$.]*)/gi,
    urlGroup: 1,
    methodGroup: null,
    normalizeUrl: (raw) => `<dynamic:${raw}>`,
  },
  {
    library: "axios",
    regex: /axios\.(get|post|put|patch|delete|head|options)\(\s*['"`]([^'"`\s]+)['"`]/gi,
    methodGroup: 1,
    urlGroup: 2,
  },
  {
    library: "axios",
    regex: /axios\(\s*['"`]([^'"`\n]+)['"`]/gi,
    urlGroup: 1,
    methodGroup: null,
  },
  {
    library: "axios",
    regex: /axios\(\s*([A-Za-z_$][\w$.]*)/gi,
    methodGroup: null,
    urlGroup: 1,
    normalizeUrl: (raw) => `<dynamic:${raw}>`,
  },
  {
    library: "got",
    regex: /got\.(get|post|put|patch|delete)\(\s*['"`]([^'"`\s]+)['"`]/gi,
    methodGroup: 1,
    urlGroup: 2,
  },
  {
    library: "got",
    regex: /got\(\s*['"`]([^'"`\s]+)['"`]/gi,
    urlGroup: 1,
    methodGroup: null,
  },
  {
    library: "superagent",
    regex: /superagent\.(get|post|put|patch|delete)\(\s*['"`]([^'"`\s]+)['"`]/gi,
    methodGroup: 1,
    urlGroup: 2,
  },
  {
    library: "ky",
    regex: /ky\.(get|post|put|patch|delete)\(\s*['"`]([^'"`\s]+)['"`]/gi,
    methodGroup: 1,
    urlGroup: 2,
  },
  {
    library: "requests",
    regex: /requests\.(get|post|put|patch|delete)\(\s*['"`]([^'"`\s]+)['"`]/gi,
    methodGroup: 1,
    urlGroup: 2,
  },
  {
    library: "requests",
    regex: /requests\.(get|post|put|patch|delete)\(\s*([A-Za-z_][\w.]*)/gi,
    methodGroup: 1,
    urlGroup: 2,
    normalizeUrl: (raw) => `<dynamic:${raw}>`,
  },
  {
    library: "http",
    regex: /http\.(Get|Post|Head)\(\s*['"`]([^'"`\s]+)['"`]/gi,
    methodGroup: 1,
    urlGroup: 2,
  },
  {
    library: "HttpClient",
    regex: /(?:this\.)?http\.(get|post|put|patch|delete)\s*(?:<[^>]*>)?\s*\(\s*['"`]([^'"`\s]+)['"`]/gi,
    methodGroup: 1,
    urlGroup: 2,
  },
  {
    library: "$http",
    regex: /\$http\.(get|post|put|patch|delete)\(\s*['"`]([^'"`\s]+)['"`]/gi,
    methodGroup: 1,
    urlGroup: 2,
  },
  {
    library: "api-helper",
    regex: /(?:this\.)?(get|post|put|patch|delete)\(\s*['"`](\/[^'"`\n]+)['"`]/gi,
    methodGroup: 1,
    urlGroup: 2,
  },
];

const LOOP_KEYWORDS = /\b(for|while|forEach|\.map|\.flatMap|\.reduce)\b/;
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

function toSnakeCase(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

function mapOpenAiActionToMethod(action: string): string {
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

function buildOpenAiUrl(chain: string, action: string): string | null {
  const parts = chain.split(".");
  if (parts.length < 2) return null;

  let resources = parts.slice(1); // drop variable name
  if (resources[0] === "beta") {
    resources = resources.slice(1);
  }
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

  const fullPath = `${basePath}${suffix}`;
  return `https://api.openai.com/v1/${fullPath}`;
}

function matchOpenAiClientCalls(line: string): HttpCallMatch[] {
  const results: HttpCallMatch[] = [];
  const seen = new Set<string>();

  OPENAI_ACTION_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = OPENAI_ACTION_REGEX.exec(line)) !== null) {
    const chain = match[1];
    const action = match[2];
    if (action === "unwrap" || action === "verify_signature") continue;
    const url = buildOpenAiUrl(chain, action);
    if (!url) continue;
    const method = mapOpenAiActionToMethod(action);
    const key = `${method} ${url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    results.push({ method, url, library: "openai" });
  }

  return results;
}

export function matchLine(line: string): HttpCallMatch[] {
  const matches: HttpCallMatch[] = [];
  const seen = new Set<string>();

  for (const def of PATTERN_DEFS) {
    def.regex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = def.regex.exec(line)) !== null) {
      const method = def.fixedMethod ?? (def.methodGroup !== null ? match[def.methodGroup].toUpperCase() : "GET");
      const rawUrl = match[def.urlGroup];
      const url = def.normalizeUrl ? def.normalizeUrl(rawUrl) : rawUrl;
      const key = `${method} ${url}`;
      if (!seen.has(key)) {
        seen.add(key);
        matches.push({ method, url, library: def.library });
      }
    }
  }

  for (const openAiCall of matchOpenAiClientCalls(line)) {
    const key = `${openAiCall.method} ${openAiCall.url}`;
    if (!seen.has(key)) {
      seen.add(key);
      matches.push(openAiCall);
    }
  }

  return matches;
}

export function matchRouteDefinitionLine(line: string): HttpCallMatch[] {
  const results: HttpCallMatch[] = [];
  const seen = new Set<string>();

  const expressLike = /\b(?:router|app)\.(get|post|put|patch|delete)\(\s*['"`]([^'"`\n]+)['"`]/gi;
  let expressMatch: RegExpExecArray | null;
  while ((expressMatch = expressLike.exec(line)) !== null) {
    const method = expressMatch[1].toUpperCase();
    const url = expressMatch[2];
    const key = `${method} ${url}`;
    if (!seen.has(key)) {
      seen.add(key);
      results.push({ method, url, library: "route-def" });
    }
  }

  const flaskRoute = /@[\w.]+\.route\(\s*['"`]([^'"`\n]+)['"`]\s*,\s*methods\s*=\s*\[([^\]]+)\]/gi;
  let flaskMatch: RegExpExecArray | null;
  while ((flaskMatch = flaskRoute.exec(line)) !== null) {
    const url = flaskMatch[1];
    const methodsRaw = flaskMatch[2];
    const methods = methodsRaw.match(/[A-Za-z]+/g) ?? ["GET"];
    for (const methodName of methods) {
      const method = methodName.toUpperCase();
      const key = `${method} ${url}`;
      if (!seen.has(key)) {
        seen.add(key);
        results.push({ method, url, library: "route-def" });
      }
    }
  }

  const fastApiRoute = /@[\w.]+\.(get|post|put|patch|delete)\(\s*['"`]([^'"`\n]+)['"`]/gi;
  let fastApiMatch: RegExpExecArray | null;
  while ((fastApiMatch = fastApiRoute.exec(line)) !== null) {
    const method = fastApiMatch[1].toUpperCase();
    const url = fastApiMatch[2];
    const key = `${method} ${url}`;
    if (!seen.has(key)) {
      seen.add(key);
      results.push({ method, url, library: "route-def" });
    }
  }

  return results;
}

export function isInsideLoop(lines: string[], currentIndex: number): boolean {
  const lookback = Math.max(0, currentIndex - 5);
  for (let i = lookback; i < currentIndex; i++) {
    if (LOOP_KEYWORDS.test(lines[i])) {
      return true;
    }
  }
  return false;
}
