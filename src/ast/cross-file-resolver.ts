/**
 * ast/cross-file-resolver.ts — Cross-file API call propagation (Phase 3.5).
 *
 * Takes per-file AST scan results and propagates API call metadata across file
 * boundaries so that waste detectors can see calls hidden behind:
 *
 *  1. Utility wrappers   — exported helper function wraps the SDK call
 *  2. Class services     — exported class method wraps the SDK call
 *  3. Middleware         — app.use(importedFn) → fn lives in another file
 *  4. Barrel re-exports  — import { fn } from '../utils' → utils/index.ts re-exports
 *  5. Callback refs      — items.map(importedFn) → fn lives in another file
 *
 * The main export is `runCrossFileResolution()`, which returns a map from
 * each file's relativePath to its augmented `AstCallMatch[]` (original matches
 * plus propagated matches from callees, with the caller's frequency context).
 */
import * as path from "path";
import type { AstCallMatch, AstScanResult } from "./ast-scanner";
import { PACKAGE_TO_PROVIDER } from "./ast-scanner";

// ── Public types ──────────────────────────────────────────────────────────────

export interface PerFileResult {
  /** Absolute path to the file. */
  filePath: string;
  /** Workspace-relative path (used as map key in output). */
  relativePath: string;
  /** Raw source text. */
  source: string;
  /** Output of scanFileWithAst() for this file. */
  result: AstScanResult;
}

// ── Internal types ────────────────────────────────────────────────────────────

/**
 * absoluteFilePath → exportedName → AstCallMatch[] inside that export.
 *
 * Built in the first pass over all PerFileResults.
 */
type ExportRegistry = Map<string, Map<string, AstCallMatch[]>>;

// ── Path utilities ─────────────────────────────────────────────────────────────

/** Normalize path separators to forward slashes for consistent matching. */
function normalizePath(p: string): string {
  return p.replace(/\\/g, "/");
}

/**
 * Join a base directory with a relative specifier, handling both POSIX and
 * Windows absolute paths (mirrors import-resolver.ts joinPath logic).
 */
function joinPath(baseDir: string, relPath: string): string {
  if (baseDir.startsWith("/")) {
    return path.posix.resolve(baseDir, relPath);
  }
  return normalizePath(path.resolve(baseDir, relPath));
}

/**
 * Try several extensions/index variants and return the first that exists
 * in `knownFiles` (a Set of absolute paths we actually scanned).
 *
 * Tries: bare → .ts → .js → /index.ts → /index.js
 */
function resolveImportPath(
  fromFile: string,
  specifier: string,
  knownFiles: Set<string>
): string | null {
  // Only resolve relative imports — npm packages start without . or /
  if (!specifier.startsWith(".") && !specifier.startsWith("/")) return null;

  const dir = path.dirname(fromFile.startsWith("/") ? fromFile : fromFile.replace(/\\/g, "/"));
  const base = joinPath(dir, specifier);

  const candidates = [
    base,
    base + ".ts",
    base + ".tsx",
    base + ".js",
    base + ".jsx",
    joinPath(base, "index.ts"),
    joinPath(base, "index.tsx"),
    joinPath(base, "index.js"),
    joinPath(base, "index.jsx"),
  ];

  for (const c of candidates) {
    if (knownFiles.has(c)) return c;
  }
  return null;
}

// ── Export detection helpers ──────────────────────────────────────────────────

interface FunctionRange {
  name: string;
  startLine: number; // 1-based
  endLine: number;   // 1-based (inclusive), or Infinity if unknown
}

/**
 * Scan source text for exported function declarations and const arrow functions.
 * Returns name + approximate line range so we can assign matches to exports.
 *
 * Patterns handled:
 *   export function foo(
 *   export async function foo(
 *   export const foo = (
 *   export const foo = async (
 *   export const foo: T = (
 */
function findExportedFunctions(source: string): FunctionRange[] {
  const lines = source.split("\n");
  const ranges: FunctionRange[] = [];

  const EXPORT_FN = /^export\s+(async\s+)?function\s+(\w+)/;
  const EXPORT_CONST = /^export\s+const\s+(\w+)(?:\s*:\s*[^=]+)?\s*=\s*(async\s+)?\(/;
  const EXPORT_DEFAULT_FN = /^export\s+default\s+(async\s+)?function(?:\s+(\w+))?/;

  // Track brace depth to approximate end of each function body.
  // Simple approach: find the opening { after the declaration, count braces.
  function findEndLine(startIdx: number): number {
    let depth = 0;
    let started = false;
    for (let i = startIdx; i < lines.length; i++) {
      for (const ch of lines[i]) {
        if (ch === "{") { depth++; started = true; }
        else if (ch === "}") { depth--; }
      }
      if (started && depth === 0) return i + 1; // 1-based
    }
    return lines.length;
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fnMatch = EXPORT_FN.exec(line);
    if (fnMatch) {
      ranges.push({ name: fnMatch[2], startLine: i + 1, endLine: findEndLine(i) });
      continue;
    }
    const constMatch = EXPORT_CONST.exec(line);
    if (constMatch) {
      ranges.push({ name: constMatch[1], startLine: i + 1, endLine: findEndLine(i) });
      continue;
    }
    // export default function ask(...) — register under both "default" sentinel and
    // the function's actual name (if present) so both lookup paths work.
    const defaultFnMatch = EXPORT_DEFAULT_FN.exec(line);
    if (defaultFnMatch) {
      const endLine = findEndLine(i);
      ranges.push({ name: "default", startLine: i + 1, endLine });
      if (defaultFnMatch[2]) {
        ranges.push({ name: defaultFnMatch[2], startLine: i + 1, endLine });
      }
    }
  }

  return ranges;
}

/**
 * Return the AstCallMatches whose lines fall within [start, end] (inclusive, 1-based).
 */
function matchesInRange(
  matches: AstCallMatch[],
  startLine: number,
  endLine: number
): AstCallMatch[] {
  return matches.filter((m) => m.line >= startLine && m.line <= endLine);
}

// ── Import extraction ─────────────────────────────────────────────────────────

interface ImportedName {
  localName: string;
  specifier: string; // import source string
}

/**
 * Extract relative imports from source text: both named and default imports.
 * Returns only entries whose specifier is a relative path (./ or ../).
 */
function extractRelativeImports(source: string): ImportedName[] {
  const results: ImportedName[] = [];
  // Match: import { A, B as C } from './path'   and  import D from './path'
  const IMPORT_RE = /^import\s+(.+?)\s+from\s+['"]([^'"]+)['"]/gm;
  let m: RegExpExecArray | null;
  while ((m = IMPORT_RE.exec(source)) !== null) {
    const clause = m[1];
    const specifier = m[2];
    if (!specifier.startsWith(".") && !specifier.startsWith("/")) continue;

    // Named imports: { A, B as C, ... }
    const namedMatch = /\{([^}]+)\}/.exec(clause);
    if (namedMatch) {
      for (const part of namedMatch[1].split(",")) {
        const trimmed = part.trim();
        if (!trimmed) continue;
        // "X as Y" → local name is Y
        const asMatch = /(\w+)\s+as\s+(\w+)/.exec(trimmed);
        if (asMatch) {
          results.push({ localName: asMatch[2], specifier });
        } else {
          const name = trimmed.match(/\w+/)?.[0];
          if (name) results.push({ localName: name, specifier });
        }
      }
    }

    // Default import: import Foo from './path' (clause has no braces)
    const defaultMatch = /^(\w+)$/.exec(clause.trim());
    if (defaultMatch) {
      results.push({ localName: defaultMatch[1], specifier });
    }
  }
  return results;
}

// ── Re-export detection ───────────────────────────────────────────────────────

interface ReExport {
  /** Exported name (or null for `export *` wildcard re-exports). */
  exportedName: string | null;
  /** Original name in the source file (differs from exportedName when aliased). */
  originalName: string | null;
  specifier: string;
}

/**
 * Detect `export { foo } from './other'`, `export { foo as bar } from './other'`,
 * and `export * from './other'` patterns.
 */
function extractReExports(source: string): ReExport[] {
  const results: ReExport[] = [];

  // Named re-exports: export { foo, bar as baz } from './other'
  const RE_EXPORT = /^export\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/gm;
  let m: RegExpExecArray | null;
  while ((m = RE_EXPORT.exec(source)) !== null) {
    const clause = m[1];
    const specifier = m[2];
    if (!specifier.startsWith(".") && !specifier.startsWith("/")) continue;
    for (const part of clause.split(",")) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const asMatch = /(\w+)\s+as\s+(\w+)/.exec(trimmed);
      if (asMatch) {
        // export { foo as bar } from './other' → exported as "bar", original is "foo"
        results.push({ exportedName: asMatch[2], originalName: asMatch[1], specifier });
      } else {
        const name = trimmed.match(/\w+/)?.[0];
        if (name) results.push({ exportedName: name, originalName: name, specifier });
      }
    }
  }

  // Wildcard re-exports: export * from './other'
  const WILDCARD_RE_EXPORT = /^export\s+\*\s+from\s+['"]([^'"]+)['"]/gm;
  let wm: RegExpExecArray | null;
  while ((wm = WILDCARD_RE_EXPORT.exec(source)) !== null) {
    const specifier = wm[1];
    if (!specifier.startsWith(".") && !specifier.startsWith("/")) continue;
    // null exportedName means "any symbol from this source"
    results.push({ exportedName: null, originalName: null, specifier });
  }

  return results;
}

// ── Export registry builder ───────────────────────────────────────────────────

/**
 * Build ExportRegistry from per-file matches.
 *
 * For each file:
 *  - Find exported function line ranges, assign matches inside each range
 *  - For each class in classRegistry, expose ClassName.methodName → matches
 *  - Re-export stubs are NOT resolved here — they're followed lazily by
 *    `resolveExportedMatches` (with cycle protection).
 *
 * `matchesByFile` maps absolute filePath → the current set of matches for that
 * file (raw matches initially, augmented matches on subsequent fixpoint passes).
 */
function buildExportRegistry(
  files: PerFileResult[],
  matchesByFile: Map<string, AstCallMatch[]>
): ExportRegistry {
  const registry: ExportRegistry = new Map();

  for (const { filePath, source, result } of files) {
    const exports: Map<string, AstCallMatch[]> = new Map();
    const fileMatches = matchesByFile.get(filePath) ?? result.matches;

    // ── Direct exported functions ──────────────────────────────────────────
    const fnRanges = findExportedFunctions(source);
    for (const range of fnRanges) {
      const inside = matchesInRange(fileMatches, range.startLine, range.endLine);
      if (inside.length > 0) {
        exports.set(range.name, inside);
      }
    }

    // ── Class methods ──────────────────────────────────────────────────────
    for (const [className, classInfo] of result.classRegistry) {
      for (const [methodName, methodMatches] of classInfo.methods) {
        if (methodMatches.length > 0) {
          exports.set(`${className}.${methodName}`, methodMatches);
          // Also expose under bare methodName for call-site matching
          const existing = exports.get(methodName) ?? [];
          exports.set(methodName, [...existing, ...methodMatches]);
        }
      }
    }

    registry.set(filePath, exports);
  }

  return registry;
}

// ── Clone with caller context ─────────────────────────────────────────────────

/**
 * Clone a callee AstCallMatch, overriding with the caller's execution context.
 * Preserves all provider/registry metadata from the callee.
 */
function cloneWithCallerContext(
  callee: AstCallMatch,
  callerLine: number,
  callerFrequency: AstCallMatch["frequency"],
  callerLoopContext: boolean,
  isMiddleware: boolean,
  calleeFilePath: string,
  callerFilePath: string
): AstCallMatch {
  return {
    ...callee,
    line: callerLine,
    frequency: isMiddleware ? "single" : callerFrequency,
    loopContext: isMiddleware ? false : callerLoopContext,
    isMiddleware: isMiddleware || callee.isMiddleware,
    crossFile: true,
    sourceFile: calleeFilePath,
  };
}

// ── Resolve a single name through re-export chains ────────────────────────────
//
// Cycle-safe via the `visited` set: each `(fromFile, name)` pair is visited at
// most once per top-level call, so mutual `export { x } from "./other"` chains
// terminate. The `depth` parameter caps the re-export chain length WITHIN a
// single call (3 hops). It is unrelated to the outer wrapper-chain depth — that
// is controlled by `runCrossFileResolution`'s `maxDepth` option.

function resolveExportedMatches(
  name: string,
  fromFile: string,
  registry: ExportRegistry,
  sourceByFile: Map<string, string>,
  knownFiles: Set<string>,
  depth: number,
  visited: Set<string> = new Set()
): AstCallMatch[] | null {
  if (depth > 2) return null;

  const visitKey = `${fromFile}::${name}`;
  if (visited.has(visitKey)) return null;
  visited.add(visitKey);

  const fileExports = registry.get(fromFile);
  if (fileExports) {
    const direct = fileExports.get(name);
    if (direct && direct.length > 0) return direct;
  }

  // Not found directly — check re-exports in that file
  const source = sourceByFile.get(fromFile);
  if (!source) return null;

  const reExports = extractReExports(source);
  for (const re of reExports) {
    // Wildcard re-export (`export * from './other'`) — any name passes through.
    // Named re-export — only proceed if exportedName matches the requested name.
    // Also allow `export { default } from './other'` to match any default import:
    // when a consumer does `import ask from './barrel'`, the barrel may re-export
    // the default slot explicitly via `export { default } from './api'`. In that
    // case the requested name is the local alias ("ask"), not "default", so we
    // need to follow the default re-export and look up "default" in the source.
    if (re.exportedName !== null && re.exportedName !== name && re.exportedName !== "default") continue;
    const resolved = resolveImportPath(fromFile, re.specifier, knownFiles);
    if (!resolved) continue;
    // When the barrel aliases (`export { _internalAsk as ask }`), the source file
    // knows the symbol by its originalName — recurse with that name so the export
    // registry lookup finds the actual function.
    // For wildcards, the name passes through unchanged (originalName is null).
    // For `export { default }`, recurse with "default" so the registry finds the
    // `export default function` entry in the source file.
    const lookupName = re.exportedName === "default" ? "default" : (re.originalName ?? name);
    const found = resolveExportedMatches(lookupName, resolved, registry, sourceByFile, knownFiles, depth + 1, visited);
    if (found) return found;
  }

  return null;
}

// ── Main export ───────────────────────────────────────────────────────────────

export interface CrossFileResolutionOptions {
  /** Maximum number of fixpoint iterations (wrapper-chain depth). Default: 3. */
  maxDepth?: number;
}

const DEFAULT_MAX_DEPTH = 3;

/** Stable dedupe key for an AstCallMatch within an output file's match list. */
function matchDedupeKey(m: AstCallMatch): string {
  return `${m.sourceFile ?? ""}::${m.line}::${m.methodChain}::${m.crossFile ? "x" : "o"}`;
}

/**
 * Per-caller invariants that do not change across fixpoint iterations: source
 * never changes, so neither do its imports, its middleware queue, or per-name
 * call-site locations. Hoisted out of the iteration loop to avoid re-running
 * regex passes on every pass.
 */
interface CallerContext {
  caller: PerFileResult;
  callerPath: string;       // normalized
  callerRelative: string;
  imports: ImportedName[];
  /** localName → list of bare invocation lines in source. */
  callSiteLinesByName: Map<string, number[]>;
  /** middlewareName → resolved import entry (or null if not imported relatively). */
  middlewareByName: Map<string, ImportedName | null>;
  /** middlewareName → app.use(name) line in source, if found. */
  middlewareUseLineByName: Map<string, number | null>;
}

/**
 * Run cross-file resolution over all per-file scan results.
 *
 * Iterates the propagation pass until no new matches are added or the depth
 * budget is exhausted, so wrapper chains of arbitrary depth (up to maxDepth)
 * resolve back to the original SDK call. Cycle protection lives in
 * `resolveExportedMatches` via a per-call visited set.
 *
 * @param options.maxDepth — Max wrapper-chain depth (max fixpoint iterations).
 *   Each iteration extends propagation by one wrapper hop, so `maxDepth=1`
 *   means "direct callee only" (no wrapper-of-a-wrapper resolution),
 *   `maxDepth=2` means "callee and one wrapper level above," etc. Values ≤ 0
 *   are clamped up to 1 (at least one pass always runs); defaults to 3.
 *
 * @returns Map from relativePath → augmented AstCallMatch[] (original + propagated).
 *          Files with no propagated matches still appear in the map with their
 *          original matches.
 */
export function runCrossFileResolution(
  files: PerFileResult[],
  options: CrossFileResolutionOptions = {}
): Map<string, AstCallMatch[]> {
  const maxDepth = Math.max(1, options.maxDepth ?? DEFAULT_MAX_DEPTH);
  const normalizedKnown = new Set(files.map((f) => normalizePath(f.filePath)));
  const sourceByFile = new Map(files.map((f) => [normalizePath(f.filePath), f.source]));
  const relativePathByNormalized = new Map(
    files.map((f) => [normalizePath(f.filePath), f.relativePath])
  );

  const output = new Map<string, AstCallMatch[]>();
  const seenKeysByFile = new Map<string, Set<string>>();
  for (const f of files) {
    const initial = [...f.result.matches];
    output.set(f.relativePath, initial);
    const seen = new Set<string>();
    for (const m of initial) seen.add(matchDedupeKey(m));
    seenKeysByFile.set(f.relativePath, seen);
  }

  // matchesByNormalizedFile is the live, augmented view used to rebuild the
  // export registry between fixpoint iterations.
  const matchesByNormalizedFile = new Map<string, AstCallMatch[]>();
  for (const f of files) {
    matchesByNormalizedFile.set(normalizePath(f.filePath), output.get(f.relativePath)!);
  }

  // ── Precompute per-caller invariants ONCE (source never changes between
  //    fixpoint iterations, so neither do these). ─────────────────────────────
  const callerContexts: CallerContext[] = files.map((caller) => {
    const callerPath = normalizePath(caller.filePath);
    const imports = extractRelativeImports(caller.source);

    const callSiteLinesByName = new Map<string, number[]>();
    for (const { localName } of imports) {
      if (!callSiteLinesByName.has(localName)) {
        callSiteLinesByName.set(localName, extractCallSiteLines(caller.source, localName));
      }
    }

    const middlewareByName = new Map<string, ImportedName | null>();
    const middlewareUseLineByName = new Map<string, number | null>();
    for (const mwName of caller.result.middlewareQueue) {
      middlewareByName.set(mwName, imports.find((i) => i.localName === mwName) ?? null);
      middlewareUseLineByName.set(mwName, findMiddlewareUseLine(caller.source, mwName));
    }

    return {
      caller,
      callerPath,
      callerRelative: caller.relativePath,
      imports,
      callSiteLinesByName,
      middlewareByName,
      middlewareUseLineByName,
    };
  });

  for (let iter = 0; iter < maxDepth; iter++) {
    const rawRegistry = buildExportRegistry(files, matchesByNormalizedFile);
    const registry: ExportRegistry = new Map();
    for (const [k, v] of rawRegistry) registry.set(normalizePath(k), v);

    let addedThisPass = 0;

    const tryPush = (relativePath: string, candidate: AstCallMatch): void => {
      const key = matchDedupeKey(candidate);
      const seen = seenKeysByFile.get(relativePath)!;
      if (seen.has(key)) return;
      seen.add(key);
      output.get(relativePath)!.push(candidate);
      addedThisPass++;
    };

    for (const ctx of callerContexts) {
      const { caller, callerPath, callerRelative, imports, callSiteLinesByName } = ctx;

      // ── Regular import propagation ─────────────────────────────────────────
      for (const { localName, specifier } of imports) {
        const resolvedFile = resolveImportPath(callerPath, specifier, normalizedKnown);
        if (!resolvedFile) continue;

        // Find all call sites in this file that reference the imported name
        const callSites = caller.result.matches.filter((m) => {
          const chain = m.methodChain.toLowerCase();
          const local = localName.toLowerCase();
          return (
            chain === local ||
            chain.startsWith(local + ".") ||
            chain.includes("." + local + ".") ||
            chain.endsWith("." + local)
          );
        });

        // If no explicit call site found in matches, look for the name in source
        // as a bare invocation (call site might not be in matches because it has
        // no known provider — but the callee does). Precomputed once per caller.
        const callSiteLines = callSiteLinesByName.get(localName) ?? [];

        const calleeMatches = resolveExportedMatches(
          localName,
          resolvedFile,
          registry,
          sourceByFile,
          normalizedKnown,
          0
        );
        if (!calleeMatches || calleeMatches.length === 0) continue;

        if (callSites.length > 0) {
          for (const site of callSites) {
            for (const callee of calleeMatches) {
              tryPush(
                callerRelative,
                cloneWithCallerContext(
                  callee,
                  site.line,
                  site.frequency,
                  site.loopContext,
                  false,
                  resolvedFile,
                  callerPath
                )
              );
            }
          }
        } else if (callSiteLines.length > 0) {
          for (const lineNum of callSiteLines) {
            for (const callee of calleeMatches) {
              tryPush(
                callerRelative,
                cloneWithCallerContext(callee, lineNum, "single", false, false, resolvedFile, callerPath)
              );
            }
          }
        }
      }

      // ── Middleware propagation ─────────────────────────────────────────────
      for (const mwName of caller.result.middlewareQueue) {
        const importEntry = ctx.middlewareByName.get(mwName);
        if (!importEntry) continue;

        const resolvedFile = resolveImportPath(callerPath, importEntry.specifier, normalizedKnown);
        if (!resolvedFile) continue;

        const calleeMatches = resolveExportedMatches(
          mwName,
          resolvedFile,
          registry,
          sourceByFile,
          normalizedKnown,
          0
        );
        if (!calleeMatches || calleeMatches.length === 0) continue;

        const useLine = ctx.middlewareUseLineByName.get(mwName) ?? null;

        for (const callee of calleeMatches) {
          tryPush(
            callerRelative,
            cloneWithCallerContext(
              callee,
              useLine ?? callee.line,
              "single",
              false,
              true,
              resolvedFile,
              callerPath
            )
          );
        }
      }
    }

    if (addedThisPass === 0) break;

    // Refresh the live registry view so the next iteration can see matches that
    // were just propagated into each caller's exported function bodies.
    for (const [normalized, relPath] of relativePathByNormalized) {
      matchesByNormalizedFile.set(normalized, output.get(relPath)!);
    }
  }

  // ── Factory return post-pass ───────────────────────────────────────────────
  //
  // Handles `const client = makeClient()` where `makeClient` is imported from
  // another file and that file's factory function returns `new OpenAI()`.
  //
  // Algorithm:
  //  1. Build global factory registry: absoluteFilePath → (exportedFnName → package)
  //     from each file's AstScanResult.factoryReturnMap.
  //  2. For each consumer file, scan its relative imports for factory functions.
  //  3. Find `const varName = factoryFn()` patterns in consumer source.
  //  4. Find call expressions that use varName (e.g. varName.chat.completions.create)
  //     that aren't already attributed to a provider.
  //  5. Emit synthetic AstCallMatches attributed to the factory's returned package.
  runFactoryReturnPostPass(files, normalizedKnown, output, seenKeysByFile);

  return output;
}

// ── Factory return post-pass helpers ──────────────────────────────────────────

/**
 * Parse `const varName = factoryFn()` patterns from source text.
 * Returns a map from varName → factoryFn (the callee name).
 */
function extractFactoryCallAssignments(source: string): Map<string, string> {
  const result = new Map<string, string>();
  // const/let/var varName = factoryFnName()
  // Also handles: const varName = factoryFnName<T>()
  const RE = /(?:const|let|var)\s+(\w+)\s*=\s*(\w+)\s*(?:<[^>]*>)?\s*\(\s*\)/gm;
  let m: RegExpExecArray | null;
  while ((m = RE.exec(source)) !== null) {
    result.set(m[1], m[2]);
  }
  return result;
}

/**
 * Find all `varName.a.b.c(...)` call chains in source text.
 * Returns { methodChain, line } entries (1-based line numbers).
 */
function extractVarMethodCalls(source: string, varName: string): Array<{ methodChain: string; line: number }> {
  const results: Array<{ methodChain: string; line: number }> = [];
  const lines = source.split("\n");
  // Match: varName.something.something...(  — at least one dot required
  // Build the regex once; matchAll() returns a fresh iterator per call so
  // there are no lastIndex state issues between lines.
  const re = new RegExp(`\\b(${escapeRegex(varName)}(?:\\.[\\w]+)+)\\s*\\(`, "g");
  for (let i = 0; i < lines.length; i++) {
    for (const m of lines[i].matchAll(re)) {
      results.push({ methodChain: m[1], line: i + 1 });
    }
  }
  return results;
}


function runFactoryReturnPostPass(
  files: PerFileResult[],
  normalizedKnown: Set<string>,
  output: Map<string, AstCallMatch[]>,
  seenKeysByFile: Map<string, Set<string>>
): void {
  // Step 1: Build global factory registry
  // globalFactoryRegistry: normalizedFilePath → (fnName → package)
  const globalFactoryRegistry = new Map<string, Map<string, string>>();
  for (const f of files) {
    const frm = f.result.factoryReturnMap;
    if (frm && frm.size > 0) {
      globalFactoryRegistry.set(normalizePath(f.filePath), frm);
    }
  }
  if (globalFactoryRegistry.size === 0) return;

  // Step 2: For each consumer file, check imports against the factory registry
  for (const consumer of files) {
    const consumerPath = normalizePath(consumer.filePath);
    const imports = extractRelativeImports(consumer.source);

    const seen = seenKeysByFile.get(consumer.relativePath)!;
    const matches = output.get(consumer.relativePath)!;

    // Step 3: Find `const varName = localName()` in consumer source — hoisted
    // out of the per-import loop so we only parse the source once per consumer.
    const factoryAssignments = extractFactoryCallAssignments(consumer.source);
    if (factoryAssignments.size === 0) continue;

    for (const { localName, specifier } of imports) {
      const resolvedFile = resolveImportPath(consumerPath, specifier, normalizedKnown);
      if (!resolvedFile) continue;

      const fileFactories = globalFactoryRegistry.get(resolvedFile);
      if (!fileFactories) continue;

      const pkg = fileFactories.get(localName);
      if (!pkg) continue;

      const provider = PACKAGE_TO_PROVIDER[pkg] ?? pkg;

      // Find all var names assigned from this factory function
      for (const [varName, callee] of factoryAssignments) {
        if (callee !== localName) continue;

        // Step 4: Find method calls on varName in consumer source
        const calls = extractVarMethodCalls(consumer.source, varName);
        for (const { methodChain, line } of calls) {
          // Strip varName prefix: "client.chat.completions.create" → "chat.completions.create"
          const dot = methodChain.indexOf(".");
          const resolvedChain = dot !== -1 ? methodChain.slice(dot + 1) : "";
          if (!resolvedChain) continue;

          const key = `${provider}:${resolvedChain}:${line}`;
          if (seen.has(key)) continue;
          seen.add(key);

          matches.push({
            kind: "sdk",
            provider,
            packageName: pkg,
            methodChain,
            confidence: 0.9,
            line,
            column: 0,
            span: { startLine: line, startColumn: 0, endLine: line, endColumn: 0 },
            frequency: "single",
            loopContext: false,
            enclosingFunction: null,
            crossFile: true,
            sourceFile: resolvedFile,
          });
        }
      }
    }
  }
}

// ── Source text helpers ───────────────────────────────────────────────────────

/** Find lines where `name(` or `name.` appears in source (1-based). */
function extractCallSiteLines(source: string, name: string): number[] {
  const lines = source.split("\n");
  const re = new RegExp(`\\b${escapeRegex(name)}\\s*[.(]`);
  const result: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i])) result.push(i + 1);
  }
  return result;
}

/** Find line where `app.use(name)` or `.use(name)` appears (1-based). */
function findMiddlewareUseLine(source: string, name: string): number | null {
  const lines = source.split("\n");
  const re = new RegExp(`\\.use\\s*\\([^)]*\\b${escapeRegex(name)}\\b`);
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i])) return i + 1;
  }
  return null;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
