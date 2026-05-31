import type { SourceSpan } from "./source-span";

/** A concrete location: a workspace-relative file plus a span within it. */
export interface ResolvedLocation {
  /** Workspace-relative path (matches EndpointCallSite.file). */
  file: string;
  span: SourceSpan;
}

/**
 * Dual-location trace for a detected call.
 *
 * - `callSite`     — where the user's code invokes the (possibly wrapped) call.
 * - `resolvedSite` — where the underlying SDK call actually lives.
 * - `hops`         — 0 for a direct call (the two sites are equal), >=1 when the
 *                    call was propagated across one or more wrapper files.
 */
export interface CallTrace {
  callSite: ResolvedLocation;
  resolvedSite: ResolvedLocation;
  hops: number;
}

/** Build a degenerate trace for a direct (non-propagated) call. */
export function directTrace(file: string, span: SourceSpan): CallTrace {
  const loc: ResolvedLocation = { file, span };
  // Distinct object per site so a future in-place mutation of one can't alias the other.
  return { callSite: loc, resolvedSite: { ...loc }, hops: 0 };
}
