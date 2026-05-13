import type { MetricsReport, FindingTypeMetrics } from "./metrics";

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
  const typeEntries = sortedTypeEntries(current.findingMetricsByType);
  if (typeEntries.length > 0) {
    lines.push("\nPer finding type:");
    const baselineByType = baseline?.findingMetricsByType ?? {};
    for (const [type, m] of typeEntries) {
      const prec = (m.precision * 100).toFixed(1).padStart(5);
      const rec = (m.recall * 100).toFixed(1).padStart(5);
      let row = `  ${type.padEnd(22)} TP ${m.truePositives}  FP ${m.falsePositives}  FN ${m.falseNegatives}   precision ${prec}%  recall ${rec}%`;
      const base = baselineByType[type];
      if (baseline && base) {
        const deltaPp = (m.precision - base.precision) * 100;
        const sign = deltaPp >= 0 ? "+" : "";
        row += `  Δ ${sign}${deltaPp.toFixed(2)}pp`;
      }
      lines.push(row);
    }
  }
  return lines.join("\n");
}

function sortedTypeEntries(byType: Record<string, FindingTypeMetrics> | undefined): Array<[string, FindingTypeMetrics]> {
  if (!byType) return [];
  const entries = Object.entries(byType);
  // Sort by precision ascending (worst first), then by type name for stable ordering.
  entries.sort((a, b) => {
    if (a[1].precision !== b[1].precision) return a[1].precision - b[1].precision;
    return a[0].localeCompare(b[0]);
  });
  return entries;
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
  const typeEntries = sortedTypeEntries(current.findingMetricsByType);
  if (typeEntries.length > 0) {
    lines.push("", "### Finding precision by type", "");
    const baselineByType = baseline?.findingMetricsByType ?? {};
    if (baseline) {
      lines.push("| Type | TP | FP | FN | Precision | Recall | Δ Precision (pp) |");
      lines.push("|---|---|---|---|---|---|---|");
    } else {
      lines.push("| Type | TP | FP | FN | Precision | Recall |");
      lines.push("|---|---|---|---|---|---|");
    }
    for (const [type, m] of typeEntries) {
      const prec = (m.precision * 100).toFixed(2) + "%";
      const rec = (m.recall * 100).toFixed(2) + "%";
      if (baseline) {
        const base = baselineByType[type];
        let delta = "";
        if (base) {
          const deltaPp = (m.precision - base.precision) * 100;
          const sign = deltaPp >= 0 ? "+" : "";
          delta = `${sign}${deltaPp.toFixed(2)}`;
        }
        lines.push(`| ${type} | ${m.truePositives} | ${m.falsePositives} | ${m.falseNegatives} | ${prec} | ${rec} | ${delta} |`);
      } else {
        lines.push(`| ${type} | ${m.truePositives} | ${m.falsePositives} | ${m.falseNegatives} | ${prec} | ${rec} |`);
      }
    }
  }
  return lines.join("\n");
}
