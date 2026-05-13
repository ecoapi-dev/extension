import assert from "node:assert/strict";
import { validateExpectedJson, ExpectedJsonValidationError } from "../../benchmark/schema";

async function run(name: string, fn: () => void | Promise<void>): Promise<void> {
  try { await fn(); console.log(`PASS ${name}`); }
  catch (err) { console.error(`FAIL ${name}`); throw err; }
}

(async () => {
  await run("accepts a minimal valid expected.json", () => {
    const value = {
      schemaVersion: 1,
      fixtureSlug: "x",
      endpoints: [
        { file: "a.ts", line: 5, provider: "openai", method: "chat.completions.create", must_detect: true },
      ],
      findings: [],
    };
    const parsed = validateExpectedJson(value, "x");
    assert.equal(parsed.endpoints.length, 1);
    assert.equal(parsed.endpoints[0].provider, "openai");
  });

  await run("rejects wrong schemaVersion", () => {
    assert.throws(
      () => validateExpectedJson({ schemaVersion: 2, fixtureSlug: "x", endpoints: [], findings: [] }, "x"),
      ExpectedJsonValidationError
    );
  });

  await run("rejects non-integer line numbers", () => {
    assert.throws(
      () => validateExpectedJson({
        schemaVersion: 1,
        fixtureSlug: "x",
        endpoints: [{ file: "a.ts", line: 5.5, provider: "openai", method: "m", must_detect: true }],
        findings: [],
      }, "x"),
      ExpectedJsonValidationError
    );
  });

  await run("rejects must_detect not equal to true", () => {
    assert.throws(
      () => validateExpectedJson({
        schemaVersion: 1,
        fixtureSlug: "x",
        endpoints: [{ file: "a.ts", line: 1, provider: "openai", method: "m", must_detect: false }],
        findings: [],
      }, "x"),
      ExpectedJsonValidationError
    );
  });

  await run("preserves optional fields", () => {
    const parsed = validateExpectedJson({
      schemaVersion: 1,
      fixtureSlug: "x",
      endpoints: [{ file: "a.ts", function: "f", line: 1, provider: "openai", method: "m", must_detect: true, notes: "n" }],
      findings: [],
    }, "x");
    assert.equal(parsed.endpoints[0].function, "f");
    assert.equal(parsed.endpoints[0].notes, "n");
  });

  await run("rejects missing fields", () => {
    assert.throws(
      () => validateExpectedJson({ schemaVersion: 1, fixtureSlug: "x", endpoints: [{}], findings: [] }, "x"),
      ExpectedJsonValidationError
    );
  });
})().catch((err) => { console.error(err); process.exit(1); });
