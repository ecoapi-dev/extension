import type { ExpectedJson, ExpectedFinding } from "./schema";

const LINE_TOLERANCE = 2;

export interface DetectedEndpoint {
  file: string;
  line: number;
  provider: string;
  method: string;
}

export interface DetectedFinding {
  file: string;
  line: number;
  type: string;
}

/** Raw TP/FP/FN counts for a single finding type, per fixture. */
export interface FindingTypeCounts {
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
}

/** Aggregated per-type counts plus derived precision/recall. */
export interface FindingTypeMetrics extends FindingTypeCounts {
  /** TP / (TP+FP); 1 when denominator is 0 (safeRatio convention). */
  precision: number;
  /** TP / (TP+FN); 1 when denominator is 0 (safeRatio convention). */
  recall: number;
}

/**
 * Return a copy of `byType` with keys inserted in alphabetical (by-name) order.
 * Used when writing `baseline.json` so committed diffs are stable: the metrics
 * builder inserts keys in fixture-iteration order, and the display sort
 * (`sortedTypeEntries`) orders by precision — either would reshuffle the keys
 * across runs. Sorting by name keeps the committed file deterministic.
 */
export function sortFindingMetricsByType(
  byType: Record<string, FindingTypeMetrics>
): Record<string, FindingTypeMetrics> {
  const sorted: Record<string, FindingTypeMetrics> = {};
  for (const key of Object.keys(byType).sort((a, b) => a.localeCompare(b))) {
    sorted[key] = byType[key];
  }
  return sorted;
}

export interface MetricsReport {
  detectionPrecision: number;
  detectionRecall: number;
  providerAttributionAccuracy: number;
  findingPrecision: number;
  findingRecall: number;
  /** Per-finding-type precision/recall aggregated across all fixtures. */
  findingMetricsByType: Record<string, FindingTypeMetrics>;
  /** Per-fixture breakdown, useful for diagnosing where a regression landed. */
  perFixture: PerFixtureMetrics[];
}

export interface PerFixtureMetrics {
  fixtureSlug: string;
  detectionPrecision: number;
  detectionRecall: number;
  providerAttributionAccuracy: number;
  findingPrecision: number;
  findingRecall: number;
  truePositiveEndpoints: number;
  falsePositiveEndpoints: number;
  falseNegativeEndpoints: number;
  truePositiveFindings: number;
  falsePositiveFindings: number;
  falseNegativeFindings: number;
  /** Number of expected endpoints with a same-file-line detection whose provider was not "unknown". */
  providerAttributionTotal: number;
  /** Of those, how many had the detected provider matching the expected provider. */
  providerAttributionCorrect: number;
  /**
   * Raw TP/FP/FN counts per finding type for this fixture. Empty record when neither
   * `expected.findings` nor `detectedFindings` contain any entries.
   */
  findingCountsByType: Record<string, FindingTypeCounts>;
}

/**
 * Compute metrics for a single fixture against its expected.json + scanner output.
 * Pure function — no I/O.
 *
 * Matching rules:
 *  - An expected endpoint matches a detected endpoint when file matches AND provider matches AND
 *    (method OR methodSignature equivalent) matches AND |detected.line - expected.line| <= 2.
 *  - When file+line match but provider differs, the detection is BOTH a false positive (wrong provider)
 *    AND a false negative (missed the expected entry).
 *  - Provider attribution accuracy: of the detected endpoints with provider !== "unknown" that matched
 *    something on file+line, what fraction got the provider right?
 *  - Findings: file + type + |line| <= 2 are matched. Same FP/FN logic.
 */
export function computeMetrics(
  expected: ExpectedJson,
  detected: DetectedEndpoint[],
  detectedFindings: DetectedFinding[]
): PerFixtureMetrics {
  const endpointMatch = matchPairs(
    expected.endpoints,
    detected,
    (e, d) => e.file === d.file && e.provider === d.provider && methodsEquivalent(e.method, d.method) && Math.abs(e.line - d.line) <= LINE_TOLERANCE,
  );

  // Provider attribution: any detected entry on the right file+line, regardless of provider, counts toward the denominator.
  let attributionCorrect = 0;
  let attributionTotal = 0;
  for (const e of expected.endpoints) {
    const sameFileLine = detected.find(d => d.file === e.file && Math.abs(d.line - e.line) <= LINE_TOLERANCE);
    if (sameFileLine && sameFileLine.provider !== "unknown") {
      attributionTotal += 1;
      if (sameFileLine.provider === e.provider) attributionCorrect += 1;
    }
  }

  const findingMatch = matchPairs(
    expected.findings,
    detectedFindings,
    (e, d) => e.file === d.file && e.type === d.type && Math.abs(e.line - d.line) <= LINE_TOLERANCE,
  );

  // Per-type counts: union the types observed in expected + detected, then re-run matchPairs
  // over each type-scoped subset. The existing matcher already requires e.type === d.type, so
  // segregating by type and rerunning gives the right TP/FP/FN counts per type.
  const findingCountsByType: Record<string, FindingTypeCounts> = {};
  const typeSet = new Set<string>();
  for (const e of expected.findings) typeSet.add(e.type);
  for (const d of detectedFindings) typeSet.add(d.type);
  for (const type of typeSet) {
    const expectedForType: ExpectedFinding[] = expected.findings.filter(e => e.type === type);
    const detectedForType: DetectedFinding[] = detectedFindings.filter(d => d.type === type);
    const result = matchPairs(
      expectedForType,
      detectedForType,
      (e, d) => e.file === d.file && e.type === d.type && Math.abs(e.line - d.line) <= LINE_TOLERANCE,
    );
    findingCountsByType[type] = {
      truePositives: result.truePositives,
      falsePositives: result.falsePositives,
      falseNegatives: result.falseNegatives,
    };
  }

  return {
    fixtureSlug: expected.fixtureSlug,
    detectionPrecision: safeRatio(endpointMatch.truePositives, endpointMatch.truePositives + endpointMatch.falsePositives),
    detectionRecall: safeRatio(endpointMatch.truePositives, endpointMatch.truePositives + endpointMatch.falseNegatives),
    providerAttributionAccuracy: attributionTotal === 0 ? 1 : attributionCorrect / attributionTotal,
    findingPrecision: safeRatio(findingMatch.truePositives, findingMatch.truePositives + findingMatch.falsePositives),
    findingRecall: safeRatio(findingMatch.truePositives, findingMatch.truePositives + findingMatch.falseNegatives),
    truePositiveEndpoints: endpointMatch.truePositives,
    falsePositiveEndpoints: endpointMatch.falsePositives,
    falseNegativeEndpoints: endpointMatch.falseNegatives,
    truePositiveFindings: findingMatch.truePositives,
    falsePositiveFindings: findingMatch.falsePositives,
    falseNegativeFindings: findingMatch.falseNegatives,
    providerAttributionTotal: attributionTotal,
    providerAttributionCorrect: attributionCorrect,
    findingCountsByType,
  };
}

/** Aggregate per-fixture metrics into a global report. */
export function aggregate(perFixture: PerFixtureMetrics[]): MetricsReport {
  const sum = perFixture.reduce(
    (acc, m) => ({
      tpE: acc.tpE + m.truePositiveEndpoints,
      fpE: acc.fpE + m.falsePositiveEndpoints,
      fnE: acc.fnE + m.falseNegativeEndpoints,
      tpF: acc.tpF + m.truePositiveFindings,
      fpF: acc.fpF + m.falsePositiveFindings,
      fnF: acc.fnF + m.falseNegativeFindings,
      attCorrect: acc.attCorrect + m.providerAttributionCorrect,
      attTotal: acc.attTotal + m.providerAttributionTotal,
    }),
    { tpE: 0, fpE: 0, fnE: 0, tpF: 0, fpF: 0, fnF: 0, attCorrect: 0, attTotal: 0 },
  );

  // Sum TP/FP/FN per finding type across all fixtures, then derive precision/recall.
  const typeTotals: Record<string, FindingTypeCounts> = {};
  for (const m of perFixture) {
    for (const [type, counts] of Object.entries(m.findingCountsByType)) {
      const acc = typeTotals[type] ?? { truePositives: 0, falsePositives: 0, falseNegatives: 0 };
      acc.truePositives += counts.truePositives;
      acc.falsePositives += counts.falsePositives;
      acc.falseNegatives += counts.falseNegatives;
      typeTotals[type] = acc;
    }
  }
  const findingMetricsByType: Record<string, FindingTypeMetrics> = {};
  for (const [type, counts] of Object.entries(typeTotals)) {
    findingMetricsByType[type] = {
      truePositives: counts.truePositives,
      falsePositives: counts.falsePositives,
      falseNegatives: counts.falseNegatives,
      precision: safeRatio(counts.truePositives, counts.truePositives + counts.falsePositives),
      recall: safeRatio(counts.truePositives, counts.truePositives + counts.falseNegatives),
    };
  }

  return {
    detectionPrecision: safeRatio(sum.tpE, sum.tpE + sum.fpE),
    detectionRecall: safeRatio(sum.tpE, sum.tpE + sum.fnE),
    providerAttributionAccuracy: sum.attTotal === 0 ? 1 : sum.attCorrect / sum.attTotal,
    findingPrecision: safeRatio(sum.tpF, sum.tpF + sum.fpF),
    findingRecall: safeRatio(sum.tpF, sum.tpF + sum.fnF),
    findingMetricsByType,
    perFixture,
  };
}

interface MatchResult { truePositives: number; falsePositives: number; falseNegatives: number; }

function matchPairs<E, D>(expected: E[], detected: D[], match: (e: E, d: D) => boolean): MatchResult {
  const expectedMatched = new Array<boolean>(expected.length).fill(false);
  const detectedMatched = new Array<boolean>(detected.length).fill(false);

  for (let ei = 0; ei < expected.length; ei++) {
    for (let di = 0; di < detected.length; di++) {
      if (detectedMatched[di]) continue;
      if (match(expected[ei], detected[di])) {
        expectedMatched[ei] = true;
        detectedMatched[di] = true;
        break;
      }
    }
  }

  const truePositives = expectedMatched.filter(Boolean).length;
  const falsePositives = detectedMatched.filter(m => !m).length;
  const falseNegatives = expectedMatched.filter(m => !m).length;
  return { truePositives, falsePositives, falseNegatives };
}

function safeRatio(numerator: number, denominator: number): number {
  if (denominator === 0) return 1;
  return numerator / denominator;
}

/**
 * Methods are considered equivalent if either:
 *  - exact string match
 *  - both refer to the same SDK chain regardless of separator (defensive — fixture authors might use "." or " ")
 *  - one is a dot-suffix of the other (e.g. fixture: "chat.completions.create",
 *    scanner output: "client.chat.completions.create"). The AST scanner emits the
 *    full receiver chain ("client.foo.bar.baz"); fixtures typically omit the receiver.
 */
function methodsEquivalent(a: string, b: string): boolean {
  if (a === b) return true;
  const na = normalize(a);
  const nb = normalize(b);
  if (na === nb) return true;
  if (na.length > 0 && nb.length > 0) {
    if (na.endsWith("." + nb)) return true;
    if (nb.endsWith("." + na)) return true;
  }
  return false;
}

function normalize(s: string): string {
  return s.replace(/\s+/g, "").toLowerCase();
}
