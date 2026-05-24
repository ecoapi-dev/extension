import { randomUUID } from "crypto";

/**
 * Returns a locally-generated scan ID for use when no remote scan ID is
 * available (no key configured, submission failed, offline mode). Format:
 * `local-<unix_ms>-<8 hex chars>`. The random suffix prevents collisions
 * when two scans land in the same millisecond.
 */
export function newLocalScanId(): string {
  const suffix = randomUUID().replace(/-/g, "").slice(0, 8);
  return `local-${Date.now()}-${suffix}`;
}
