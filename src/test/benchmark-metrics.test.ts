import assert from "node:assert/strict";
import { computeMetrics, type DetectedEndpoint, type DetectedFinding, type PerFixtureMetrics } from "../../benchmark/metrics";
import type { ExpectedJson } from "../../benchmark/schema";

async function run(name: string, fn: () => void | Promise<void>): Promise<void> {
  try { await fn(); console.log(`PASS ${name}`); }
  catch (err) { console.error(`FAIL ${name}`); throw err; }
}

function expectedFixture(endpoints: ExpectedJson["endpoints"], findings: ExpectedJson["findings"] = []): ExpectedJson {
  return { schemaVersion: 1, fixtureSlug: "test", endpoints, findings };
}

(async () => {
  await run("exact endpoint match gives 100% precision and recall", () => {
    const expected = expectedFixture([
      { file: "a.ts", line: 5, provider: "openai", method: "chat.completions.create", must_detect: true },
    ]);
    const detected: DetectedEndpoint[] = [
      { file: "a.ts", line: 5, provider: "openai", method: "chat.completions.create" },
    ];
    const m = computeMetrics(expected, detected, []);
    assert.equal(m.detectionPrecision, 1);
    assert.equal(m.detectionRecall, 1);
    assert.equal(m.providerAttributionAccuracy, 1);
  });

  await run("line tolerance ±2 still matches", () => {
    const expected = expectedFixture([
      { file: "a.ts", line: 10, provider: "openai", method: "chat.completions.create", must_detect: true },
    ]);
    const detected: DetectedEndpoint[] = [
      { file: "a.ts", line: 12, provider: "openai", method: "chat.completions.create" },
    ];
    const m = computeMetrics(expected, detected, []);
    assert.equal(m.detectionRecall, 1);
  });

  await run("line tolerance >2 does NOT match", () => {
    const expected = expectedFixture([
      { file: "a.ts", line: 10, provider: "openai", method: "chat.completions.create", must_detect: true },
    ]);
    const detected: DetectedEndpoint[] = [
      { file: "a.ts", line: 13, provider: "openai", method: "chat.completions.create" },
    ];
    const m = computeMetrics(expected, detected, []);
    assert.equal(m.detectionRecall, 0);
  });

  await run("false positive lowers precision", () => {
    const expected = expectedFixture([
      { file: "a.ts", line: 5, provider: "openai", method: "chat.completions.create", must_detect: true },
    ]);
    const detected: DetectedEndpoint[] = [
      { file: "a.ts", line: 5, provider: "openai", method: "chat.completions.create" },
      { file: "b.ts", line: 99, provider: "stripe", method: "charges.create" }, // not expected
    ];
    const m = computeMetrics(expected, detected, []);
    assert.equal(m.detectionPrecision, 0.5);
    assert.equal(m.detectionRecall, 1);
  });

  await run("missed expected lowers recall", () => {
    const expected = expectedFixture([
      { file: "a.ts", line: 5, provider: "openai", method: "chat.completions.create", must_detect: true },
      { file: "b.ts", line: 6, provider: "stripe", method: "charges.create", must_detect: true },
    ]);
    const detected: DetectedEndpoint[] = [
      { file: "a.ts", line: 5, provider: "openai", method: "chat.completions.create" },
    ];
    const m = computeMetrics(expected, detected, []);
    assert.equal(m.detectionRecall, 0.5);
    assert.equal(m.detectionPrecision, 1);
  });

  await run("provider mismatch counts against attribution but file+line still recall-credits", () => {
    const expected = expectedFixture([
      { file: "a.ts", line: 5, provider: "openai", method: "chat.completions.create", must_detect: true },
    ]);
    const detected: DetectedEndpoint[] = [
      { file: "a.ts", line: 5, provider: "unknown", method: "chat.completions.create" },
    ];
    const m = computeMetrics(expected, detected, []);
    // The detected entry attributed to wrong provider isn't a true match for endpoint precision/recall,
    // but it IS a precision miss (we predicted "unknown" when ground truth is "openai").
    assert.equal(m.detectionRecall, 0); // expected is missed because providers don't agree
    assert.equal(m.detectionPrecision, 0); // detected is wrong because no expected matches
  });

  await run("finding precision and recall computed correctly", () => {
    const expected = expectedFixture(
      [],
      [{ file: "a.ts", line: 10, type: "n_plus_one", is_true_positive: true }]
    );
    const detected: DetectedEndpoint[] = [];
    const detectedFindings: DetectedFinding[] = [
      { file: "a.ts", line: 10, type: "n_plus_one" },
      { file: "b.ts", line: 5, type: "unbounded_loop" }, // false positive
    ];
    const m = computeMetrics(expected, detected, detectedFindings);
    assert.equal(m.findingPrecision, 0.5);
    assert.equal(m.findingRecall, 1);
  });

  await run("empty inputs return NaN-free metrics", () => {
    const m = computeMetrics(expectedFixture([], []), [], []);
    assert.equal(m.detectionPrecision, 1); // by convention: nothing detected, nothing expected → perfect
    assert.equal(m.detectionRecall, 1);
    assert.equal(m.findingPrecision, 1);
    assert.equal(m.findingRecall, 1);
  });

  await run("methodsEquivalent dot-suffix: fixture's bare chain matches scanner's receiver-prefixed chain", () => {
    const expected = expectedFixture([
      { file: "a.ts", line: 5, provider: "openai", method: "chat.completions.create", must_detect: true },
    ]);
    const detected: DetectedEndpoint[] = [
      { file: "a.ts", line: 5, provider: "openai", method: "client.chat.completions.create" },
    ];
    const m = computeMetrics(expected, detected, []);
    assert.equal(m.detectionRecall, 1);
    assert.equal(m.detectionPrecision, 1);
  });

  await run("methodsEquivalent does NOT match unrelated method chains sharing a trailing suffix", () => {
    // "create" is not a suffix-match of "client.chat.completions.create" — the boundary check requires "." before the candidate.
    // But a fixture's "foo.create" should NOT match a scanner's "bar.create" — they share only the leaf, not a dot-bounded segment from the same parent.
    const expected = expectedFixture([
      { file: "a.ts", line: 5, provider: "openai", method: "completions.create", must_detect: true },
    ]);
    const detected: DetectedEndpoint[] = [
      { file: "a.ts", line: 5, provider: "openai", method: "embeddings.create" },
    ];
    const m = computeMetrics(expected, detected, []);
    assert.equal(m.detectionRecall, 0);
    assert.equal(m.detectionPrecision, 0);
  });

  await run("per-type counts: each finding type tracked separately", () => {
    const expected = expectedFixture(
      [],
      [
        { file: "a.ts", line: 10, type: "n_plus_one", is_true_positive: true },
        { file: "a.ts", line: 20, type: "cache",      is_true_positive: true },
      ],
    );
    const detectedFindings: DetectedFinding[] = [
      { file: "a.ts", line: 10, type: "n_plus_one" },           // TP
      { file: "a.ts", line: 99, type: "n_plus_one" },           // FP
      { file: "a.ts", line: 20, type: "cache" },                // TP
      { file: "b.ts", line: 7,  type: "unbounded_loop" },       // FP (type not in expected)
    ];
    const m = computeMetrics(expected, [], detectedFindings);
    assert.equal(m.findingCountsByType.n_plus_one.truePositives, 1);
    assert.equal(m.findingCountsByType.n_plus_one.falsePositives, 1);
    assert.equal(m.findingCountsByType.cache.truePositives, 1);
    assert.equal(m.findingCountsByType.cache.falsePositives, 0);
    assert.equal(m.findingCountsByType.unbounded_loop.truePositives, 0);
    assert.equal(m.findingCountsByType.unbounded_loop.falsePositives, 1);
  });

  await run("per-type counts: false negative counted by expected.type", () => {
    const expected = expectedFixture(
      [],
      [{ file: "a.ts", line: 10, type: "n_plus_one", is_true_positive: true }],
    );
    const m = computeMetrics(expected, [], []);
    assert.equal(m.findingCountsByType.n_plus_one.falseNegatives, 1);
    assert.equal(m.findingCountsByType.n_plus_one.truePositives, 0);
  });

  await run("aggregate computes per-type precision and recall correctly", async () => {
    const { aggregate } = await import("../../benchmark/metrics");
    const perFixture: PerFixtureMetrics[] = [
      {
        fixtureSlug: "f1",
        detectionPrecision: 1, detectionRecall: 1, providerAttributionAccuracy: 1,
        findingPrecision: 1, findingRecall: 1,
        truePositiveEndpoints: 0, falsePositiveEndpoints: 0, falseNegativeEndpoints: 0,
        truePositiveFindings: 1, falsePositiveFindings: 1, falseNegativeFindings: 0,
        providerAttributionTotal: 0, providerAttributionCorrect: 0,
        findingCountsByType: {
          n_plus_one: { truePositives: 1, falsePositives: 0, falseNegatives: 0 },
          cache:      { truePositives: 0, falsePositives: 1, falseNegatives: 0 },
        },
      },
      {
        fixtureSlug: "f2",
        detectionPrecision: 1, detectionRecall: 1, providerAttributionAccuracy: 1,
        findingPrecision: 1, findingRecall: 1,
        truePositiveEndpoints: 0, falsePositiveEndpoints: 0, falseNegativeEndpoints: 0,
        truePositiveFindings: 0, falsePositiveFindings: 1, falseNegativeFindings: 1,
        providerAttributionTotal: 0, providerAttributionCorrect: 0,
        findingCountsByType: {
          n_plus_one: { truePositives: 0, falsePositives: 1, falseNegatives: 1 },
        },
      },
    ];
    const report = aggregate(perFixture);
    assert.equal(report.findingMetricsByType.n_plus_one.truePositives, 1);
    assert.equal(report.findingMetricsByType.n_plus_one.falsePositives, 1);
    assert.equal(report.findingMetricsByType.n_plus_one.falseNegatives, 1);
    assert.equal(report.findingMetricsByType.n_plus_one.precision, 0.5);
    assert.equal(report.findingMetricsByType.n_plus_one.recall, 0.5);
    // cache: 0 TP, 1 FP, 0 FN → precision 0 (TP/(TP+FP)=0/1), recall 1 (denominator zero, safeRatio convention)
    assert.equal(report.findingMetricsByType.cache.precision, 0);
    assert.equal(report.findingMetricsByType.cache.recall, 1);
  });

  await run("empty per-type counts: no types observed yields empty record", () => {
    const m = computeMetrics(expectedFixture([], []), [], []);
    assert.deepEqual(m.findingCountsByType, {});
  });
})().catch((err) => { console.error(err); process.exit(1); });
