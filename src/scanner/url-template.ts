const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const NUMERIC_SEGMENT_RE = /\/\d+(?=\/|$)/g;
const TEMPLATE_RE = /\$\{[^}]+\}|\{[^}]+\}|<[^>]+>/g;

/**
 * Replace dynamic URL segments with the placeholder `:id` so two calls that
 * differ only in user-supplied identifiers produce the same template.
 *
 * Pure / no I/O — used by endpoint-id hashing and safe to call anywhere.
 */
export function maskUrlDynamicParts(url: string): string {
  if (!url) return url;
  // sdk:// pseudo-URLs are already canonical — don't mangle them.
  if (url.startsWith("sdk://") || url.startsWith("ast:")) return url;

  // Strip query and hash before any pattern matching.
  const queryIdx = url.indexOf("?");
  const hashIdx = url.indexOf("#");
  const cutAt =
    queryIdx >= 0 && hashIdx >= 0 ? Math.min(queryIdx, hashIdx)
    : queryIdx >= 0 ? queryIdx
    : hashIdx >= 0 ? hashIdx
    : -1;
  let stripped = cutAt >= 0 ? url.slice(0, cutAt) : url;

  // Order matters: UUIDs and templates first (they may contain digits),
  // then numeric segments.
  stripped = stripped.replace(UUID_RE, ":id");
  stripped = stripped.replace(TEMPLATE_RE, ":id");
  stripped = stripped.replace(NUMERIC_SEGMENT_RE, "/:id");

  return stripped;
}
