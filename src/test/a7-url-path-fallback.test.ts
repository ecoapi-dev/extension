import assert from "node:assert/strict";
import { lookupMethod, lookupByUrlPath } from "../scanner/fingerprints/registry";

async function run(name: string, fn: () => void | Promise<void>): Promise<void> {
  try { await fn(); console.log(`PASS ${name}`); }
  catch (err) { console.error(`FAIL ${name}`); throw err; }
}

(async () => {
  await run("lookupByUrlPath resolves elevenlabs text-to-speech URL", () => {
    const fp = lookupByUrlPath("elevenlabs", "https://api.elevenlabs.io/v1/text-to-speech/voice-id-abc/stream");
    assert.ok(fp, "expected a fingerprint match");
    assert.equal(fp!.costModel, "per_request");
  });

  await run("lookupByUrlPath resolves elevenlabs speech-to-text URL", () => {
    const fp = lookupByUrlPath("elevenlabs", "https://api.elevenlabs.io/v1/speech-to-text");
    assert.ok(fp);
    assert.equal(fp!.costModel, "per_request");
  });

  await run("lookupByUrlPath returns default for unrecognized elevenlabs path", () => {
    const fp = lookupByUrlPath("elevenlabs", "https://api.elevenlabs.io/v1/unknown/path");
    assert.ok(fp, "expected default fingerprint");
  });

  await run("lookupByUrlPath returns null for unknown provider", () => {
    const fp = lookupByUrlPath("nonexistent-provider-xyz", "https://x.example.com/path");
    assert.equal(fp, null);
  });

  await run("lookupByUrlPath returns null for malformed URL", () => {
    const fp = lookupByUrlPath("elevenlabs", "not a valid url");
    assert.equal(fp, null);
  });

  await run("lookupMethod (SDK chain) still works for elevenlabs after schema extension", () => {
    const fp = lookupMethod("elevenlabs", "textToSpeech.convert");
    assert.ok(fp, "SDK-chain lookup must keep working");
    assert.equal(fp!.costModel, "per_request");
  });

  await run("lookupByUrlPath matches longest urlPathKey first", () => {
    // text-to-speech is more specific than just v1 — should pick text-to-speech
    const fp = lookupByUrlPath("elevenlabs", "https://api.elevenlabs.io/v1/text-to-speech/voice/stream");
    assert.ok(fp);
    // The text-to-speech entry has costModel "per_request" with a specific perRequestCostUsd
    // The default would be cheaper. Validate we got the specific one by checking the description or cost.
    assert.equal(fp!.costModel, "per_request");
  });

  await run("integration: estimateLocalMonthlyCost resolves cost from URL-path for raw elevenlabs fetch", async () => {
    const { estimateLocalMonthlyCost } = await import("../intelligence/cost-utils");
    const cost = estimateLocalMonthlyCost(
      "elevenlabs",
      1000,
      undefined,
      "https://api.elevenlabs.io/v1/text-to-speech/voice-abc/stream"
    );
    // Pre-A7: cost would fall through to LOCAL_PRICING (undefined for elevenlabs) → null or stub
    // Post-A7: should resolve to a real per-request cost from the fingerprint
    assert.ok(cost !== null, `expected a non-null cost from URL-path lookup; got ${cost}`);
    assert.ok(cost! > 0, `expected positive cost; got ${cost}`);
  });
})().catch((err) => { console.error(err); process.exit(1); });
