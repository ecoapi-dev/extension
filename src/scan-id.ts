import { randomUUID } from "crypto";

export function newLocalScanId(): string {
  const suffix = randomUUID().replace(/-/g, "").slice(0, 8);
  return `local-${Date.now()}-${suffix}`;
}
