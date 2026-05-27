import assert from "node:assert/strict";
import { sortFindingMetricsByType, type FindingTypeMetrics } from "../../benchmark/metrics";

async function run(name: string, fn: () => void | Promise<void>): Promise<void> {
  try { await fn(); console.log(`PASS ${name}`); }
  catch (err) { console.error(`FAIL ${name}`); throw err; }
}

function tm(overrides: Partial<FindingTypeMetrics> = {}): FindingTypeMetrics {
  return { truePositives: 0, falsePositives: 0, falseNegatives: 0, precision: 1, recall: 0, ...overrides };
}

(async () => {
  await run("sortFindingMetricsByType orders keys alphabetically regardless of input order", () => {
    // Insertion order matches the real metrics builder (fixture-iteration order, not sorted).
    const input: Record<string, FindingTypeMetrics> = {
      n_plus_one: tm({ truePositives: 1, recall: 1 }),
      batch: tm({ falseNegatives: 1 }),
      unbatched_parallel: tm({ falseNegatives: 1 }),
    };
    const sorted = sortFindingMetricsByType(input);
    assert.deepEqual(Object.keys(sorted), ["batch", "n_plus_one", "unbatched_parallel"]);
  });

  await run("sortFindingMetricsByType preserves each entry's values exactly", () => {
    const input: Record<string, FindingTypeMetrics> = {
      zeta: tm({ truePositives: 3, falsePositives: 2, precision: 0.6 }),
      alpha: tm({ truePositives: 1, falseNegatives: 4, recall: 0.2 }),
    };
    const sorted = sortFindingMetricsByType(input);
    assert.deepEqual(Object.keys(sorted), ["alpha", "zeta"]);
    assert.deepEqual(sorted.alpha, input.alpha);
    assert.deepEqual(sorted.zeta, input.zeta);
  });

  await run("sortFindingMetricsByType is stable under precision changes (sorts by name, not precision)", () => {
    // The display sort orders by precision; the baseline file must sort by NAME so a
    // precision shift never reorders the committed keys.
    const input: Record<string, FindingTypeMetrics> = {
      batch: tm({ precision: 0.9 }),
      alpha: tm({ precision: 0.1 }),
    };
    assert.deepEqual(Object.keys(sortFindingMetricsByType(input)), ["alpha", "batch"]);
  });
})().catch((err) => { console.error(err); process.exit(1); });
