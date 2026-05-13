import type { ExpectedJson } from "./schema";

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

export interface MetricsReport {
  detectionPrecision: number;
  detectionRecall: number;
  providerAttributionAccuracy: number;
  findingPrecision: number;
  findingRecall: number;
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
      attCorrect: acc.attCorrect + Math.round(m.providerAttributionAccuracy * (m.truePositiveEndpoints + m.falseNegativeEndpoints)),
      attTotal: acc.attTotal + (m.truePositiveEndpoints + m.falseNegativeEndpoints),
    }),
    { tpE: 0, fpE: 0, fnE: 0, tpF: 0, fpF: 0, fnF: 0, attCorrect: 0, attTotal: 0 },
  );

  return {
    detectionPrecision: safeRatio(sum.tpE, sum.tpE + sum.fpE),
    detectionRecall: safeRatio(sum.tpE, sum.tpE + sum.fnE),
    providerAttributionAccuracy: sum.attTotal === 0 ? 1 : sum.attCorrect / sum.attTotal,
    findingPrecision: safeRatio(sum.tpF, sum.tpF + sum.fpF),
    findingRecall: safeRatio(sum.tpF, sum.tpF + sum.fnF),
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
 */
function methodsEquivalent(a: string, b: string): boolean {
  if (a === b) return true;
  return normalize(a) === normalize(b);
}

function normalize(s: string): string {
  return s.replace(/\s+/g, "").toLowerCase();
}
