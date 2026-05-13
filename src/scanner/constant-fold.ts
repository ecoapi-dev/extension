/**
 * Resolve a same-file string template-literal, quoted string, or bare
 * identifier expression to its concrete string value, given the full file
 * source.
 *
 * Scope (v1, issue #74):
 *  - `const X = "literal"` (also `let X = "literal"`, `var X = "literal"`)
 *    at module level
 *  - Template literals with only static + same-file const interpolations
 *  - Bare identifier references to such consts
 *  - Plain quoted strings pass through with quotes stripped
 *
 * Returns null when:
 *  - The expression depends on runtime values (function calls, member access)
 *  - A referenced identifier has multiple conflicting definitions in the file
 *  - A referenced identifier is not a string-literal binding
 */

const STRING_BINDING_RE =
  /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::\s*[^=]+)?=\s*(['"`])([^\r\n'"`]*?)\2\s*;?\s*$/gm;

function buildConstMap(fileSource: string): Map<string, string> {
  const seen = new Map<string, string>();
  const ambiguous = new Set<string>();
  STRING_BINDING_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = STRING_BINDING_RE.exec(fileSource)) !== null) {
    const name = m[1];
    const value = m[3];
    if (seen.has(name) && seen.get(name) !== value) {
      ambiguous.add(name);
    } else if (!seen.has(name)) {
      seen.set(name, value);
    }
  }
  for (const name of ambiguous) seen.delete(name);
  return seen;
}

export function foldStringConstants(expression: string, fileSource: string): string | null {
  const trimmed = expression.trim();

  // Plain quoted string literal (single/double-quoted) — strip quotes
  if (/^["']([^"'\n]*)["']$/.test(trimmed)) {
    return trimmed.slice(1, -1);
  }

  // Backtick template with no interpolations — strip backticks
  if (
    trimmed.startsWith("`") &&
    trimmed.endsWith("`") &&
    !trimmed.includes("${")
  ) {
    return trimmed.slice(1, -1);
  }

  const consts = buildConstMap(fileSource);

  // Bare identifier (e.g. fetch(URL))
  if (/^[A-Za-z_$][\w$]*$/.test(trimmed)) {
    return consts.get(trimmed) ?? null;
  }

  // Template literal — fold each ${...} segment
  if (trimmed.startsWith("`") && trimmed.endsWith("`")) {
    const inner = trimmed.slice(1, -1);
    const parts: string[] = [];
    let i = 0;
    while (i < inner.length) {
      if (inner[i] === "$" && inner[i + 1] === "{") {
        const end = inner.indexOf("}", i + 2);
        if (end === -1) return null;
        const exprInside = inner.slice(i + 2, end).trim();
        if (!/^[A-Za-z_$][\w$]*$/.test(exprInside)) return null; // not a bare identifier
        const value = consts.get(exprInside);
        if (value === undefined) return null;
        parts.push(value);
        i = end + 1;
      } else {
        const nextDollar = inner.indexOf("${", i);
        const segEnd = nextDollar === -1 ? inner.length : nextDollar;
        parts.push(inner.slice(i, segEnd));
        i = segEnd;
      }
    }
    return parts.join("");
  }

  return null;
}
