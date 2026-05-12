/**
 * Span describing where a detection lives in source.
 *
 * - Lines are 1-based to match VSCode's display convention.
 * - Columns are 0-based to match tree-sitter's `startPosition.column`
 *   and VSCode's `Position` constructor.
 */
export interface SourceSpan {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

/** Build a zero-width span at a single point (used as a safe fallback). */
export function pointSpan(line: number, column = 0): SourceSpan {
  return { startLine: line, startColumn: column, endLine: line, endColumn: column };
}

/**
 * Compute the end position of a regex match given (a) the start line/column
 * inside the source and (b) the matched text. Walks the matched text counting
 * newlines so multi-line matches report their true extent.
 */
export function spanFromMatch(
  startLine: number,
  startColumn: number,
  matchText: string
): SourceSpan {
  let endLine = startLine;
  let endColumn = startColumn + matchText.length;
  const newlineCount = (matchText.match(/\n/g) ?? []).length;
  if (newlineCount > 0) {
    endLine = startLine + newlineCount;
    const lastNewline = matchText.lastIndexOf("\n");
    endColumn = matchText.length - lastNewline - 1;
  }
  return { startLine, startColumn, endLine, endColumn };
}
