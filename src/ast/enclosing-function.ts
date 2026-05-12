import type { SyntaxNode } from "./parser-loader";

/**
 * Walk up the AST from `node` to find the nearest enclosing function name.
 * Returns null for top-level calls.
 *
 * Recognized constructs:
 * - JS/TS `function foo() { ... }`           (function_declaration)
 * - JS/TS class methods `class C { foo() {} }` (method_definition)
 * - JS/TS `const foo = () => { ... }`        (arrow_function under variable_declarator)
 * - JS/TS `const foo = function() { ... }`   (function_expression under variable_declarator)
 * - Python `def foo(): ...`                  (function_definition)
 */
export function enclosingFunctionName(node: SyntaxNode): string | null {
  let current: SyntaxNode | null = node.parent;
  while (current) {
    // Function declarations / Python defs / methods — name is a child identifier.
    if (
      current.type === "function_declaration" ||
      current.type === "function_definition" ||
      current.type === "method_definition"
    ) {
      for (let i = 0; i < current.childCount; i++) {
        const c = current.child(i);
        if (c?.type === "identifier" || c?.type === "property_identifier") {
          return c.text;
        }
      }
      return null;
    }

    // Arrow functions or function expressions — look at the binding name on the
    // surrounding variable_declarator.
    if (current.type === "arrow_function" || current.type === "function_expression") {
      const decl = current.parent;
      if (decl?.type === "variable_declarator") {
        const lhs = decl.child(0);
        if (lhs?.type === "identifier") return lhs.text;
      }
      return null;
    }

    current = current.parent;
  }
  return null;
}
