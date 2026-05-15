/**
 * Import resolver for JavaScript and TypeScript source files.
 *
 * Walks a Tree-sitter AST and builds a map from variable names to npm package
 * names.  Handles ESM import, CommonJS require, constructor assignments, barrel
 * file re-exports (one level), and TypeScript typed function parameters.
 */
import * as path from "path";
import type { SyntaxNode, Tree } from "./parser-loader";

// ── Public types ──────────────────────────────────────────────────────────────

export interface ResolvedImports {
  /**
   * Top-level variable (or imported name) → npm package (or resolved file path
   * for non-npm imports).
   *
   * @example
   * // import OpenAI from "openai"
   * // const client = new OpenAI()
   * importMap.get("OpenAI")  // → "openai"
   * importMap.get("client")  // → "openai"
   */
  importMap: Map<string, string>;

  /**
   * Function/method name → (parameter name → resolved package name).
   * Populated only for TypeScript files with type-annotated parameters whose
   * type name maps to a known provider client class.
   *
   * @example
   * // function helper(client: OpenAI) { ... }
   * parameterMaps.get("helper")?.get("client")  // → "openai"
   */
  parameterMaps: Map<string, Map<string, string>>;
}

/** Callback for reading file content during barrel-file resolution. */
export type FileReader = (absolutePath: string) => Promise<string | null>;

// ── Known client class names → package ───────────────────────────────────────

/**
 * Maps well-known SDK class/constructor names to their npm packages.
 * Derived from the fingerprint registry's supported providers.
 */
export const CLASS_TO_PACKAGE: Record<string, string> = {
  // OpenAI
  OpenAI: "openai",
  AzureOpenAI: "openai",
  // Anthropic
  Anthropic: "@anthropic-ai/sdk",
  AnthropicBedrock: "@anthropic-ai/sdk",
  AnthropicVertex: "@anthropic-ai/sdk",
  // Stripe
  Stripe: "stripe",
  // Supabase
  SupabaseClient: "@supabase/supabase-js",
  createClient: "@supabase/supabase-js", // factory function, not constructor
  // Firebase
  FirebaseApp: "firebase",
  // AWS Bedrock
  BedrockRuntimeClient: "@aws-sdk/client-bedrock-runtime",
  // Google Gemini / Vertex
  GoogleGenerativeAI: "@google/generative-ai",
  VertexAI: "@google-cloud/vertexai",
  // Cohere
  CohereClient: "cohere-ai",
  Cohere: "cohere-ai",
  // Mistral
  Mistral: "@mistralai/mistralai",
  MistralClient: "@mistralai/mistralai",
};

// ── Path utilities ────────────────────────────────────────────────────────────

/** Normalize a filesystem path to forward slashes (consistent on all platforms). */
function normalizePath(p: string): string {
  return p.replace(/\\/g, "/");
}

/**
 * Join a base directory with a relative path, preserving the original path
 * style (forward-slash paths on Unix/tests stay as forward-slash paths even
 * on Windows where `path.resolve` would add a drive letter).
 */
function joinPath(baseDir: string, relPath: string): string {
  // If baseDir is a POSIX-style absolute path (starts with /), use posix join.
  if (baseDir.startsWith("/")) {
    return path.posix.resolve(baseDir, relPath);
  }
  return normalizePath(path.resolve(baseDir, relPath));
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Extract the inner string value from a `string` AST node. */
function stringValue(node: SyntaxNode): string {
  // string node text includes quotes; strip them
  return node.text.replace(/^['"`]|['"`]$/g, "");
}

/** Find the first child of `node` with the given type. */
function childOfType(node: SyntaxNode, type: string): SyntaxNode | null {
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (c && c.type === type) return c;
  }
  return null;
}

// ── ESM import handling ───────────────────────────────────────────────────────

function processImportStatement(node: SyntaxNode, importMap: Map<string, string>): void {
  // The `from "..."` string is the last string child
  const source = childOfType(node, "string");
  if (!source) return;
  const pkg = stringValue(source);

  const clause = childOfType(node, "import_clause");
  if (!clause) return;

  for (let i = 0; i < clause.childCount; i++) {
    const child = clause.child(i);
    if (!child) continue;

    switch (child.type) {
      case "identifier": {
        // import openai from "openai"  → default import, local name = child.text
        importMap.set(child.text, pkg);
        break;
      }
      case "named_imports": {
        // import { OpenAI }        from "openai"
        // import { OpenAI as AI } from "openai"
        for (let j = 0; j < child.childCount; j++) {
          const spec = child.child(j);
          if (!spec || spec.type !== "import_specifier") continue;

          const identifiers: string[] = [];
          for (let k = 0; k < spec.childCount; k++) {
            const s = spec.child(k);
            if (s && s.type === "identifier") identifiers.push(s.text);
          }
          // identifiers[0] is the original name; identifiers[1] is the alias (if any)
          const localName = identifiers[identifiers.length - 1];
          if (localName) importMap.set(localName, pkg);
        }
        break;
      }
      case "namespace_import": {
        // import * as stripe from "stripe"  → the identifier after 'as'
        const ident = childOfType(child, "identifier");
        if (ident) importMap.set(ident.text, pkg);
        break;
      }
    }
  }
}

// ── CJS require handling ──────────────────────────────────────────────────────

/** Return the string argument of a `require(...)` call, or null. */
function requireSource(callNode: SyntaxNode): string | null {
  if (callNode.type !== "call_expression") return null;
  const fn = callNode.child(0);
  if (!fn || fn.text !== "require") return null;
  const args = childOfType(callNode, "arguments");
  if (!args) return null;
  const strNode = childOfType(args, "string");
  return strNode ? stringValue(strNode) : null;
}

function processVariableDeclarator(node: SyntaxNode, importMap: Map<string, string>): void {
  // node is a `variable_declarator`
  if (node.childCount < 3) return;
  const lhs = node.child(0);
  const rhs = node.child(2); // skip `=` at index 1
  if (!lhs || !rhs) return;

  // ── const x = require("pkg") ─────────────────────────────────────────────
  if (rhs.type === "call_expression") {
    const pkg = requireSource(rhs);
    if (pkg !== null) {
      if (lhs.type === "identifier") {
        // const openai = require("openai")
        importMap.set(lhs.text, pkg);
      } else if (lhs.type === "object_pattern") {
        // const { OpenAI } = require("openai")
        // const { OpenAI: OpenAIAlias } = require("openai")
        for (let i = 0; i < lhs.childCount; i++) {
          const member = lhs.child(i);
          if (!member) continue;
          if (member.type === "shorthand_property_identifier_pattern" || member.type === "identifier") {
            importMap.set(member.text, pkg);
          } else if (member.type === "pair_pattern") {
            // { original: alias } — the alias is the local name
            const valueIdent = member.child(2); // skip ':' at index 1
            if (valueIdent && valueIdent.type === "identifier") {
              importMap.set(valueIdent.text, pkg);
            }
          }
        }
      }
      return;
    }

    // ── const client = new OpenAI() ────────────────────────────────────────
    // handled in processNewExpression; skip here
  }

  if (rhs.type === "new_expression") {
    processNewExpression(lhs, rhs, importMap);
  }
}

function processNewExpression(
  lhs: SyntaxNode,
  newExpr: SyntaxNode,
  importMap: Map<string, string>
): void {
  if (lhs.type !== "identifier") return;
  const constructor = newExpr.child(1); // 'new' at index 0, constructor at index 1
  if (!constructor) return;
  const ctorName = constructor.text;

  // Resolve via CLASS_TO_PACKAGE or via the import map (if class was imported)
  const pkg = CLASS_TO_PACKAGE[ctorName] ?? importMap.get(ctorName);
  if (pkg) {
    importMap.set(lhs.text, pkg);
  }
}

// ── TypeScript typed parameter handling ───────────────────────────────────────

function processFunctionParams(
  fnNode: SyntaxNode,
  importMap: Map<string, string>,
  parameterMaps: Map<string, Map<string, string>>
): void {
  // Works for function_declaration, method_definition, arrow_function, etc.
  const nameNode = childOfType(fnNode, "identifier");
  const fnName = nameNode?.text ?? "<anonymous>";

  const params = childOfType(fnNode, "formal_parameters");
  if (!params) return;

  const paramMap = new Map<string, string>();

  for (let i = 0; i < params.childCount; i++) {
    const param = params.child(i);
    if (!param) continue;
    if (param.type !== "required_parameter" && param.type !== "optional_parameter") continue;

    const nameNode = param.child(0);
    const typeAnnotation = childOfType(param, "type_annotation");
    if (!nameNode || !typeAnnotation) continue;

    // type_annotation is `: TypeName` — the type identifier is the second child
    // (index 0 = ':')
    const typeIdent = typeAnnotation.child(1);
    if (!typeIdent) continue;

    const typeName = typeIdent.text;
    const pkg = CLASS_TO_PACKAGE[typeName] ?? importMap.get(typeName);
    if (pkg) {
      paramMap.set(nameNode.text, pkg);
    }
  }

  if (paramMap.size > 0) {
    parameterMaps.set(fnName, paramMap);
  }
}

// ── Barrel file / re-export handling ─────────────────────────────────────────

interface ExportEntry {
  /** Exported name (or null for `export *`) — the name that consumers import */
  exportedName: string | null;
  /** Original name in the source file (differs from exportedName when aliased) */
  originalName?: string;
  /** Relative source path (the `from "..."` string) */
  sourcePath: string;
}

function collectExports(tree: Tree): ExportEntry[] {
  const entries: ExportEntry[] = [];
  for (let i = 0; i < tree.rootNode.childCount; i++) {
    const stmt = tree.rootNode.child(i);
    if (!stmt || stmt.type !== "export_statement") continue;

    const source = childOfType(stmt, "string");
    if (!source) continue; // export without `from` — not a re-export
    const sourcePath = stringValue(source);
    if (!sourcePath.startsWith(".")) continue; // skip non-relative (npm re-exports)

    const exportClause = childOfType(stmt, "export_clause");
    if (exportClause) {
      // export { foo, bar as baz } from "./lib"
      for (let j = 0; j < exportClause.childCount; j++) {
        const spec = exportClause.child(j);
        if (!spec || spec.type !== "export_specifier") continue;
        // Tree-sitter export_specifier fields:
        //   name: the original identifier (what the source file calls it)
        //   alias: the exported name (what consumers import), present only if `as Y` is used
        const nameNode = spec.childForFieldName("name") ?? spec.child(0);
        const aliasNode = spec.childForFieldName("alias");
        const originalName = nameNode?.text;
        const exportedName = aliasNode?.text ?? originalName;
        if (exportedName) {
          entries.push({ exportedName, originalName, sourcePath });
        }
      }
    } else {
      // export * from "./providers"
      entries.push({ exportedName: null, sourcePath });
    }
  }
  return entries;
}

/**
 * Try to resolve a relative import `from "./barrel"` to an actual package name
 * by reading the barrel file and inspecting what it re-exports.
 *
 * Only follows ONE level of re-exports (A → B → stop).
 */
async function resolveBarrelImport(
  importedNames: string[],
  sourceRelPath: string,
  currentFilePath: string,
  readFile: FileReader,
  parseTreeFn: (src: string) => Promise<Tree | null>
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const dir = path.posix.dirname(normalizePath(currentFilePath));
  const barrelPath = joinPath(dir, sourceRelPath);

  // Try common extensions if no extension provided
  const candidates = barrelPath.endsWith(".ts") || barrelPath.endsWith(".js")
    ? [barrelPath]
    : [barrelPath + ".ts", barrelPath + ".js", barrelPath + "/index.ts", barrelPath + "/index.js"];

  let barrelContent: string | null = null;
  let resolvedBarrelPath = barrelPath;
  for (const candidate of candidates) {
    barrelContent = await readFile(candidate);
    if (barrelContent !== null) {
      resolvedBarrelPath = candidate;
      break;
    }
  }
  if (barrelContent === null) return result;

  const barrelTree = await parseTreeFn(barrelContent);
  if (!barrelTree) return result;

  const barrelExports = collectExports(barrelTree);

  for (const name of importedNames) {
    // Find a matching export in the barrel.
    // A barrel may have multiple entries that could match — e.g. a wildcard
    // (`export * from "./a"`) followed by a named re-export
    // (`export { ask } from "./b"`).  We must keep iterating if the current
    // entry doesn't actually provide the name we need.
    for (const entry of barrelExports) {
      if (entry.exportedName !== name && entry.exportedName !== null) continue;

      // This barrel re-exports `name` from `entry.sourcePath` — resolve it
      if (!entry.sourcePath.startsWith(".")) {
        // Re-exported from an npm package — this IS the package
        result.set(name, entry.sourcePath);
      } else {
        // One more level: read the source file and look for the actual export
        const srcDir = path.posix.dirname(resolvedBarrelPath);
        const srcPath = joinPath(srcDir, entry.sourcePath);
        const srcCandidates = srcPath.endsWith(".ts") || srcPath.endsWith(".js")
          ? [srcPath]
          : [srcPath + ".ts", srcPath + ".js"];

        for (const candidate of srcCandidates) {
          const content = await readFile(candidate);
          if (content === null) continue;
          const tree = await parseTreeFn(content);
          if (!tree) continue;

          // Look for the npm package this file imports `name` from.
          // When the barrel used an alias (`export { _internalAsk as ask }`),
          // the source file knows the function by its originalName, not the
          // consumer-visible alias — so prefer originalName for the lookup.
          const lookupName = entry.originalName ?? name;
          const { importMap: fileImports } = await resolveImportsCore(tree, candidate, undefined, parseTreeFn);
          const pkg = fileImports.get(lookupName) ?? (lookupName !== name ? fileImports.get(name) : undefined);
          if (pkg) {
            result.set(name, pkg);
            break;
          }
        }
      }

      // Only stop searching barrel entries once the lookup actually succeeded.
      // If a wildcard entry didn't provide the name (source file didn't export
      // it), continue to the next barrel entry which may be a named re-export.
      if (result.has(name)) break;
    }
  }

  return result;
}

// ── Python import handling ────────────────────────────────────────────────────

/**
 * Python `import_statement`: `import openai` or `import openai as ai`.
 *
 * AST structure:
 *   import openai     → (import_statement name: (dotted_name (identifier "openai")))
 *   import openai as ai → (import_statement name: (aliased_import name: (dotted_name) alias: (identifier "ai")))
 */
function processPythonImportStatement(node: SyntaxNode, importMap: Map<string, string>): void {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child) continue;

    if (child.type === "dotted_name") {
      // `import openai` — package and local name are the first segment
      const pkg = child.text;
      const localName = child.namedChild(0)?.text ?? pkg;
      importMap.set(localName, pkg);
    } else if (child.type === "aliased_import") {
      // `import openai as ai` — local name is the alias
      const nameNode = childOfType(child, "dotted_name");
      const aliasNode = childOfType(child, "identifier");
      if (!nameNode || !aliasNode) continue;
      importMap.set(aliasNode.text, nameNode.text);
    }
  }
}

/**
 * Python `import_from_statement`: `from openai import OpenAI` or with alias.
 *
 * AST structure (single import):
 *   (import_from_statement
 *     module_name: (dotted_name (identifier "openai"))
 *     name: (dotted_name (identifier "OpenAI")))
 *
 * With alias:
 *   (import_from_statement ... name: (aliased_import name: ... alias: (identifier "AI")))
 */
function processPythonImportFromStatement(node: SyntaxNode, importMap: Map<string, string>): void {
  // First dotted_name child is the module (the "from" part)
  let moduleName: string | null = null;

  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child) continue;

    if (child.type === "dotted_name" && moduleName === null) {
      // Module name: take only the top-level package (first segment)
      moduleName = child.namedChild(0)?.text ?? child.text;
    } else if (child.type === "dotted_name") {
      // Imported name (no alias) — last segment is the local name
      const lastName = child.namedChild(child.namedChildCount - 1)?.text;
      if (lastName && moduleName) importMap.set(lastName, moduleName);
    } else if (child.type === "aliased_import") {
      // `OpenAI as AI` — alias is the local name
      const alias = childOfType(child, "identifier");
      if (alias && moduleName) importMap.set(alias.text, moduleName);
    } else if (child.type === "import_list" || child.type === "wildcard_import") {
      // `from openai import OpenAI, Embedding` or `from openai import *`
      if (child.type === "wildcard_import") continue; // skip *
      for (let j = 0; j < child.namedChildCount; j++) {
        const item = child.namedChild(j);
        if (!item) continue;
        if (item.type === "dotted_name") {
          const lastName = item.namedChild(item.namedChildCount - 1)?.text;
          if (lastName && moduleName) importMap.set(lastName, moduleName);
        } else if (item.type === "aliased_import") {
          const alias = childOfType(item, "identifier");
          if (alias && moduleName) importMap.set(alias.text, moduleName);
        }
      }
    }
  }
}

/**
 * Python constructor assignment: `client = OpenAI()` or `client = anthropic.Anthropic()`.
 *
 * AST structure (inside expression_statement):
 *   (assignment
 *     left: (identifier "client")
 *     right: (call function: (identifier "OpenAI") | (attribute ...)))
 */
function processPythonAssignment(node: SyntaxNode, importMap: Map<string, string>): void {
  // node is `assignment`
  // lhs: first named child that is an identifier
  const lhs = childOfType(node, "identifier");
  if (!lhs) return;

  // rhs: last named child
  const rhs = node.namedChildCount >= 2 ? node.namedChild(node.namedChildCount - 1) : null;
  if (!rhs || rhs.type !== "call") return;

  const fn = rhs.child(0);
  if (!fn) return;

  let pkg: string | undefined;

  if (fn.type === "identifier") {
    // client = OpenAI()
    const ctorName = fn.text;
    pkg = CLASS_TO_PACKAGE[ctorName] ?? importMap.get(ctorName);
  } else if (fn.type === "attribute") {
    // client = anthropic.Anthropic()
    const pkgPrefix = fn.child(0)?.text;
    const ctorName = fn.child(2)?.text;
    if (ctorName) pkg = CLASS_TO_PACKAGE[ctorName] ?? importMap.get(ctorName);
    if (!pkg && pkgPrefix) pkg = importMap.get(pkgPrefix) ?? pkgPrefix;
  }

  if (pkg) {
    importMap.set(lhs.text, pkg);
  }
}

// ── Core resolution logic ─────────────────────────────────────────────────────

async function resolveImportsCore(
  tree: Tree,
  filePath: string,
  readFile: FileReader | undefined,
  parseTreeFn: (src: string) => Promise<Tree | null>
): Promise<ResolvedImports> {
  const importMap = new Map<string, string>();
  const parameterMaps = new Map<string, Map<string, string>>();

  // Collect relative imports to potentially resolve via barrel files
  const relativeImports = new Map<string, string[]>(); // relative path → local names

  for (let i = 0; i < tree.rootNode.childCount; i++) {
    const stmt = tree.rootNode.child(i);
    if (!stmt) continue;

    switch (stmt.type) {
      case "import_statement": {
        const source = childOfType(stmt, "string");
        if (!source) {
          // No string child → Python `import openai` / `import openai as ai`
          processPythonImportStatement(stmt, importMap);
          break;
        }
        // JS/TS ESM import: `import X from "pkg"`
        const pkg = stringValue(source);

        if (!pkg.startsWith(".")) {
          // npm import — resolve directly
          processImportStatement(stmt, importMap);
        } else {
          // Relative import — always record the imported names in importMap (with
          // the relative path as the value) so callers can test `importMap.has(name)`.
          // If readFile is provided, also attempt barrel-file package resolution.
          const clause = childOfType(stmt, "import_clause");
          if (!clause) break;
          const names: string[] = [];
          for (let j = 0; j < clause.childCount; j++) {
            const child = clause.child(j);
            if (!child) continue;
            if (child.type === "identifier") {
              names.push(child.text);
              importMap.set(child.text, pkg);
            } else if (child.type === "named_imports") {
              for (let k = 0; k < child.childCount; k++) {
                const spec = child.child(k);
                if (!spec || spec.type !== "import_specifier") continue;
                const idents: string[] = [];
                for (let m = 0; m < spec.childCount; m++) {
                  const s = spec.child(m);
                  if (s && s.type === "identifier") idents.push(s.text);
                }
                const local = idents[idents.length - 1];
                if (local) {
                  names.push(local);
                  importMap.set(local, pkg);
                }
              }
            }
          }
          if (readFile && names.length > 0) {
            const existing = relativeImports.get(pkg) ?? [];
            relativeImports.set(pkg, [...existing, ...names]);
          }
        }
        break;
      }

      case "import_from_statement": {
        // Python only: `from openai import OpenAI`
        processPythonImportFromStatement(stmt, importMap);
        break;
      }

      case "expression_statement": {
        // Python only: top-level `client = OpenAI()` (no let/const in Python)
        const assign = childOfType(stmt, "assignment");
        if (assign) processPythonAssignment(assign, importMap);
        break;
      }

      case "lexical_declaration":
      case "variable_declaration": {
        // Walk all variable_declarator children
        for (let j = 0; j < stmt.childCount; j++) {
          const child = stmt.child(j);
          if (child && child.type === "variable_declarator") {
            processVariableDeclarator(child, importMap);
          }
        }
        break;
      }

      case "function_declaration": {
        processFunctionParams(stmt, importMap, parameterMaps);
        break;
      }

      case "export_statement": {
        // `export const x = new Sdk()` / `export function f() {}` / `export class C {}`
        // Unwrap the inner declaration and re-process it.
        for (let j = 0; j < stmt.namedChildCount; j++) {
          const inner = stmt.namedChild(j);
          if (!inner) continue;
          if (inner.type === "lexical_declaration" || inner.type === "variable_declaration") {
            for (let k = 0; k < inner.childCount; k++) {
              const child = inner.child(k);
              if (child && child.type === "variable_declarator") {
                processVariableDeclarator(child, importMap);
              }
            }
          } else if (inner.type === "function_declaration") {
            processFunctionParams(inner, importMap, parameterMaps);
          }
        }
        break;
      }
    }
  }

  // Also do a second pass for new_expression assignments that appear after the
  // class was imported (so importMap is populated by the time we resolve them).
  // The first pass already handles new_expression, but only for items seen in
  // order. Re-run to catch cases where the constructor name is resolved via
  // CLASS_TO_PACKAGE (which doesn't need prior import state).

  // Resolve barrel file imports
  if (readFile && relativeImports.size > 0) {
    for (const [relPath, names] of relativeImports) {
      const resolved = await resolveBarrelImport(names, relPath, filePath, readFile, parseTreeFn);
      for (const [name, pkg] of resolved) {
        importMap.set(name, pkg);
      }
    }
  }

  return { importMap, parameterMaps };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Resolve all variable-to-package mappings in a parsed TypeScript/JavaScript
 * file.
 *
 * @param tree      Parsed Tree-sitter tree for the file.
 * @param filePath  Absolute path to the file (used for barrel resolution).
 * @param readFile  Optional async file reader.  When omitted, barrel file
 *                  resolution is skipped.
 *
 * @returns `importMap` (variable → package) and `parameterMaps`
 *          (function → param → package for TS typed parameters).
 */
export async function resolveImports(
  tree: Tree,
  filePath: string,
  readFile?: FileReader
): Promise<ResolvedImports> {
  // We need a parse function for barrel file resolution.
  // Lazy-load the parser to avoid a circular dependency at module load time.
  const parseTreeFn = async (src: string): Promise<Tree | null> => {
    const ext = path.extname(filePath);
    const { parseFile, getLanguageForExtension } = await import("./parser-loader");
    const lang = getLanguageForExtension(ext) ?? "javascript";
    return parseFile(src, lang);
  };

  return resolveImportsCore(tree, filePath, readFile, parseTreeFn);
}
