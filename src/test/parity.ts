import * as path from "path";
import * as fs from "fs";
import { setWasmDir, getLanguageForExtension } from "../ast/parser-loader";
import { scanSourceWithAst, type AstCallMatch } from "../ast/ast-scanner";
import { matchLine } from "../scanner/patterns";

setWasmDir(path.join(__dirname, "..", "..", "assets", "parsers"));

export interface ParityRecord {
  provider: string;
  method: string;
  line: number;
  source: "ast" | "regex";
}

export interface FixtureDivergence {
  file: string;
  ast: ParityRecord[];      // matches AST found that regex missed
  regex: ParityRecord[];    // matches regex found that AST missed
  disagreed: Array<{ line: number; ast: ParityRecord; regex: ParityRecord }>;
}

export interface AllowlistEntry {
  file: string;             // relative path under fixtures/parity/
  reason: string;           // human-readable rationale
  astOnly?: boolean;        // expected: AST detects, regex does not
  regexOnly?: boolean;      // expected: regex detects, AST does not
}

function normalizeAst(matches: AstCallMatch[]): ParityRecord[] {
  return matches
    .filter((m) => m.provider) // unattributed AST matches don't participate in parity
    .map((m) => ({
      provider: m.provider!,
      method: (m.method ?? "CALL").toUpperCase(),
      line: m.line,
      source: "ast" as const,
    }));
}

function normalizeRegex(source: string): ParityRecord[] {
  const out: ParityRecord[] = [];
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const matches = matchLine(lines[i]);
    for (const m of matches) {
      // The regex layer's "library" maps loosely to provider for known hosts,
      // but for generic-http it's "generic-http" — those don't participate.
      if (m.library === "generic-http") continue;
      out.push({
        provider: m.library,
        method: m.method.toUpperCase(),
        line: i + 1,
        source: "regex",
      });
    }
  }
  return out;
}

function key(r: ParityRecord): string {
  return `${r.provider}|${r.method}|${r.line}`;
}

export async function compareForFixture(
  filePath: string,
  source: string
): Promise<FixtureDivergence> {
  const ext = path.extname(filePath);
  const lang = getLanguageForExtension(ext);
  const astResult = lang
    ? await scanSourceWithAst(source, lang, filePath)
    : { matches: [], classRegistry: new Map(), middlewareQueue: [] };

  const astRecords = normalizeAst(astResult.matches);
  const regexRecords = normalizeRegex(source);

  const astByKey = new Map(astRecords.map((r) => [key(r), r]));
  const regexByKey = new Map(regexRecords.map((r) => [key(r), r]));

  const astOnly: ParityRecord[] = [];
  const regexOnly: ParityRecord[] = [];
  const disagreed: Array<{ line: number; ast: ParityRecord; regex: ParityRecord }> = [];

  for (const [k, r] of astByKey) {
    if (!regexByKey.has(k)) {
      // Could be a same-line, different (provider/method) disagreement —
      // pair with anything regex emitted on the same line first.
      const sameLineRegex = regexRecords.find((x) => x.line === r.line);
      if (sameLineRegex) disagreed.push({ line: r.line, ast: r, regex: sameLineRegex });
      else astOnly.push(r);
    }
  }
  for (const [k, r] of regexByKey) {
    if (!astByKey.has(k)) {
      const sameLineAst = astRecords.find((x) => x.line === r.line);
      if (!sameLineAst) regexOnly.push(r);
      // (the disagreed-on-same-line case is already pushed above, no need to dup)
    }
  }

  return { file: filePath, ast: astOnly, regex: regexOnly, disagreed };
}

export async function runParity(
  fixtureDir: string,
  allowlist: AllowlistEntry[]
): Promise<{ allDivergences: FixtureDivergence[]; unannotated: FixtureDivergence[] }> {
  const files = fs.readdirSync(fixtureDir).map((f) => path.join(fixtureDir, f));
  const allDivergences: FixtureDivergence[] = [];
  const unannotated: FixtureDivergence[] = [];

  for (const filePath of files) {
    const source = fs.readFileSync(filePath, "utf8");
    const div = await compareForFixture(filePath, source);
    if (div.ast.length === 0 && div.regex.length === 0 && div.disagreed.length === 0) continue;
    allDivergences.push(div);

    const relName = path.relative(fixtureDir, filePath);
    const entry = allowlist.find((e) => e.file === relName);
    if (!entry) { unannotated.push(div); continue; }
    if (div.disagreed.length > 0) { unannotated.push(div); continue; } // disagreement on same line is never allowed
    if (div.ast.length > 0 && !entry.astOnly) { unannotated.push(div); continue; }
    if (div.regex.length > 0 && !entry.regexOnly) { unannotated.push(div); continue; }
  }

  return { allDivergences, unannotated };
}

/**
 * Parse the YAML block out of `docs/accuracy/PARITY.md`.
 * The file has a single ```yaml fenced block whose contents are an array of
 * AllowlistEntry. Minimal hand-rolled parser — no YAML dep.
 */
export function parseAllowlist(markdown: string): AllowlistEntry[] {
  const yamlMatch = markdown.match(/```yaml\n([\s\S]*?)```/);
  if (!yamlMatch) return [];
  const body = yamlMatch[1];
  const entries: AllowlistEntry[] = [];
  let current: Partial<AllowlistEntry> | null = null;
  for (const rawLine of body.split("\n")) {
    const line = rawLine.trimEnd();
    if (line.startsWith("- file:")) {
      if (current?.file) entries.push(current as AllowlistEntry);
      current = { file: line.slice("- file:".length).trim() };
    } else if (current && line.trim().startsWith("reason:")) {
      current.reason = line.split("reason:")[1].trim();
    } else if (current && line.trim().startsWith("astOnly:")) {
      current.astOnly = line.includes("true");
    } else if (current && line.trim().startsWith("regexOnly:")) {
      current.regexOnly = line.includes("true");
    }
  }
  if (current?.file) entries.push(current as AllowlistEntry);
  return entries;
}
