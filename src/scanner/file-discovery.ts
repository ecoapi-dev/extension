import * as fs from "fs/promises";
import * as path from "path";
import type { ScanInputFile } from "./core-scanner";

const ALLOWED_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".java", ".rb"]);

/**
 * Reserved filenames that surface when the "Include fixture file" toggle is on.
 * All other test files remain suppressed regardless of toggle state.
 * Users create this file to test ReCost against mock API patterns.
 */
export const RECOST_FIXTURE_FILENAMES = new Set([
  "recost-mock-calls.ts",
  "recost-mock-calls.js",
  "recost-mock-calls.tsx",
  "recost-mock-calls.jsx",
]);

export function isRecostFixtureFile(filePath: string): boolean {
  return RECOST_FIXTURE_FILENAMES.has(path.basename(filePath));
}

const DEFAULT_IGNORE_PATTERNS = [
  // Existing patterns
  "**/*.test.ts",
  "**/*.test.tsx",
  "**/*.spec.ts",
  "**/*.spec.tsx",
  "**/mocks/**",
  "**/mock-data.*",
  "**/__mocks__/**",
  "**/fixtures/**",

  // New — universal false positive file types
  "**/*.md",           // markdown files contain URL examples, not API calls
  "**/*.json",         // JSON files are data definitions, not runtime calls
  "**/*.lock",         // lockfiles should never be scanned
  "**/dist/**",        // compiled output
  "**/build/**",       // compiled output
  "**/.next/**",       // Next.js build output
  "**/coverage/**",    // test coverage reports
  "**/*.min.js",       // minified files
  "**/*.min.css",      // minified files

  // (A6 / #78) These files were previously excluded to mask false positives
  // where the multi-line regex fallback in core-scanner.ts attributed real
  // call_expression matches to the start of a 6-line window — e.g. an
  // `import OpenAI from "openai"` line slurping a real
  // chat.completions.create call from a later line and reporting it at
  // line 1. The actual fix is in core-scanner.ts (search for `astOverlap`).
  // These exclusions are no longer needed and were masking real calls in
  // any file matching these names. Removed for #78.
];

export const HARD_EXCLUDED_SEGMENTS = new Set([
  "node_modules",
  "docs",
  "examples",
  "dist",
  "build",
  "coverage",
  ".git",
  ".next",
  "vendor",
  "venv",
  ".venv",
  "__pycache__",
]);

export function normalizePath(value: string): string {
  return value.replace(/\\/g, "/");
}

export function parseCsvGlobs(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

export function isHardExcludedPath(relativePath: string): boolean {
  return normalizePath(relativePath)
    .split("/")
    .some((segment) => HARD_EXCLUDED_SEGMENTS.has(segment));
}

function escapeRegex(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function expandBraces(pattern: string): string[] {
  const match = pattern.match(/\{([^{}]+)\}/);
  if (!match) return [pattern];
  const [token, body] = match;
  return body.split(",").flatMap((part) => expandBraces(pattern.replace(token, part)));
}

function globToRegExp(pattern: string): RegExp {
  let source = "^";
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index];
    const next = pattern[index + 1];

    if (char === "*") {
      if (next === "*") {
        source += ".*";
        index++;
      } else {
        source += "[^/]*";
      }
      continue;
    }

    if (char === "?") {
      source += ".";
      continue;
    }

    source += escapeRegex(char);
  }

  source += "$";
  return new RegExp(source);
}

function buildGlobMatchers(patterns: string[]): RegExp[] {
  return patterns.flatMap((pattern) => expandBraces(normalizePath(pattern)).map(globToRegExp));
}

function matchesAny(relativePath: string, matchers: RegExp[]): boolean {
  if (matchers.length === 0) return false;
  return matchers.some((matcher) => matcher.test(relativePath));
}

async function loadIgnorePatterns(repoRoot: string): Promise<string[]> {
  const ignorePath = path.join(repoRoot, ".recostignore");

  // When toggle is on, only bypass fixture file suppression.
  // All other default patterns still apply including test file patterns.
  // The fixture file bypass happens in collectFiles() via isRecostFixtureFile().
  const defaults = DEFAULT_IGNORE_PATTERNS;

  try {
    const content = await fs.readFile(ignorePath, "utf-8");
    const userPatterns = content
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"));
    return [...defaults, ...userPatterns];
  } catch {
    return defaults;
  }
}

async function collectFiles(
  rootDir: string,
  currentDir: string,
  includeMatchers: RegExp[],
  excludeMatchers: RegExp[],
  ignoreMatchers: RegExp[],
  results: ScanInputFile[],
  includeTestFiles: boolean = false
): Promise<number> {
  const entries = await fs.readdir(currentDir, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  let excluded = 0;

  for (const entry of entries) {
    const absolutePath = path.join(currentDir, entry.name);
    const relativePath = normalizePath(path.relative(rootDir, absolutePath));
    if (isHardExcludedPath(relativePath) || matchesAny(relativePath, excludeMatchers)) continue;

    if (entry.isDirectory()) {
      excluded += await collectFiles(rootDir, absolutePath, includeMatchers, excludeMatchers, ignoreMatchers, results, includeTestFiles);
      continue;
    }

    if (!entry.isFile()) continue;
    if (!ALLOWED_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
    if (includeMatchers.length > 0 && !matchesAny(relativePath, includeMatchers)) continue;

    // If this is a ReCost fixture file, only include it when toggle is on
    if (isRecostFixtureFile(relativePath)) {
      if (includeTestFiles) {
        results.push({ absolutePath, relativePath });
      } else {
        excluded++;
      }
      continue;
    }

    // Normal ignore pattern check for all other files
    if (matchesAny(relativePath, ignoreMatchers)) {
      excluded++;
      continue;
    }
    results.push({ absolutePath, relativePath });
  }
  return excluded;
}

export async function discoverFilesInDirectory(
  rootDir: string,
  options?: {
    includeGlobs?: string[];
    excludeGlobs?: string[];
    includeTestFiles?: boolean;
  }
): Promise<{ files: ScanInputFile[]; excludedCount: number }> {
  const includeMatchers = buildGlobMatchers(options?.includeGlobs ?? []);
  const excludeMatchers = buildGlobMatchers(options?.excludeGlobs ?? []);
  const ignorePatterns = await loadIgnorePatterns(rootDir);
  const ignoreMatchers = buildGlobMatchers(ignorePatterns);
  const results: ScanInputFile[] = [];

  const excludedCount = await collectFiles(
    path.resolve(rootDir),
    path.resolve(rootDir),
    includeMatchers,
    excludeMatchers,
    ignoreMatchers,
    results,
    options?.includeTestFiles ?? false
  );

  results.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return { files: results, excludedCount };
}
