import fs from "node:fs";
import * as path from "path";
import { newLocalScanId } from "../scan-id";
import { createFilesystemScanAccess } from "./filesystem-adapter";
import { detectLocalWastePatternsInFiles, scanFiles } from "../scanner/core-scanner";
import { createProject, getAllEndpoints, getAllSuggestions, submitScan } from "../api-client";
import { buildLocalScanResults, buildRemoteScanResults, shouldSubmitRemote, type FinalScanResults } from "../scan-results";
import { buildSnapshot } from "../intelligence/builder";
import { scoreSnapshot } from "../intelligence/scorer";
import { buildReviewClusters } from "../intelligence/clusters";
import { compressClusters } from "../intelligence/compression";
import { buildExportContext, formatAsJSON, formatAsMarkdown } from "../intelligence/export";

interface CliOptions {
  target: string;
  format: "json" | "summary" | "context";
}

interface CliResult {
  target: string;
  scannedFileCount: number;
  mode: "local-only" | "remote-enriched";
  projectId: string;
  scanId: string;
  local: {
    apiCalls: Awaited<ReturnType<typeof scanFiles>>;
    localWasteFindings: Awaited<ReturnType<typeof detectLocalWastePatternsInFiles>>;
    submittedRemoteApiCalls: Awaited<ReturnType<typeof scanFiles>>;
  };
  remote: null | {
    projectId: string;
    scanId: string;
    endpoints: FinalScanResults["endpoints"];
    suggestions: FinalScanResults["suggestions"];
    summary: FinalScanResults["summary"];
  };
  final: {
    endpoints: FinalScanResults["endpoints"];
    suggestions: FinalScanResults["suggestions"];
    summary: FinalScanResults["summary"];
  };
  endpoints: FinalScanResults["endpoints"];
  suggestions: FinalScanResults["suggestions"];
  summary: FinalScanResults["summary"];
}

function getFlag(args: string[], flag: string): string | null {
  const index = args.indexOf(flag);
  if (index === -1) return null;
  return args[index + 1] ?? null;
}

function printHelp(): void {
  process.stdout.write(
    [
      "Usage: node dist/cli/scan.js <file-or-directory> [--format json|summary|context]",
      "       node dist/cli/scan.js pack <directory> [--format markdown|json] [--output <file>] [--append-claude-md]",
      "",
      "Formats:",
      "  json     Full scan results as JSON (default)",
      "  summary  Human-readable summary of endpoints and issues",
      "  context  Intelligence context for coding agents (markdown)",
      "",
      "Pack subcommand:",
      "  Runs the full intelligence pipeline and outputs a review pack.",
      "  --format markdown|json   Output format (default: markdown)",
      "  --output <file>          Write output to file instead of stdout",
      "  --append-claude-md       Append output block to CLAUDE.md in the target directory",
      "",
      "Examples:",
      "  node dist/cli/scan.js src",
      "  node dist/cli/scan.js src --format summary",
      "  node dist/cli/scan.js . --format context",
      "  node dist/cli/scan.js pack src",
      "  node dist/cli/scan.js pack . --format json --output recost.json",
      "  node dist/cli/scan.js pack . --append-claude-md",
      "",
    ].join("\n")
  );
}

function parseArgs(argv: string[]): CliOptions | null {
  const args = [...argv];
  let target = "";
  let format: CliOptions["format"] = "json";

  while (args.length > 0) {
    const arg = args.shift();
    if (!arg) continue;
    if (arg === "--help" || arg === "-h") return null;
    if (arg === "--format") {
      const value = args.shift();
      if (value === "json" || value === "summary" || value === "context") {
        format = value;
        continue;
      }
      throw new Error(`Unsupported format: ${value ?? "(missing value)"}`);
    }
    if (!target) {
      target = arg;
      continue;
    }
    throw new Error(`Unexpected argument: ${arg}`);
  }

  if (!target) return null;
  return { target, format };
}

function writeSummary(result: CliResult): void {
  const lines = [
    `Target: ${result.target}`,
    `Files scanned: ${result.scannedFileCount}`,
    `Mode: ${result.mode}`,
    `Endpoints found: ${result.summary.totalEndpoints}`,
    `Issues found: ${result.suggestions.length}`,
    `Monthly cost: $${result.summary.totalMonthlyCost.toFixed(2)}`,
    `High-risk issues: ${result.summary.highRiskCount}`,
    "",
  ];

  if (result.endpoints.length > 0) {
    lines.push("Endpoints:");
    for (const endpoint of result.endpoints) {
      lines.push(`- ${endpoint.method} ${endpoint.url} (${endpoint.files.join(", ")})`);
    }
    lines.push("");
  }

  if (result.suggestions.length > 0) {
    lines.push("Issues:");
    for (const suggestion of result.suggestions) {
      lines.push(`- ${suggestion.type} ${suggestion.description}`);
    }
  }

  process.stdout.write(`${lines.join("\n")}\n`);
}

function resolveRcApiKey(): string | undefined {
  return process.env.RECOST_API_KEY?.trim() || process.env.RC_API_KEY?.trim();
}

async function runContextFormat(options: CliOptions, access: Awaited<ReturnType<typeof createFilesystemScanAccess>>): Promise<void> {
  const apiCalls = await scanFiles(access, (progress) => {
    process.stderr.write(`Scanning ${progress.file} (${progress.fileIndex}/${progress.fileTotal})\n`);
  });
  const findings = await detectLocalWastePatternsInFiles(access);

  process.stderr.write(`Building intelligence context (${apiCalls.length} API calls, ${findings.length} findings)...\n`);

  const repoRoot = path.resolve(options.target);
  const snapshot = buildSnapshot({ apiCalls, findings, repoRoot, totalFilesScanned: access.files.length });
  const scored = scoreSnapshot(snapshot);
  const clusters = buildReviewClusters(scored);
  const compressed = await compressClusters(clusters, snapshot);
  const exportContext = buildExportContext(compressed, snapshot, scored);
  const markdown = formatAsMarkdown(exportContext);

  process.stdout.write(markdown);
}

async function runPackCommand(
  dir: string,
  format: "markdown" | "json",
  outputPath: string | null,
  appendClaudeMd: boolean,
  access: Awaited<ReturnType<typeof createFilesystemScanAccess>>
): Promise<void> {
  const apiCalls = await scanFiles(access, (progress) => {
    process.stderr.write(`Scanning ${progress.file} (${progress.fileIndex}/${progress.fileTotal})\n`);
  });
  const findings = await detectLocalWastePatternsInFiles(access);

  process.stderr.write(`Building intelligence context (${apiCalls.length} API calls, ${findings.length} findings)...\n`);

  const snapshot = buildSnapshot({ apiCalls, findings, repoRoot: dir, totalFilesScanned: access.files.length });
  const scored = scoreSnapshot(snapshot);
  const clusters = buildReviewClusters(scored);
  const compressed = await compressClusters(clusters, snapshot);
  const context = buildExportContext(compressed, snapshot, scored);

  const content = format === "json" ? formatAsJSON(context) : formatAsMarkdown(context);

  if (outputPath) {
    fs.writeFileSync(path.resolve(dir, outputPath), content, "utf8");
  } else if (appendClaudeMd) {
    const claudeMdPath = path.resolve(dir, "CLAUDE.md");
    const block = `\n\n## ReCost Analysis\n\n${content}\n\n<!-- End ReCost Analysis -->`;
    fs.appendFileSync(claudeMdPath, block, "utf8");
  } else {
    process.stdout.write(content + "\n");
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  if (argv[0] === "pack") {
    const packArgs = argv.slice(1);
    const packFormat = (getFlag(packArgs, "--format") ?? "markdown") as "markdown" | "json";
    const outputPath = getFlag(packArgs, "--output");
    const appendClaudeMd = packArgs.includes("--append-claude-md");
    const dir = packArgs.find((a) => !a.startsWith("--") && a !== packFormat && a !== outputPath) ?? ".";
    const access = await createFilesystemScanAccess(dir);
    await runPackCommand(path.resolve(dir), packFormat, outputPath, appendClaudeMd, access);
    return;
  }

  const options = parseArgs(argv);
  if (!options) {
    printHelp();
    process.exitCode = 1;
    return;
  }

  const access = await createFilesystemScanAccess(options.target);

  if (options.format === "context") {
    await runContextFormat(options, access);
    return;
  }

  const apiCalls = await scanFiles(access, (progress) => {
    process.stderr.write(`Scanning ${progress.file} (${progress.fileIndex}/${progress.fileTotal})\n`);
  });
  const localWasteFindings = await detectLocalWastePatternsInFiles(access);
  let mode: CliResult["mode"] = "local-only";
  let projectId = "local";
  let scanId = newLocalScanId();
  let finalResults = buildLocalScanResults(apiCalls, localWasteFindings, projectId, scanId);

  const rcApiKey = resolveRcApiKey();
  const remoteApiCalls = apiCalls.filter(shouldSubmitRemote);
  let remoteResult: CliResult["remote"] = null;
  if (rcApiKey && remoteApiCalls.length > 0) {
    try {
      projectId = await createProject(path.basename(path.resolve(options.target)), rcApiKey);
      const remoteScan = await submitScan(projectId, remoteApiCalls, rcApiKey);
      scanId = remoteScan.scanId;
      const [remoteEndpoints, remoteSuggestions] = await Promise.all([
        getAllEndpoints(projectId, scanId, rcApiKey),
        getAllSuggestions(projectId, scanId, rcApiKey),
      ]);
      finalResults = buildRemoteScanResults(
        remoteEndpoints,
        remoteSuggestions,
        remoteScan.summary,
        apiCalls,
        localWasteFindings,
        projectId,
        scanId
      );
      remoteResult = {
        projectId,
        scanId,
        endpoints: remoteEndpoints,
        suggestions: remoteSuggestions,
        summary: remoteScan.summary,
      };
      mode = "remote-enriched";
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`Remote enrichment unavailable: ${message}. Falling back to local-only results.\n`);
    }
  }

  const result: CliResult = {
    target: path.resolve(options.target),
    scannedFileCount: access.files.length,
    mode,
    projectId,
    scanId,
    local: {
      apiCalls,
      localWasteFindings,
      submittedRemoteApiCalls: remoteApiCalls,
    },
    remote: remoteResult,
    final: {
      endpoints: finalResults.endpoints,
      suggestions: finalResults.suggestions,
      summary: finalResults.summary,
    },
    endpoints: finalResults.endpoints,
    suggestions: finalResults.suggestions,
    summary: finalResults.summary,
  };

  if (options.format === "summary") {
    writeSummary(result);
    return;
  }

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
