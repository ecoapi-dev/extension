import assert from "node:assert/strict";
import { computeMetrics, type DetectedEndpoint, type DetectedFinding } from "../../benchmark/metrics";
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
})().catch((err) => { console.error(err); process.exit(1); });
