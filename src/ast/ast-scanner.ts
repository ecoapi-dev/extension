/**
 * ast/ast-scanner.ts — AST-based API call scanner.
 *
 * Wires together parser-loader, call-visitor, import-resolver, and the
 * fingerprint registry to detect API calls with structural accuracy.
 *
 * Detects:
 *  1. Direct SDK calls via import map
 *  2. Aliased / constructor-assigned clients  (const ai = new OpenAI())
 *  3. `this.field` calls inside class methods
 *  4. Class method wrappers           (instance.method() ← wraps API call)
 *  5. Callback / function-ref patterns (forEach(fn), Promise.all(arr.map(fn)))
 *  6. TypeScript typed function params  (function f(client: OpenAI))
 *  7. Plain fetch / axios HTTP calls   (URL → lookupHost())
 *  8. Express/Koa middleware tagging   (app.use(fn))
 */
import * as path from "path";
import { parseFile, getLanguageForExtension } from "./parser-loader";
import { extractCalls } from "./call-visitor";
import { resolveImports, CLASS_TO_PACKAGE } from "./import-resolver";
import { lookupMethod, lookupHost } from "../scanner/fingerprints/registry";
import { analyzeFrequency, frequencyToLoopContext } from "./frequency-analyzer";
import type { SyntaxNode, Tree } from "./parser-loader";
import type { FileReader } from "./import-resolver";
import type { SourceSpan } from "../scanner/source-span";
import { pointSpan } from "../scanner/source-span";
export type { FrequencyClass } from "./frequency-analyzer";

// ── Public types ──────────────────────────────────────────────────────────────

/** A detected API call with full context information. */
export interface AstCallMatch {
  kind: "sdk" | "http" | "unknown";
  /** Provider ID from the fingerprint registry, e.g. "openai" */
  provider?: string;
  /** npm package name, e.g. "openai", "@anthropic-ai/sdk" */
  packageName?: string;
  /** Full dot-separated call chain (may include root var), e.g. "client.chat.completions.create" */
  methodChain: string;
  confidence: number; // 0.0 to 1.0 — how likely this is a real external API call
  /** HTTP verb from registry, e.g. "POST" */
  method?: string;
  /** Endpoint URL from registry */
  endpoint?: string;
  /** 1-based source line */
  line: number;
  /** 0-based column */
  column: number;
  /** Full source span of the call expression. */
  span: SourceSpan;
  /** Structural frequency classification derived from AST context */
  frequency: import("./frequency-analyzer").FrequencyClass;
  /** Convenience: true when frequency implies repeated execution (loop/parallel/polling) */
  loopContext: boolean;
  streaming?: boolean;
  batchCapable?: boolean;
  cacheCapable?: boolean;
  /** True when emitted from middleware detection (per-request cost) */
  isMiddleware?: boolean;
  /** True when this match was propagated from a callee file via cross-file resolution. */
  crossFile?: boolean;
  /** Absolute path of the file where the API call actually lives (for cross-file matches). */
  sourceFile?: string;
}

/** Per-class metadata collected during scanning (for cross-file use in 3.5). */
export interface ClassInfo {
  /** method name → list of API calls inside that method */
  methods: Map<string, AstCallMatch[]>;
}

export interface AstScanResult {
  matches: AstCallMatch[];
  /** Populated class registries for wrapper detection */
  classRegistry: Map<string, ClassInfo>;
  /** Names of imported functions that were passed to middleware registrations
   *  and need cross-file resolution in Phase 3.5. */
  middlewareQueue: string[];
}

// ── Package → Provider ID mapping ────────────────────────────────────────────

const PACKAGE_TO_PROVIDER: Record<string, string> = {
  openai: "openai",
  anthropic: "anthropic",          // Python SDK: import anthropic
  "@anthropic-ai/sdk": "anthropic",
  "@anthropic-ai/bedrock-sdk": "anthropic",
  "@anthropic-ai/vertex-sdk": "anthropic",
  stripe: "stripe",
  "@supabase/supabase-js": "supabase",
  firebase: "firebase",
  "firebase-admin": "firebase",
  "@aws-sdk/client-bedrock-runtime": "aws-bedrock",
  "@google/generative-ai": "gemini",
  "@google-cloud/vertexai": "vertex-ai",
  "cohere-ai": "cohere",
  cohere: "cohere",
  "@mistralai/mistralai": "mistral",
};

// ── Iteration method names (used in callback/queue detection) ─────────────────

const ITERATION_METHODS = new Set([
  "forEach",
  "map",
  "flatMap",
  "filter",
  "reduce",
  "reduceRight",
  "some",
  "every",
  "find",
  "findIndex",
]);

const QUEUE_WORKER_METHODS = new Set([
  "process",
  "handle",
  "consume",
  "subscribe",
  "on",
]);


// ── Middleware detection ──────────────────────────────────────────────────────

const MIDDLEWARE_HOSTS = new Set(["app", "router", "server"]);

function isMiddlewareCall(chain: string): boolean {
  const [host, method] = chain.split(".");
  return MIDDLEWARE_HOSTS.has(host) && method === "use";
}

// ── URL / host extraction from fetch/axios ────────────────────────────────────

const HTTP_CLIENTS = new Set(["fetch", "axios", "got", "ky", "request", "superagent",
  "requests", "httpx"]); // Python HTTP libraries
const AXIOS_METHODS = new Set(["get", "post", "put", "patch", "delete", "head", "options"]);

/** Extract a URL string literal from argument nodes. */
function extractUrlFromArgs(args: SyntaxNode[]): string | null {
  const first = args[0];
  if (!first) return null;
  if (first.type === "string") return first.text.replace(/^['"`]|['"`]$/g, "");
  if (first.type === "template_string") return null; // dynamic, skip
  return null;
}

/** Extract HTTP method from a fetch-style options object. */
function extractHttpMethodFromOptions(args: SyntaxNode[]): string {
  const opts = args[1];
  if (!opts || opts.type !== "object") return "GET";
  for (let i = 0; i < opts.namedChildCount; i++) {
    const pair = opts.namedChild(i);
    if (!pair || pair.type !== "pair") continue;
    const key = pair.child(0);
    const val = pair.child(2);
    if (key?.text === "method" && val) {
      return val.text.replace(/^['"`]|['"`]$/g, "").toUpperCase();
    }
  }
  return "GET";
}

// ── AST traversal helpers ─────────────────────────────────────────────────────

/** Collect all top-level function names in the file. */
function collectTopLevelFunctions(tree: Tree): Map<string, SyntaxNode> {
  const fns = new Map<string, SyntaxNode>();
  for (let i = 0; i < tree.rootNode.childCount; i++) {
    const node = tree.rootNode.child(i);
    if (!node) continue;
    if (node.type === "function_declaration" || node.type === "function_definition") {
      // Scan all children to find the identifier — position varies for async functions
      // (async function foo() → child 0=async, 1=function, 2=identifier)
      // Python function_definition: `def foo(...)` → identifier is at child 1
      for (let k = 0; k < node.childCount; k++) {
        const c = node.child(k);
        if (c?.type === "identifier") { fns.set(c.text, node); break; }
      }
    }
    if (node.type === "lexical_declaration" || node.type === "variable_declaration") {
      for (let j = 0; j < node.childCount; j++) {
        const decl = node.child(j);
        if (!decl || decl.type !== "variable_declarator") continue;
        const lhs = decl.child(0);
        const rhs = decl.child(2);
        if (lhs?.type === "identifier" && rhs) {
          if (rhs.type === "arrow_function" || rhs.type === "function_expression") {
            fns.set(lhs.text, rhs);
          }
        }
      }
    }
  }
  return fns;
}

/** Collect class declarations from the file root. */
function collectClasses(tree: Tree): Map<string, SyntaxNode> {
  const classes = new Map<string, SyntaxNode>();
  for (let i = 0; i < tree.rootNode.childCount; i++) {
    const node = tree.rootNode.child(i);
    if (!node) continue;
    if (node.type === "class_declaration" || node.type === "class_definition") {
      const name = node.child(1);
      // TypeScript grammar uses "type_identifier" for class names; JS uses "identifier"
      // Python class_definition: `class Foo:` → identifier at child 1
      if (name?.type === "identifier" || name?.type === "type_identifier") classes.set(name.text, node);
    }
    // Handle: const Foo = class { ... }
    if (node.type === "lexical_declaration" || node.type === "variable_declaration") {
      for (let j = 0; j < node.childCount; j++) {
        const decl = node.child(j);
        if (!decl || decl.type !== "variable_declarator") continue;
        const lhs = decl.child(0);
        const rhs = decl.child(2);
        if (lhs?.type === "identifier" && rhs?.type === "class") {
          classes.set(lhs.text, rhs);
        }
      }
    }
  }
  return classes;
}

/** Collect all method_definition nodes from a class body. */
function collectClassMethods(classNode: SyntaxNode): Map<string, SyntaxNode> {
  const methods = new Map<string, SyntaxNode>();
  for (let i = 0; i < classNode.childCount; i++) {
    const body = classNode.child(i);
    if (!body || body.type !== "class_body") continue;
    for (let j = 0; j < body.childCount; j++) {
      const m = body.child(j);
      if (!m || m.type !== "method_definition") continue;
      // skip the async keyword if present; find property_identifier
      for (let k = 0; k < m.childCount; k++) {
        const c = m.child(k);
        if (c?.type === "property_identifier") {
          methods.set(c.text, m);
          break;
        }
      }
    }
    break; // only one class_body per class
  }
  return methods;
}

// ── Core resolution ───────────────────────────────────────────────────────────

/**
 * Build an extended import map that includes:
 * - All imports + constructor assignments from resolveImports
 * - `this.field` → package resolution (from constructor body assignments)
 * - Local class instance tracking (var → class name)
 *
 * Returns:
 * - `varMap`: variableName → packageName
 * - `thisFieldMap`: field name → packageName (for this.field.method())
 * - `instanceMap`: variableName → className
 */
function buildExtendedMaps(
  importMap: Map<string, string>,
  tree: Tree
): {
  varMap: Map<string, string>;
  thisFieldMap: Map<string, string>;
  instanceMap: Map<string, string>;
} {
  const varMap = new Map(importMap);
  const thisFieldMap = new Map<string, string>();
  const instanceMap = new Map<string, string>();

  // Walk top-level for instance assignments and this.field assignments
  for (let i = 0; i < tree.rootNode.childCount; i++) {
    const node = tree.rootNode.child(i);
    if (!node) continue;

    if (node.type === "lexical_declaration" || node.type === "variable_declaration") {
      for (let j = 0; j < node.childCount; j++) {
        const decl = node.child(j);
        if (!decl || decl.type !== "variable_declarator") continue;
        const lhs = decl.child(0);
        const rhs = decl.child(2);
        if (!lhs || !rhs) continue;
        if (lhs.type === "identifier" && rhs.type === "new_expression") {
          const ctor = rhs.child(1);
          if (ctor) instanceMap.set(lhs.text, ctor.text);
        }
      }
    }

    // Python: `client = OpenAI()` at module level is expression_statement → assignment
    if (node.type === "expression_statement") {
      const assign = node.child(0);
      if (!assign || assign.type !== "assignment") continue;
      const lhs = assign.namedChildCount >= 1 ? assign.namedChild(0) : null;
      const rhs = assign.namedChildCount >= 2 ? assign.namedChild(assign.namedChildCount - 1) : null;
      if (!lhs || !rhs || lhs.type !== "identifier") continue;
      if (rhs.type === "call") {
        const fn = rhs.child(0);
        if (fn?.type === "identifier") instanceMap.set(lhs.text, fn.text);
        else if (fn?.type === "attribute") {
          const attrName = fn.child(2)?.text;
          if (attrName) instanceMap.set(lhs.text, attrName);
        }
      }
    }
  }

  // Scan constructor bodies to find this.field = new Pkg() assignments
  const classes = collectClasses(tree);
  for (const [, classNode] of classes) {
    const methods = collectClassMethods(classNode);
    const constructor = methods.get("constructor");
    if (!constructor) continue;
    // Walk constructor body for `this.field = new ClassName()` assignments
    walkNode(constructor, (n) => {
      if (n.type !== "assignment_expression") return;
      const left = n.child(0);
      const right = n.child(2);
      if (!left || !right) return;
      if (left.type === "member_expression" && right.type === "new_expression") {
        const obj = left.child(0);
        const prop = left.child(2);
        if (obj?.type === "this" && prop?.type === "property_identifier") {
          const ctor = right.child(1); // class name
          if (ctor) {
            const pkg = CLASS_TO_PACKAGE[ctor.text] ?? varMap.get(ctor.text);
            if (pkg) thisFieldMap.set(prop.text, pkg);
          }
        }
      }
    });
  }

  return { varMap, thisFieldMap, instanceMap };
}

/** Simple tree walker that invokes `fn` for every node. */
function walkNode(root: SyntaxNode, fn: (node: SyntaxNode) => void): void {
  fn(root);
  for (let i = 0; i < root.childCount; i++) {
    const c = root.child(i);
    if (c) walkNode(c, fn);
  }
}

// ── Provider resolution ───────────────────────────────────────────────────────

function isInternalImport(importPath: string): boolean {
  return (
    importPath.startsWith("./") ||
    importPath.startsWith("../") ||
    importPath.startsWith("@/")
  );
}

function resolveProvider(
  rootIdentifier: string,
  methodChain: string,
  varMap: Map<string, string>,
  thisFieldMap: Map<string, string>,
  parameterMaps: Map<string, Map<string, string>>,
  currentFnName: string | null
): { provider: string; packageName: string; resolvedChain: string } | null {
  let pkg: string | undefined;
  let resolvedChain = methodChain;

  if (rootIdentifier === "this") {
    // this.field.method → look up field in thisFieldMap
    const parts = methodChain.split(".");
    if (parts.length < 2) return null;
    const field = parts[1]; // "this", field, method, ...
    pkg = thisFieldMap.get(field);
    // resolvedChain strips "this.field." → "method...."
    resolvedChain = parts.slice(2).join(".");
    if (!resolvedChain) return null;
  } else {
    pkg = varMap.get(rootIdentifier);

    if (!pkg && currentFnName) {
      // Try typed function parameter map
      const paramMap = parameterMaps.get(currentFnName);
      pkg = paramMap?.get(rootIdentifier);
    }
    // Strip root from chain: "client.chat.completions.create" → "chat.completions.create"
    const dot = methodChain.indexOf(".");
    resolvedChain = dot !== -1 ? methodChain.slice(dot + 1) : "";
    if (!resolvedChain) return null;
  }

  if (!pkg) return null;
  if (isInternalImport(pkg)) return null;
  const provider = PACKAGE_TO_PROVIDER[pkg] ?? pkg;
  return { provider, packageName: pkg, resolvedChain };
}

// ── Function context tracking ─────────────────────────────────────────────────

/** Walk up the AST from a node to find the enclosing function name (if any). */
function enclosingFunctionName(node: SyntaxNode): string | null {
  let current: SyntaxNode | null = node.parent;
  while (current) {
    if (current.type === "function_declaration" ||
        current.type === "method_definition" ||
        current.type === "function_definition") {
      for (let i = 0; i < current.childCount; i++) {
        const c = current.child(i);
        if (c?.type === "identifier" || c?.type === "property_identifier") {
          return c.text;
        }
      }
    }
    current = current.parent;
  }
  return null;
}

// ── Main scanner ──────────────────────────────────────────────────────────────

/**
 * Scan a source string for API calls using Tree-sitter AST analysis.
 *
 * @param source     Source code text.
 * @param language   Grammar name: "javascript" or "typescript".
 * @param filePath   Absolute path to the file (used for barrel resolution).
 * @param readFileFn Optional file reader for barrel file resolution.
 */
export async function scanSourceWithAst(
  source: string,
  language: string,
  filePath: string,
  readFileFn?: FileReader
): Promise<AstScanResult> {
  const matches: AstCallMatch[] = [];
  const classRegistry = new Map<string, ClassInfo>();
  const middlewareQueue: string[] = [];

  // ── 1. Parse ────────────────────────────────────────────────────────────────
  const tree = await parseFile(source, language);
  if (!tree) return { matches, classRegistry, middlewareQueue };

  // ── 2. Resolve imports ──────────────────────────────────────────────────────
  const { importMap, parameterMaps } = await resolveImports(tree, filePath, readFileFn);

  // ── 3. Build extended maps (this.field, instance→class, etc.) ───────────────
  const { varMap, thisFieldMap, instanceMap } = buildExtendedMaps(importMap, tree);

  // ── 4. Collect all call expressions ─────────────────────────────────────────
  const allCalls = extractCalls(tree);

  // ── 5. Build function call map (for callback detection) ─────────────────────
  // Maps function name → API calls that function makes (populated below)
  const fnApiCalls = new Map<string, AstCallMatch[]>();
  const topLevelFunctions = collectTopLevelFunctions(tree);

  // ── 6. Build class registry ──────────────────────────────────────────────────
  const classes = collectClasses(tree);
  for (const [className, classNode] of classes) {
    const classMethods = collectClassMethods(classNode);
    const classInfo: ClassInfo = { methods: new Map() };

    for (const [methodName, methodNode] of classMethods) {
      if (methodName === "constructor") continue;
      const methodCalls = extractCalls({ rootNode: methodNode } as Tree);

      const methodMatches: AstCallMatch[] = [];
      for (const callInfo of methodCalls) {
        const { rootIdentifier, methodChain, args, line, column, node } = callInfo;
        const frequency = analyzeFrequency(node);
        const inLoop = frequencyToLoopContext(frequency);

        const resolved = resolveProvider(
          rootIdentifier, methodChain, varMap, thisFieldMap, parameterMaps, methodName
        );
        if (!resolved) continue;

        const { provider, packageName, resolvedChain } = resolved;
        const fp = lookupMethod(provider, resolvedChain);

        methodMatches.push(fp
          ? { kind: "sdk", provider, packageName, methodChain, confidence: 1.0, method: fp.httpMethod,
              endpoint: fp.endpoint, line, column, span: callInfo.span, frequency, loopContext: inLoop,
              streaming: fp.streaming, batchCapable: fp.batchCapable, cacheCapable: fp.cacheCapable }
          : { kind: "sdk", provider, packageName, methodChain, confidence: provider ? 0.7 : 0.1,
              line, column, span: callInfo.span, frequency, loopContext: inLoop }
        );
      }
      if (methodMatches.length > 0) classInfo.methods.set(methodName, methodMatches);
    }
    if (classInfo.methods.size > 0) classRegistry.set(className, classInfo);
  }

  // ── 7. Process all call expressions ─────────────────────────────────────────
  const seen = new Set<string>(); // dedup by "provider:chain:line"

  for (const callInfo of allCalls) {
    const { methodChain, rootIdentifier, args, line, column, node } = callInfo;
    const frequency = analyzeFrequency(node);
    const inLoop = frequencyToLoopContext(frequency);
    const fnName = enclosingFunctionName(node);
    const parts = methodChain.split(".");
    const lastMethod = parts[parts.length - 1];

    // ── 7a. Middleware registration (app.use / router.use) ───────────────────
    if (isMiddlewareCall(methodChain)) {
      for (const arg of args) {
        if (arg.type === "identifier") {
          const fnName2 = arg.text;
          if (importMap.has(fnName2)) {
            // Imported function — needs cross-file resolution
            middlewareQueue.push(fnName2);
          } else if (topLevelFunctions.has(fnName2)) {
            // Defined in this file — scan its body for API calls
            const cached = fnApiCalls.get(fnName2);
            if (cached) {
              for (const m of cached) {
                const key = `${m.provider}:${m.methodChain}:${m.line}`;
                if (!seen.has(key)) { seen.add(key); matches.push({ ...m, isMiddleware: true }); }
              }
            }
            // Note: fnApiCalls is populated in the function scan pass below;
            // middleware is re-processed after that pass.
          }
        }
      }
      continue; // don't also process app/router.use as an SDK call
    }

    // ── 7b. Callback / iteration patterns ──────────────────────────────────
    const isIterationCall =
      (ITERATION_METHODS.has(lastMethod) && parts.length >= 2) ||
      methodChain === "Promise.all" ||
      methodChain === "Promise.allSettled";

    const isQueueCall = QUEUE_WORKER_METHODS.has(lastMethod) && parts.length >= 2;

    if (isIterationCall || isQueueCall) {
      for (const arg of args) {
        if (arg.type === "identifier") {
          // Function reference passed to iteration/queue — will process after fn scan
          // Store for deferred processing; mark with special marker
          // We add a special sentinel — handled in the post-loop pass
        }
      }
      // Fall through — also process as a regular call (the iterator call itself may be interesting)
    }

    // ── 7c. fetch / axios generic HTTP ──────────────────────────────────────
    if (HTTP_CLIENTS.has(rootIdentifier) && (parts.length === 1 || AXIOS_METHODS.has(lastMethod))) {
      const url = extractUrlFromArgs(args);
      if (url) {
        try {
          const hostname = new URL(url.startsWith("/") ? `https://placeholder${url}` : url).hostname;
          const provider = hostname ? lookupHost(hostname) : null;
          const httpMethod = rootIdentifier === "fetch"
            ? extractHttpMethodFromOptions(args)
            : (AXIOS_METHODS.has(lastMethod) ? lastMethod.toUpperCase() : "GET");

          const key = `http:${provider ?? "?"}:${url}:${line}`;
          if (!seen.has(key)) {
            seen.add(key);
            matches.push({
              kind: "http",
              provider: provider ?? undefined,
              confidence: provider ? 0.4 : 0.1,
              methodChain,
              method: httpMethod,
              endpoint: url,
              line, column, span: callInfo.span,
              frequency,
              loopContext: inLoop,
            });
          }
        } catch {
          // Invalid URL — skip
        }
      }
      continue;
    }

    // ── 7d. Class instance method calls ──────────────────────────────────────
    if (parts.length === 2) {
      const [obj, method] = parts;
      const className = instanceMap.get(obj);
      if (className) {
        const classInfo = classRegistry.get(className);
        if (classInfo) {
          const methodCalls = classInfo.methods.get(method);
          if (methodCalls) {
            for (const m of methodCalls) {
              const key = `${m.provider}:${m.methodChain}:${line}`;
              if (!seen.has(key)) {
                seen.add(key);
                matches.push({ ...m, line, column, span: pointSpan(line, column), frequency, loopContext: inLoop || m.loopContext });
              }
            }
            continue;
          }
        }
      }
    }

    // ── 7e. Standard SDK call resolution ─────────────────────────────────────
    const resolved = resolveProvider(
      rootIdentifier, methodChain, varMap, thisFieldMap, parameterMaps, fnName
    );
    if (!resolved) continue;

    const { provider, packageName, resolvedChain } = resolved;
    const fp = lookupMethod(provider, resolvedChain);

    const key = `${provider}:${resolvedChain}:${line}`;
    if (seen.has(key)) continue;
    seen.add(key);

    if (fp) {
      matches.push({
        kind: "sdk", provider, packageName, methodChain, confidence: 1.0, method: fp.httpMethod,
        endpoint: fp.endpoint, line, column, span: callInfo.span, frequency, loopContext: inLoop,
        streaming: fp.streaming, batchCapable: fp.batchCapable, cacheCapable: fp.cacheCapable,
      });
    } else {
      matches.push({ kind: "sdk", provider, packageName, methodChain, confidence: provider ? 0.7 : 0.1, line, column, span: callInfo.span, frequency, loopContext: inLoop });
    }
  }

  // ── 8. Scan function bodies for API calls (for callback detection) ──────────
  for (const [fnName2, fnNode] of topLevelFunctions) {
    const fnCalls = extractCalls({ rootNode: fnNode } as Tree);
    const fnMatches: AstCallMatch[] = [];

    for (const callInfo of fnCalls) {
      const { rootIdentifier, methodChain, line, column, node } = callInfo;
      const resolved = resolveProvider(
        rootIdentifier, methodChain, varMap, thisFieldMap, parameterMaps, fnName2
      );
      if (!resolved) continue;
      const { provider, packageName, resolvedChain } = resolved;
      const fp = lookupMethod(provider, resolvedChain);
      fnMatches.push(fp
        ? { kind: "sdk", provider, packageName, methodChain, confidence: 1.0, method: fp.httpMethod,
            endpoint: fp.endpoint, line, column, span: callInfo.span, frequency: "single", loopContext: false,
            streaming: fp.streaming, batchCapable: fp.batchCapable, cacheCapable: fp.cacheCapable }
        : { kind: "sdk", provider, packageName, methodChain, confidence: provider ? 0.7 : 0.1,
            line, column, span: callInfo.span, frequency: "single", loopContext: false }
      );
    }
    if (fnMatches.length > 0) fnApiCalls.set(fnName2, fnMatches);
  }

  // ── 9. Second pass: callback / iteration patterns ───────────────────────────
  for (const callInfo of allCalls) {
    const { methodChain, args, line, column, node } = callInfo;
    const parts = methodChain.split(".");
    const lastMethod = parts[parts.length - 1];

    const isParallelCall = methodChain === "Promise.all" || methodChain === "Promise.allSettled";
    const isIterationCall =
      (ITERATION_METHODS.has(lastMethod) && parts.length >= 2) ||
      isParallelCall;

    const isQueueCall = QUEUE_WORKER_METHODS.has(lastMethod) && parts.length >= 2;

    if (!isIterationCall && !isQueueCall) continue;

    for (const arg of args) {
      // Direct identifier reference: forEach(askGPT)
      if (arg.type === "identifier") {
        const refName = arg.text;
        const refCalls = fnApiCalls.get(refName);
        if (refCalls) {
          const cbFreq = isParallelCall ? "parallel" : "bounded-loop";
          for (const m of refCalls) {
            const key = `${m.provider}:${m.methodChain}:${line}:cb`;
            if (!seen.has(key)) {
              seen.add(key);
              matches.push({ ...m, line, column, span: pointSpan(line, column), frequency: cbFreq, loopContext: true });
            }
          }
        }
      }
      // Nested call: Promise.all(arr.map(fn)) — fn is an arg inside the inner call
      if (arg.type === "call_expression") {
        const innerFn = arg.child(0);
        const innerArgs = arg.child(1);
        if (innerFn?.type === "member_expression") {
          const prop = innerFn.child(2);
          if (prop && ITERATION_METHODS.has(prop.text) && innerArgs) {
            for (let k = 0; k < innerArgs.namedChildCount; k++) {
              const innerArg = innerArgs.namedChild(k);
              if (innerArg?.type === "identifier") {
                const refCalls2 = fnApiCalls.get(innerArg.text);
                if (refCalls2) {
                  for (const m of refCalls2) {
                    const key = `${m.provider}:${m.methodChain}:${line}:nested`;
                    if (!seen.has(key)) {
                      seen.add(key);
                      matches.push({ ...m, line, column, span: pointSpan(line, column), frequency: "parallel", loopContext: true });
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }

  // ── 10. Re-process middleware registrations now that fnApiCalls is built ─────
  for (const callInfo of allCalls) {
    const { methodChain, args, line, column, node } = callInfo;
    if (!isMiddlewareCall(methodChain)) continue;
    for (const arg of args) {
      if (arg.type !== "identifier") continue;
      const fnName2 = arg.text;
      if (topLevelFunctions.has(fnName2)) {
        const mwCalls = fnApiCalls.get(fnName2);
        if (mwCalls) {
          for (const m of mwCalls) {
            const key = `${m.provider}:${m.methodChain}:${line}:mw`;
            if (!seen.has(key)) {
              seen.add(key);
              matches.push({ ...m, line, column, span: pointSpan(line, column), frequency: "single", loopContext: false, isMiddleware: true });
            }
          }
        }
      }
    }
  }

  return { matches, classRegistry, middlewareQueue };
}

/**
 * Scan a file on disk for API calls using Tree-sitter AST analysis.
 *
 * @param filePath   Absolute path to the file to scan.
 * @param readFileFn Async function to read file content (used for barrel resolution too).
 */
export async function scanFileWithAst(
  filePath: string,
  readFileFn: FileReader
): Promise<AstScanResult> {
  const source = await readFileFn(filePath);
  if (source === null) return { matches: [], classRegistry: new Map(), middlewareQueue: [] };

  const ext = path.extname(filePath);
  const language = getLanguageForExtension(ext);
  if (!language) return { matches: [], classRegistry: new Map(), middlewareQueue: [] };

  return scanSourceWithAst(source, language, filePath, readFileFn);
}
