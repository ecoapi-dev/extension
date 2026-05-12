/**
 * AST call expression visitor.
 *
 * Walks a Tree-sitter syntax tree and returns every function/method call
 * expression found in executable code (comments and string literals are
 * excluded by the parser itself, so no extra filtering is needed here).
 */
import type { Tree, SyntaxNode } from "./parser-loader";
import type { SourceSpan } from "../scanner/source-span";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CallInfo {
  /** Full dot-separated chain, e.g. "openai.chat.completions.create" */
  methodChain: string;
  /** Leftmost segment of the chain, e.g. "openai" */
  rootIdentifier: string;
  /** Raw argument AST nodes (caller can inspect for URL strings, etc.) */
  args: SyntaxNode[];
  /** 1-based line number of the call start (kept for back-compat). */
  line: number;
  /** 0-based column of the call start (kept for back-compat). */
  column: number;
  /** Full source span of the entire call expression. */
  span: SourceSpan;
  /** The call_expression AST node — used by callers for ancestor traversal. */
  node: SyntaxNode;
}

// ── Chain extraction ──────────────────────────────────────────────────────────

/**
 * Flatten a `member_expression` (or plain `identifier`) node into an ordered
 * list of identifier segments.
 *
 * Returns `null` when the chain contains a computed (subscript) segment that
 * can't be statically determined, unless the chain has a static suffix that
 * makes it analyzable.
 *
 * Optional-chaining (`?.`) is normalised to a regular dot.
 */
function flattenMemberExpression(node: SyntaxNode): string[] | null {
  if (node.type === "identifier" || node.type === "property_identifier") {
    return [node.text];
  }

  // `this` keyword — treated as a special root identifier
  if (node.type === "this") {
    return ["this"];
  }

  // TypeScript generic calls: create<T>() make the parser put an
  // await_expression (or the plain expression) as child[0] of call_expression.
  if (node.type === "await_expression") {
    const inner = node.namedChild(0);
    return inner ? flattenMemberExpression(inner) : null;
  }

  if (node.type === "member_expression" || node.type === "attribute") {
    const object = node.child(0); // left side
    const property = node.child(2); // property_identifier / identifier (child 1 is . or ?.)

    if (!object || !property) return null;

    // Computed access (obj[expr]) — skip this part of the chain but still
    // capture the property suffix so e.g. `items[0].create()` yields ["create"]
    if (
      object.type === "subscript_expression" ||
      object.type === "call_expression" ||
      object.type === "subscript" ||  // Python computed access obj[expr]
      object.type === "call"          // Python call result access call()[prop]
    ) {
      // We can't resolve the object, so the root is unknown.
      // Return only the property so callers get a partial chain.
      return [property.text];
    }

    const leftParts = flattenMemberExpression(object);
    if (!leftParts) return [property.text]; // best-effort partial chain

    return [...leftParts, property.text];
  }

  // Anything else (template literals, binary expressions, etc.) — not static
  return null;
}

// ── Call node visitor ─────────────────────────────────────────────────────────

function collectCalls(node: SyntaxNode, results: CallInfo[]): void {
  if (node.type === "call_expression" || node.type === "call") {
    const fn = node.child(0); // function expression
    // JS/TS: child(1) is `arguments`; Python: child(1) is `argument_list` — same layout
    const argsNode = node.child(1);

    if (fn) {
      const segments = flattenMemberExpression(fn);
      if (segments && segments.length > 0) {
        const args: SyntaxNode[] = [];
        if (argsNode) {
          // arguments node wraps individual argument nodes; skip the punctuation
          for (let i = 0; i < argsNode.namedChildCount; i++) {
            const arg = argsNode.namedChild(i);
            if (arg) args.push(arg);
          }
        }

        results.push({
          methodChain: segments.join("."),
          rootIdentifier: segments[0],
          args,
          line: node.startPosition.row + 1,
          column: node.startPosition.column,
          span: {
            startLine: node.startPosition.row + 1,
            startColumn: node.startPosition.column,
            endLine: node.endPosition.row + 1,
            endColumn: node.endPosition.column,
          },
          node,
        });
      }
    }

    // Still recurse into arguments — calls can be nested
  }

  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child) collectCalls(child, results);
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Extract all call expressions from a parsed Tree-sitter tree.
 *
 * Handles:
 * - Simple calls: `fetch("url")`
 * - Member chains: `openai.chat.completions.create(...)`
 * - Awaited calls: `await client.messages.create(...)` (await is transparent)
 * - Optional chaining: `openai?.chat?.completions?.create()` → normalised to dots
 * - Deeply nested chains: `a.b.c.d.e.f()`
 * - Computed properties: chain is truncated at the computed segment
 *
 * Comments and string literals in source are excluded by the parser itself.
 */
export function extractCalls(tree: Tree): CallInfo[] {
  const results: CallInfo[] = [];
  collectCalls(tree.rootNode, results);
  return results;
}
