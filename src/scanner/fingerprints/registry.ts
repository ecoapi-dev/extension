import type { CostModel, MethodFingerprint } from "./types";
import { ALL_PROVIDERS, HOST_MAP_PROVIDERS } from "./index";

const DEBUG_BUNDLE_LOGS = process.env.RECOST_DEBUG_SCAN === "1";

// ── Index structures built once at module load ────────────────────────────────

/** provider (lowercase) → pattern → MethodFingerprint */
const methodIndex = new Map<string, Map<string, MethodFingerprint>>();

/**
 * A7 (issue #79): provider (lowercase) → list of URL-path methods, sorted by
 * descending urlPathKey length so longest-match wins. The special key
 * `"_default"` is the provider-wide fallback and is kept at the end.
 */
const urlPathIndex = new Map<string, MethodFingerprint[]>();

/** lowercase exact hostname → provider id */
const exactHostIndex = new Map<string, string>();

/** ordered list of regex-based host matchers */
const regexHostIndex: Array<{ regex: RegExp; provider: string }> = [];

for (const fp of ALL_PROVIDERS) {
  const key = fp.provider.toLowerCase();

  // Method index — SDK-chain entries only (those with `pattern`)
  const methods = new Map<string, MethodFingerprint>();
  const urlPathEntries: MethodFingerprint[] = [];
  for (const m of fp.methods) {
    if (m.pattern) {
      methods.set(m.pattern, m);
    }
    if (m.urlPathKey) {
      urlPathEntries.push(m);
    }
  }
  methodIndex.set(key, methods);

  if (urlPathEntries.length > 0) {
    // Longest urlPathKey first so specific matches win over short prefixes.
    // `_default` is always the longest-tail fallback.
    urlPathEntries.sort((a, b) => {
      const aIsDefault = a.urlPathKey === "_default";
      const bIsDefault = b.urlPathKey === "_default";
      if (aIsDefault && !bIsDefault) return 1;
      if (!aIsDefault && bIsDefault) return -1;
      return (b.urlPathKey?.length ?? 0) - (a.urlPathKey?.length ?? 0);
    });
    urlPathIndex.set(key, urlPathEntries);
  }

  // Host index (exact entries in ALL_PROVIDERS take priority)
  for (const h of fp.hosts) {
    const resolvedProvider = h.provider ?? fp.provider;
    if (h.isRegex) {
      regexHostIndex.push({ regex: new RegExp(h.pattern, "i"), provider: resolvedProvider });
    } else {
      exactHostIndex.set(h.pattern.toLowerCase(), resolvedProvider);
    }
  }
}

// Host-only providers (grouped mapping files — hosts only, no methods)
for (const fp of HOST_MAP_PROVIDERS) {
  for (const h of fp.hosts) {
    const resolvedProvider = h.provider ?? fp.provider;
    if (h.isRegex) {
      regexHostIndex.push({ regex: new RegExp(h.pattern, "i"), provider: resolvedProvider });
    } else {
      exactHostIndex.set(h.pattern.toLowerCase(), resolvedProvider);
    }
  }
}

// ── Startup diagnostic ────────────────────────────────────────────────────────

{
  let methodCount = 0;
  for (const methods of methodIndex.values()) methodCount += methods.size;
  if (DEBUG_BUNDLE_LOGS) {
    console.log(
      "[BUNDLE] Registry loaded:",
      methodIndex.size, "providers,",
      methodCount, "methods,",
      exactHostIndex.size, "exact hosts,",
      regexHostIndex.length, "regex hosts"
    );
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Look up a method fingerprint by provider and method chain.
 *
 * The chain may include a leading variable name that won't be in the registry
 * (e.g. "client.chat.completions.create"). If an exact match is not found the
 * first dot-segment is stripped and the lookup is retried, so both
 * "chat.completions.create" and "client.chat.completions.create" resolve to the
 * same entry.
 *
 * Provider matching is case-insensitive.
 *
 * @returns The matching `MethodFingerprint`, or `null` if not found.
 */
export function lookupMethod(provider: string, methodChain: string): MethodFingerprint | null {
  if (!provider || !methodChain) return null;

  const methods = methodIndex.get(provider.toLowerCase());
  if (!methods) return null;

  // 1. Exact match
  const exact = methods.get(methodChain);
  if (exact) return exact;

  // 2. Strip the first segment (variable/alias name) and retry
  const dot = methodChain.indexOf(".");
  if (dot !== -1) {
    const withoutRoot = methodChain.slice(dot + 1);
    const stripped = methods.get(withoutRoot);
    if (stripped) return stripped;
  }

  return null;
}

/**
 * Resolve a hostname to a provider id.
 *
 * Exact matches are checked first (O(1)), then regex patterns in registration
 * order. Returns `null` for unknown hosts.
 *
 * @example
 * lookupHost("api.openai.com")              // → "openai"
 * lookupHost("us-central1-aiplatform.googleapis.com") // → "vertex-ai"
 */
export function lookupHost(hostname: string): string | null {
  if (!hostname) return null;

  const exact = exactHostIndex.get(hostname.toLowerCase());
  if (exact) return exact;

  for (const { regex, provider } of regexHostIndex) {
    if (regex.test(hostname)) return provider;
  }

  return null;
}

/**
 * Find a fingerprint method by matching the request URL's path against
 * `urlPathKey` entries. Falls back to the `_default` entry if no specific
 * match. Returns `null` if the provider is unknown, has no URL-path entries,
 * or the URL is malformed.
 *
 * A7 (issue #79): raw-fetch calls have a provider attributed via host match
 * (see `lookupHost`) but no SDK method chain. Match by URL path instead so
 * the cost layer can produce a non-stub estimate.
 *
 * Matching is longest-key-first against the request path+query, so
 * `"v1/text-to-speech"` wins over a hypothetical shorter `"v1/"` prefix.
 */
export function lookupByUrlPath(provider: string, url: string): MethodFingerprint | null {
  if (!provider || !url) return null;

  const entries = urlPathIndex.get(provider.toLowerCase());
  if (!entries || entries.length === 0) return null;

  let pathAndQuery: string;
  try {
    const parsed = new URL(url);
    pathAndQuery = parsed.pathname + (parsed.search ?? "");
  } catch {
    return null;
  }

  let fallback: MethodFingerprint | null = null;
  for (const entry of entries) {
    if (entry.urlPathKey === "_default") {
      fallback = entry;
      continue;
    }
    if (entry.urlPathKey && pathAndQuery.includes(entry.urlPathKey)) {
      return entry;
    }
  }
  return fallback;
}

/**
 * Return all registered provider ids (in registration order).
 */
export function getAllProviders(): string[] {
  return ALL_PROVIDERS.map((fp) => fp.provider);
}

/**
 * Return all method fingerprints for a given provider.
 *
 * Provider matching is case-insensitive. Returns an empty array for unknown
 * providers.
 */
export function getProviderMethods(provider: string): MethodFingerprint[] {
  if (!provider) return [];
  const methods = methodIndex.get(provider.toLowerCase());
  return methods ? Array.from(methods.values()) : [];
}

/**
 * Returns true if the given provider id is registered in the bundled method index
 * (i.e., it is one of the ALL_PROVIDERS entries). Case-insensitive.
 */
export function isRegisteredProvider(provider: string): boolean {
  if (!provider) return false;
  return methodIndex.has(provider.toLowerCase());
}

// ── Pricing sync ──────────────────────────────────────────────────────────────

/** Pricing fields that may be overwritten from the backend. Detection fields are never touched. */
const PRICING_FIELDS = [
  "costModel",
  "inputPricePer1M",
  "outputPricePer1M",
  "fixedFee",
  "percentageFee",
  "perRequestCostUsd",
] as const;

type PricingFieldKey = (typeof PRICING_FIELDS)[number];

interface BackendMethodPricing {
  costModel?: CostModel;
  inputPricePer1M?: number;
  outputPricePer1M?: number;
  fixedFee?: number;
  percentageFee?: number;
  perRequestCostUsd?: number;
  // Any extra fields from the backend (e.g. detection fields) are intentionally ignored.
  [key: string]: unknown;
}

interface BackendPricingResponse {
  schemaVersion?: string;
  updatedAt?: string;
  providers: {
    [providerName: string]: {
      methods: {
        [methodPattern: string]: BackendMethodPricing;
      };
    };
  };
}

/**
 * Fetch fresh pricing from the backend and patch the in-memory registry.
 *
 * Only pricing fields (costModel, inputPricePer1M, outputPricePer1M, fixedFee,
 * percentageFee, perRequestCostUsd) are overwritten. Detection fields (pattern,
 * httpMethod, endpoint, streaming, batchCapable, cacheCapable, description,
 * hosts, packages, languages) are NEVER touched.
 *
 * Methods returned by the API that are not in the bundled registry are skipped.
 * Bundled methods not present in the API response are left unchanged.
 * Any failure (timeout, HTTP error, malformed JSON) is logged and silently
 * ignored so the extension continues with bundled pricing.
 *
 * @param backendUrl  Base URL of the ReCost backend, e.g. "https://api.recost.dev"
 */
export async function syncPricingFromBackend(backendUrl: string): Promise<void> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 3_000);

  let raw: unknown;
  try {
    const response = await fetch(`${backendUrl}/pricing`, { signal: controller.signal });
    if (!response.ok) {
      console.warn(`ReCost: pricing sync failed (HTTP ${response.status}), using bundled pricing`);
      return;
    }
    raw = await response.json();
  } catch (err) {
    console.warn("ReCost: pricing sync failed, using bundled pricing:", err);
    return;
  } finally {
    clearTimeout(timeoutId);
  }

  // Validate top-level shape
  if (
    raw == null ||
    typeof raw !== "object" ||
    !("providers" in raw) ||
    raw.providers == null ||
    typeof raw.providers !== "object"
  ) {
    console.warn("ReCost: pricing sync returned malformed data, using bundled pricing");
    return;
  }

  const data = raw as BackendPricingResponse;

  for (const [providerName, providerData] of Object.entries(data.providers)) {
    if (
      providerData == null ||
      typeof providerData !== "object" ||
      providerData.methods == null ||
      typeof providerData.methods !== "object"
    ) {
      continue;
    }

    const methods = methodIndex.get(providerName.toLowerCase());
    if (!methods) {
      // Provider not in bundled registry — skip entirely
      continue;
    }

    for (const [methodPattern, pricingData] of Object.entries(providerData.methods)) {
      const entry = methods.get(methodPattern);
      if (!entry) {
        // Method not in bundled registry — skip
        continue;
      }

      if (pricingData == null || typeof pricingData !== "object") {
        continue;
      }

      // Overwrite only pricing fields; never touch detection fields
      for (const field of PRICING_FIELDS) {
        const value = (pricingData as BackendMethodPricing)[field];
        if (value !== undefined) {
          // Type-safe assignment through the known union
          (entry as Record<PricingFieldKey, unknown>)[field] = value;
        }
      }
    }
  }
}
