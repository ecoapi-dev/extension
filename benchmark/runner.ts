import * as fs from "node:fs";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loadExpectedJson } from "./schema";
import { computeMetrics, aggregate, type DetectedEndpoint, type DetectedFinding, type MetricsReport } from "./metrics";
import { formatMarkdownReport, formatConsoleReport } from "./report";

const execFileAsync = promisify(execFile);

// When compiled with rootDir: "." and outDir: "dist-test", this file lands at
// <repo>/dist-test/benchmark/runner.js, so __dirname is <repo>/dist-test/benchmark.
// Climb two levels to reach the repo root.
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const DEFAULT_FIXTURES = path.resolve(REPO_ROOT, "..", "extension-benchmark");
const DEFAULT_BASELINE = path.resolve(REPO_ROOT, "benchmark", "baseline.json");
const SMOKE_DIR = path.resolve(REPO_ROOT, "benchmark", "_smoke");
const CLI_PATH = path.resolve(REPO_ROOT, "dist", "cli", "scan.js");
const DEFAULT_THRESHOLD_PP = 1.0;

interface CliArgs {
  fixturesDir: string;
  baselinePath: string;
  thresholdPp: number;
  updateBaseline: boolean;
  smokeOnly: boolean;
  reportPath: string | null;
}

interface ScanResult {
  endpoints: Array<{
    provider: string;
    method?: string;
    methodSignature?: string;
    files: string[];
    callSites: Array<{ file: string; line: number }>;
  }>;
  suggestions: Array<{
    type: string;
    affectedFiles: string[];
    targetLine?: number;
  }>;
}

function requireValue(argv: string[], i: number, flag: string): string {
  const v = argv[i];
  if (v === undefined) {
    console.error(`Missing value after ${flag}`);
    process.exit(2);
  }
  return v;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    fixturesDir: DEFAULT_FIXTURES,
    baselinePath: DEFAULT_BASELINE,
    thresholdPp: DEFAULT_THRESHOLD_PP,
    updateBaseline: false,
    smokeOnly: false,
    reportPath: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--fixtures") args.fixturesDir = path.resolve(requireValue(argv, ++i, a));
    else if (a === "--baseline") args.baselinePath = path.resolve(requireValue(argv, ++i, a));
    else if (a === "--threshold") {
      const raw = requireValue(argv, ++i, a);
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0) {
        console.error(`Invalid --threshold value: ${raw} (must be a non-negative number)`);
        process.exit(2);
      }
      args.thresholdPp = n;
    }
    else if (a === "--update-baseline") args.updateBaseline = true;
    else if (a === "--smoke") args.smokeOnly = true;
    else if (a === "--report") args.reportPath = path.resolve(requireValue(argv, ++i, a));
    else if (a === "--help" || a === "-h") { printHelp(); process.exit(0); }
    else { console.error(`Unknown arg: ${a}`); process.exit(2); }
  }
  return args;
}

function printHelp(): void {
  console.log([
    "Usage: node dist-test/benchmark/runner.js [options]",
    "",
    "Options:",
    "  --fixtures <dir>     Path to fixtures root (default: ../extension-benchmark)",
    "  --baseline <path>    Path to baseline.json (default: benchmark/baseline.json)",
    "  --threshold <pp>     Allowed drop in percentage points (default: 1.0)",
    "  --update-baseline    Overwrite baseline.json with current metrics; do not gate",
    "  --smoke              Use only benchmark/_smoke; ignore --fixtures",
    "  --report <path>      Write JSON report to file",
    "",
  ].join("\n"));
}

async function findFixtures(root: string, smokeOnly: boolean): Promise<string[]> {
  if (smokeOnly) return [SMOKE_DIR];
  if (!fs.existsSync(root)) {
    console.error([
      `Fixtures directory not found: ${root}`,
      "",
      "To get the v1 corpus:",
      `  git clone https://github.com/recost-dev/extension-benchmark.git ${root}`,
      "",
      "Or run smoke-only: npm run benchmark:smoke",
    ].join("\n"));
    process.exit(2);
  }
  const entries = fs.readdirSync(root, { withFileTypes: true });
  return entries
    .filter(e => e.isDirectory() && !e.name.startsWith(".") && !e.name.startsWith("_"))
    .map(e => path.join(root, e.name))
    .filter(p => fs.existsSync(path.join(p, "expected.json")));
}

async function scanFixture(fixtureDir: string): Promise<ScanResult> {
  const srcDir = path.join(fixtureDir, "src");
  const targetDir = fs.existsSync(srcDir) ? srcDir : fixtureDir;
  try {
    const { stdout } = await execFileAsync("node", [CLI_PATH, targetDir, "--format", "json"], {
      maxBuffer: 50 * 1024 * 1024,
      timeout: 300_000,
    });
    return JSON.parse(stdout) as ScanResult;
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message: string };
    throw new Error(`Scanner failed for ${fixtureDir}: ${e.message}\nSTDERR: ${e.stderr ?? ""}`);
  }
}

function detectedFromScan(result: ScanResult, fixtureDir: string): { endpoints: DetectedEndpoint[]; findings: DetectedFinding[] } {
  // The CLI emits callSite.file paths relative to the scan target (fixtureDir/src when present),
  // not the fixture root. Resolve against the same target dir we passed to the CLI so
  // path.relative(fixtureDir, ...) yields the same file string the expected.json uses
  // (e.g. "src/openai-helper.ts").
  const srcDir = path.join(fixtureDir, "src");
  const scanRoot = fs.existsSync(srcDir) ? srcDir : fixtureDir;

  // Dedupe by file+line+provider+method: ast-scanner can emit multiple call-site entries per
  // endpoint group (e.g. import line, constructor line, real call line) all sharing the same
  // methodSignature. Keying on provider+method as well preserves distinct calls that legitimately
  // share a line (e.g. `Promise.all([a.create(), b.create()])`).
  const endpoints: DetectedEndpoint[] = [];
  const seenEndpoints = new Set<string>();
  for (const e of result.endpoints) {
    const provider = e.provider ?? "unknown";
    const method = e.methodSignature ?? e.method ?? "";
    for (const cs of e.callSites) {
      const relFile = path.relative(fixtureDir, path.resolve(scanRoot, cs.file)).replace(/\\/g, "/");
      const key = `${relFile}:${cs.line}:${provider}:${method}`;
      if (seenEndpoints.has(key)) continue;
      seenEndpoints.add(key);
      endpoints.push({ file: relFile, line: cs.line, provider, method });
    }
  }
  const findings: DetectedFinding[] = [];
  const seenFindings = new Set<string>();
  for (const s of result.suggestions) {
    if (typeof s.targetLine !== "number") continue;
    const file = s.affectedFiles[0];
    if (!file) continue;
    const relFile = path.relative(fixtureDir, path.resolve(scanRoot, file)).replace(/\\/g, "/");
    const key = `${relFile}:${s.targetLine}:${s.type}`;
    if (seenFindings.has(key)) continue;
    seenFindings.add(key);
    findings.push({
      file: relFile,
      line: s.targetLine,
      type: s.type,
    });
  }
  return { endpoints, findings };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const fixtureDirs = await findFixtures(args.fixturesDir, args.smokeOnly);
  if (fixtureDirs.length === 0) {
    console.error(`No fixtures found in ${args.fixturesDir}`);
    process.exit(2);
  }
  console.log(`Running ${fixtureDirs.length} fixture(s)...`);

  const perFixture = [];
  for (const dir of fixtureDirs) {
    const slug = path.basename(dir);
    console.log(`  ${slug}...`);
    const expected = loadExpectedJson(path.join(dir, "expected.json"));
    const scan = await scanFixture(dir);
    const { endpoints, findings } = detectedFromScan(scan, dir);
    perFixture.push(computeMetrics(expected, endpoints, findings));
  }
  const report = aggregate(perFixture);

  if (args.updateBaseline) {
    fs.writeFileSync(args.baselinePath, JSON.stringify({
      detectionPrecision: report.detectionPrecision,
      detectionRecall: report.detectionRecall,
      providerAttributionAccuracy: report.providerAttributionAccuracy,
      findingPrecision: report.findingPrecision,
      findingRecall: report.findingRecall,
      findingMetricsByType: report.findingMetricsByType,
    }, null, 2) + "\n");
    console.log(formatConsoleReport(report, null));
    console.log(`\nBaseline updated: ${args.baselinePath}`);
    return;
  }

  let baseline: MetricsReport | null = null;
  if (fs.existsSync(args.baselinePath)) {
    const raw = JSON.parse(fs.readFileSync(args.baselinePath, "utf8"));
    baseline = {
      ...raw,
      findingMetricsByType: raw.findingMetricsByType ?? {},
      perFixture: [],
    };
  }
  console.log(formatConsoleReport(report, baseline));

  if (args.reportPath) {
    fs.writeFileSync(args.reportPath, JSON.stringify(report, null, 2) + "\n");
  }

  const stepSummary = process.env.GITHUB_STEP_SUMMARY;
  if (stepSummary) {
    fs.appendFileSync(stepSummary, formatMarkdownReport(report, baseline) + "\n");
  }

  if (baseline) {
    const drops = computeDrops(report, baseline, args.thresholdPp);
    if (drops.length > 0) {
      console.error(`\nFAIL: ${drops.length} metric(s) dropped > ${args.thresholdPp}pp:`);
      for (const d of drops) console.error(`  - ${d.metric}: ${(d.baseline * 100).toFixed(1)}% → ${(d.current * 100).toFixed(1)}% (Δ ${(d.deltaPp).toFixed(2)}pp)`);
      process.exit(1);
    }
  }
}

function computeDrops(current: MetricsReport, baseline: MetricsReport, thresholdPp: number): Array<{ metric: string; current: number; baseline: number; deltaPp: number }> {
  const metrics: Array<keyof Pick<MetricsReport, "detectionPrecision" | "detectionRecall" | "providerAttributionAccuracy" | "findingPrecision" | "findingRecall">> = [
    "detectionPrecision",
    "detectionRecall",
    "providerAttributionAccuracy",
    "findingPrecision",
    "findingRecall",
  ];
  const drops: Array<{ metric: string; current: number; baseline: number; deltaPp: number }> = [];
  for (const m of metrics) {
    const deltaPp = (current[m] - baseline[m]) * 100;
    if (deltaPp < -thresholdPp) drops.push({ metric: m, current: current[m], baseline: baseline[m], deltaPp });
  }
  // Per-type precision drops. Sample-size gate: only fire when both baseline and current
  // have TP+FP >= 3 for the type — types with too few emitted findings are noisy.
  const currentByType = current.findingMetricsByType ?? {};
  const baselineByType = baseline.findingMetricsByType ?? {};
  for (const [type, cur] of Object.entries(currentByType)) {
    const base = baselineByType[type];
    if (!base) continue;
    const curSample = cur.truePositives + cur.falsePositives;
    const baseSample = base.truePositives + base.falsePositives;
    if (curSample < 3 || baseSample < 3) continue;
    const deltaPp = (cur.precision - base.precision) * 100;
    if (deltaPp < -thresholdPp) {
      drops.push({
        metric: `findings[${type}].precision`,
        current: cur.precision,
        baseline: base.precision,
        deltaPp,
      });
    }
  }
  return drops;
}

main().catch(err => { console.error(err); process.exit(1); });
