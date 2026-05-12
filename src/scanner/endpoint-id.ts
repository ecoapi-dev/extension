import { maskUrlDynamicParts } from "./url-template";

/** Inputs are intentionally narrow — line/column/timing fields are excluded. */
export interface EndpointIdInput {
  provider: string | null | undefined;
  methodSignature: string | null | undefined;
  filePath: string;
  enclosingFunction: string | null | undefined;
  url: string | null | undefined;
}

function normalizeFilePath(filePath: string): string {
  return filePath.replace(/\\/g, "/").replace(/^\.\/+/, "");
}

/** FNV-1a 32-bit. Same algorithm as `intelligence/builder.ts:makeStableFingerprint`. */
function fnv1a(input: string): string {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

/**
 * Deterministic endpoint identifier.
 *
 * Excluded by design: line, column, span, scan ID, scan timestamp.
 * Included: provider, method signature, normalized file path, enclosing
 * function name, masked URL template.
 */
export function computeEndpointId(input: EndpointIdInput): string {
  const parts = [
    input.provider ?? "null",
    input.methodSignature ?? "null",
    normalizeFilePath(input.filePath),
    input.enclosingFunction ?? "null",
    input.url ? maskUrlDynamicParts(input.url) : "null",
  ];
  return `ep_${fnv1a(parts.join("|"))}`;
}
