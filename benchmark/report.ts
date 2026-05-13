import type { MetricsReport } from "./metrics";

const METRIC_LABELS: Record<string, string> = {
  detectionPrecision: "Detection precision",
  detectionRecall: "Detection recall",
  providerAttributionAccuracy: "Provider attribution",
  findingPrecision: "Finding precision",
  findingRecall: "Finding recall",
};

const METRIC_KEYS = [
  "detectionPrecision",
  "detectionRecall",
  "providerAttributionAccuracy",
  "findingPrecision",
  "findingRecall",
] as const;

export function formatConsoleReport(current: MetricsReport, baseline: MetricsReport | null): string {
  const lines = ["", "=== Benchmark Report ==="];
  for (const k of METRIC_KEYS) {
    const cur = (current[k] * 100).toFixed(2);
    if (baseline) {
      const base = (baseline[k] * 100).toFixed(2);
      const deltaPp = ((current[k] - baseline[k]) * 100).toFixed(2);
      const sign = current[k] >= baseline[k] ? "+" : "";
      lines.push(`  ${METRIC_LABELS[k].padEnd(24)} ${cur}%  (baseline ${base}%, Δ ${sign}${deltaPp}pp)`);
    } else {
      lines.push(`  ${METRIC_LABELS[k].padEnd(24)} ${cur}%`);
    }
  }
  if (current.perFixture.length > 0) {
    lines.push("\nPer fixture:");
    for (const f of current.perFixture) {
      lines.push(`  [${f.fixtureSlug}] det P/R ${(f.detectionPrecision * 100).toFixed(1)}/${(f.detectionRecall * 100).toFixed(1)} | find P/R ${(f.findingPrecision * 100).toFixed(1)}/${(f.findingRecall * 100).toFixed(1)} | TP/FP/FN endpoints ${f.truePositiveEndpoints}/${f.falsePositiveEndpoints}/${f.falseNegativeEndpoints}`);
    }
  }
  return lines.join("\n");
}

export function formatMarkdownReport(current: MetricsReport, baseline: MetricsReport | null): string {
  const lines = ["## Benchmark Report", ""];
  lines.push("| Metric | Current | Baseline | Δ (pp) |");
  lines.push("|---|---|---|---|");
  for (const k of METRIC_KEYS) {
    const cur = (current[k] * 100).toFixed(2) + "%";
    if (baseline) {
      const base = (baseline[k] * 100).toFixed(2) + "%";
      const delta = ((current[k] - baseline[k]) * 100).toFixed(2);
      const sign = current[k] >= baseline[k] ? "+" : "";
      lines.push(`| ${METRIC_LABELS[k]} | ${cur} | ${base} | ${sign}${delta} |`);
    } else {
      lines.push(`| ${METRIC_LABELS[k]} | ${cur} | — | — |`);
    }
  }
  if (current.perFixture.length > 0) {
    lines.push("", "### Per fixture", "", "| Fixture | Det P | Det R | Find P | Find R | TP/FP/FN endpoints |", "|---|---|---|---|---|---|");
    for (const f of current.perFixture) {
      const pct = (n: number) => (n * 100).toFixed(1) + "%";
      lines.push(`| ${f.fixtureSlug} | ${pct(f.detectionPrecision)} | ${pct(f.detectionRecall)} | ${pct(f.findingPrecision)} | ${pct(f.findingRecall)} | ${f.truePositiveEndpoints}/${f.falsePositiveEndpoints}/${f.falseNegativeEndpoints} |`);
    }
  }
  return lines.join("\n");
}
