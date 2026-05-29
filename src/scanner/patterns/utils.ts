import { ApiCallMatch, HttpCallMatch } from "./types";

const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);

export function toSnakeCase(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

export function normalizeMethod(value: string | undefined, fallback = "GET"): string {
  if (!value) return fallback;
  const normalized = value.toUpperCase();
  return HTTP_METHODS.has(normalized) ? normalized : fallback;
}

export function parseHost(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    if (!/^https?:\/\//i.test(url)) return undefined;
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

export function uniqueMatches(matches: ApiCallMatch[]): ApiCallMatch[] {
  const seen = new Set<string>();
  const results: ApiCallMatch[] = [];

  for (const match of matches) {
    const key = [
      match.kind,
      match.provider ?? "",
      match.sdk ?? "",
      match.method ?? "",
      match.endpoint ?? "",
      match.resource ?? "",
      match.action ?? "",
      match.operationName ?? "",
      match.host ?? "",
      match.streaming ? "1" : "0",
      match.batchCapable ? "1" : "0",
      match.inlineParallelCapable ? "1" : "0",
    ].join("|");

    if (seen.has(key)) continue;
    seen.add(key);
    results.push(match);
  }

  return results;
}

export function toHttpCallMatches(matches: ApiCallMatch[]): HttpCallMatch[] {
  const seen = new Set<string>();
  const results: HttpCallMatch[] = [];

  for (const match of matches) {
    if (!match.method || !match.endpoint) continue;
    const library = match.provider ?? match.sdk ?? match.kind;
    const key = `${match.method} ${match.endpoint} ${library}`;
    if (seen.has(key)) continue;
    seen.add(key);
    results.push({ method: match.method, url: match.endpoint, library });
  }

  return results;
}

export function normalizeDynamic(raw: string): string {
  return `<dynamic:${raw}>`;
}

export function withRisk(match: ApiCallMatch, risk: string): ApiCallMatch {
  const risks = match.inferredCostRisk ? [...match.inferredCostRisk] : [];
  if (!risks.includes(risk)) risks.push(risk);
  return { ...match, inferredCostRisk: risks };
}
