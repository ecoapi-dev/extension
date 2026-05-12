import assert from "node:assert/strict";
import {
  buildKeyFingerprint,
  buildKeyStatusSummary,
  getKeyService,
  listKeyServices,
  maskKeyPreview,
} from "../key-management";

function makeSecrets(map: Record<string, string | undefined> = {}) {
  return {
    get: async (key: string): Promise<string | undefined> => map[key],
  };
}

async function runTests() {
  // ---- listKeyServices ----
  // listKeyServices returns recost and the seven chat providers
  {
    const services = listKeyServices();
    const ids = services.map((s) => s.serviceId).sort();
    for (const expected of [
      "recost",
      "openai",
      "anthropic",
      "gemini",
      "xai",
      "cohere",
      "mistral",
      "perplexity",
    ]) {
      assert.ok(
        ids.includes(expected as never),
        `missing service ${expected}; got ${ids.join(",")}`
      );
    }
    // recost should be present first in the original (unsorted) order
    assert.equal(listKeyServices()[0]?.serviceId, "recost");
    // every descriptor exposes the expected required fields
    for (const svc of services) {
      assert.ok(svc.serviceId, "serviceId missing");
      assert.ok(svc.displayName.length > 0, `displayName empty for ${svc.serviceId}`);
      assert.ok(svc.kind === "recost" || svc.kind === "provider");
      assert.equal(typeof svc.supportsTest, "boolean");
    }
  }

  // ---- getKeyService ----
  // getKeyService("recost") returns the recost descriptor
  {
    const svc = getKeyService("recost");
    assert.equal(svc.serviceId, "recost");
    assert.equal(svc.kind, "recost");
    assert.ok(svc.displayName.length > 0);
    assert.equal(svc.secretStorageKey, "recost.apiKey");
  }
  // getKeyService("openai") returns a provider descriptor
  {
    const svc = getKeyService("openai");
    assert.equal(svc.serviceId, "openai");
    assert.equal(svc.kind, "provider");
    assert.equal(svc.providerId, "openai");
  }
  // getKeyService throws on unknown service id
  {
    assert.throws(
      () => getKeyService("not-a-real-service" as never),
      /Unsupported key service/
    );
  }

  // ---- maskKeyPreview ----
  // maskKeyPreview hides everything past a small prefix
  {
    const input = "rc-abcdef1234567890";
    const masked = maskKeyPreview(input);
    assert.ok(typeof masked === "string", "expected string for non-empty input");
    assert.notEqual(masked, input);
    // The actual implementation uses Unicode bullets (•), not ASCII dots.
    assert.match(masked!, /•/);
    // First few characters of the original key should still be visible as a prefix hint.
    assert.ok(masked!.startsWith("rc-abc"), `expected prefix 'rc-abc', got ${masked}`);
  }
  // maskKeyPreview(undefined) returns undefined (it is `string | undefined`, not always string)
  {
    const masked = maskKeyPreview(undefined);
    assert.equal(masked, undefined);
  }
  // maskKeyPreview("   ") (whitespace-only) returns undefined as well
  {
    const masked = maskKeyPreview("   ");
    assert.equal(masked, undefined);
  }

  // ---- buildKeyFingerprint ----
  // Deterministic, distinct for distinct inputs, and not the raw secret.
  {
    const fp1 = buildKeyFingerprint("rc-secret");
    const fp2 = buildKeyFingerprint("rc-secret");
    const fp3 = buildKeyFingerprint("rc-different");
    assert.equal(fp1, fp2, "fingerprint must be deterministic");
    assert.notEqual(fp1, fp3, "different inputs must produce different fingerprints");
    assert.notEqual(fp1, "rc-secret", "fingerprint must not equal the raw secret");
    // sha256 hex is 64 chars
    assert.equal(fp1.length, 64);
    assert.match(fp1, /^[0-9a-f]{64}$/);
  }

  // ---- buildKeyStatusSummary ----
  // NOTE: The actual signature is buildKeyStatusSummary(service, secrets, validationState?)
  // and it is async. We adapt the test to match the real API.
  // Case 1: no env var, no stored secret -> source "missing", state "missing".
  {
    const svc = getKeyService("openai");
    // Ensure the env var (if any) is unset for this test.
    const envName = svc.envKeyName;
    const prior = envName ? process.env[envName] : undefined;
    if (envName) delete process.env[envName];
    try {
      const summary = await buildKeyStatusSummary(svc, makeSecrets());
      assert.equal(summary.serviceId, "openai");
      assert.equal(summary.displayName, svc.displayName);
      assert.equal(summary.kind, "provider");
      assert.equal(summary.source, "missing");
      assert.equal(summary.state, "missing");
      assert.equal(summary.maskedPreview, undefined);
      assert.equal(summary.supportsTest, svc.supportsTest);
    } finally {
      if (envName && prior !== undefined) process.env[envName] = prior;
    }
  }
  // Case 2: stored secret in SecretStorage -> source "secret", state "saved", maskedPreview set.
  {
    const svc = getKeyService("recost");
    const envName = svc.envKeyName; // recost has no env var, but be defensive
    const prior = envName ? process.env[envName] : undefined;
    if (envName) delete process.env[envName];
    try {
      const summary = await buildKeyStatusSummary(
        svc,
        makeSecrets({ "recost.apiKey": "rc-storedvalue123456" })
      );
      assert.equal(summary.serviceId, "recost");
      assert.equal(summary.source, "secret");
      assert.equal(summary.state, "saved");
      assert.ok(
        typeof summary.maskedPreview === "string" && summary.maskedPreview.length > 0,
        "expected maskedPreview to be populated when a secret is stored"
      );
      assert.notEqual(summary.maskedPreview, "rc-storedvalue123456");
    } finally {
      if (envName && prior !== undefined) process.env[envName] = prior;
    }
  }
  // Case 3: explicit validation snapshot overrides the source-derived state.
  {
    const svc = getKeyService("openai");
    const envName = svc.envKeyName;
    const prior = envName ? process.env[envName] : undefined;
    if (envName) delete process.env[envName];
    try {
      const summary = await buildKeyStatusSummary(svc, makeSecrets(), {
        state: "valid",
        message: "ok",
        lastCheckedAt: "2026-05-11T00:00:00.000Z",
      });
      // source is still "missing" because there is no env var and no stored secret,
      // but `state` should reflect the validation snapshot.
      assert.equal(summary.source, "missing");
      assert.equal(summary.state, "valid");
      assert.equal(summary.message, "ok");
      assert.equal(summary.lastCheckedAt, "2026-05-11T00:00:00.000Z");
    } finally {
      if (envName && prior !== undefined) process.env[envName] = prior;
    }
  }

  console.log("PASS key-management");
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
