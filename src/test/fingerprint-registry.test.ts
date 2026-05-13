import assert from "node:assert/strict";
import { ALL_PROVIDERS } from "../scanner/fingerprints/index";
import type { ProviderFingerprint, MethodFingerprint } from "../scanner/fingerprints/types";
import {
  lookupMethod,
  lookupHost,
  getAllProviders,
  getProviderMethods,
} from "../scanner/fingerprints/registry";
import { matchNormalizedLine } from "../scanner/patterns";

function run(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

function findProvider(id: string): ProviderFingerprint {
  const p = ALL_PROVIDERS.find((x) => x.provider === id);
  assert.ok(p, `provider "${id}" not found in ALL_PROVIDERS`);
  return p as ProviderFingerprint;
}

function findMethod(provider: ProviderFingerprint, pattern: string): MethodFingerprint {
  const m = provider.methods.find((x) => x.pattern === pattern);
  assert.ok(m, `method "${pattern}" not found in provider "${provider.provider}"`);
  return m as MethodFingerprint;
}

// ── 1. Schema validation ─────────────────────────────────────────────────────

run("all expected providers are present", () => {
  const expected = [
    "openai", "anthropic", "stripe", "supabase", "firebase",
    "aws-bedrock", "gemini", "cohere", "mistral", "vertex-ai",
    "elevenlabs",
  ];
  for (const id of expected) {
    assert.ok(
      ALL_PROVIDERS.some((p) => p.provider === id),
      `missing provider: ${id}`
    );
  }
  assert.equal(ALL_PROVIDERS.length, expected.length);
});

run("every provider has required top-level fields", () => {
  for (const p of ALL_PROVIDERS) {
    assert.ok(p.schemaVersion, `${p.provider}: missing schemaVersion`);
    assert.ok(p.provider, `${p.provider}: missing provider`);
    assert.ok(p.displayName, `${p.provider}: missing displayName`);
    assert.ok(Array.isArray(p.languages) && p.languages.length > 0, `${p.provider}: languages must be a non-empty array`);
    assert.ok(Array.isArray(p.packages) && p.packages.length > 0, `${p.provider}: packages must be a non-empty array`);
    assert.ok(Array.isArray(p.hosts) && p.hosts.length > 0, `${p.provider}: hosts must be a non-empty array`);
    assert.ok(Array.isArray(p.methods) && p.methods.length > 0, `${p.provider}: methods must be a non-empty array`);
    assert.equal(p.schemaVersion, "1.0.0", `${p.provider}: schemaVersion should be 1.0.0`);
  }
});

// ── 2. Method field completeness ─────────────────────────────────────────────

run("every method has pattern, httpMethod, endpoint, costModel", () => {
  for (const p of ALL_PROVIDERS) {
    for (const m of p.methods) {
      assert.ok(m.pattern, `${p.provider}: method missing pattern`);
      assert.ok(m.httpMethod, `${p.provider}/${m.pattern}: missing httpMethod`);
      assert.ok(m.endpoint, `${p.provider}/${m.pattern}: missing endpoint`);
      assert.ok(m.costModel, `${p.provider}/${m.pattern}: missing costModel`);
      assert.ok(
        ["per_token", "per_transaction", "per_request", "free"].includes(m.costModel),
        `${p.provider}/${m.pattern}: invalid costModel "${m.costModel}"`
      );
    }
  }
});

run("every method httpMethod is a known verb", () => {
  const VALID = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "SUBSCRIBE", "RPC"]);
  for (const p of ALL_PROVIDERS) {
    for (const m of p.methods) {
      assert.ok(
        VALID.has(m.httpMethod),
        `${p.provider}/${m.pattern}: unknown httpMethod "${m.httpMethod}"`
      );
    }
  }
});

// ── 3. No duplicate patterns within a provider ───────────────────────────────

run("no duplicate method patterns within a provider", () => {
  for (const p of ALL_PROVIDERS) {
    const seen = new Set<string>();
    for (const m of p.methods) {
      assert.ok(!seen.has(m.pattern), `${p.provider}: duplicate pattern "${m.pattern}"`);
      seen.add(m.pattern);
    }
  }
});

// ── 4. Known method lookups ───────────────────────────────────────────────────

run("openai chat.completions.create → POST, per_token", () => {
  const p = findProvider("openai");
  const m = findMethod(p, "chat.completions.create");
  assert.equal(m.httpMethod, "POST");
  assert.equal(m.costModel, "per_token");
  assert.match(m.endpoint, /api\.openai\.com\/v1\/chat\/completions/);
  assert.ok(typeof m.inputPricePer1M === "number");
  assert.ok(typeof m.outputPricePer1M === "number");
});

run("anthropic messages.create → POST, correct endpoint", () => {
  const p = findProvider("anthropic");
  const m = findMethod(p, "messages.create");
  assert.equal(m.httpMethod, "POST");
  assert.equal(m.endpoint, "https://api.anthropic.com/v1/messages");
  assert.equal(m.costModel, "per_token");
});

run("anthropic messages.stream → streaming flag set", () => {
  const p = findProvider("anthropic");
  const m = findMethod(p, "messages.stream");
  assert.equal(m.streaming, true);
});

run("anthropic messageBatches.create → batchCapable, discounted pricing", () => {
  const p = findProvider("anthropic");
  const m = findMethod(p, "messageBatches.create");
  assert.equal(m.batchCapable, true);
  // batch pricing should be cheaper than regular messages
  const msg = findMethod(p, "messages.create");
  assert.ok((m.inputPricePer1M ?? 0) < (msg.inputPricePer1M ?? 999));
});

run("stripe paymentIntents.create → per_transaction with fees", () => {
  const p = findProvider("stripe");
  const m = findMethod(p, "paymentIntents.create");
  assert.equal(m.costModel, "per_transaction");
  assert.ok(typeof m.fixedFee === "number" && m.fixedFee > 0);
  assert.ok(typeof m.percentageFee === "number" && m.percentageFee > 0);
});

run("bedrock ConverseStreamCommand → POST, streaming, per_token", () => {
  const p = findProvider("aws-bedrock");
  const m = findMethod(p, "ConverseStreamCommand");
  assert.equal(m.httpMethod, "POST");
  assert.equal(m.streaming, true);
  assert.equal(m.costModel, "per_token");
  assert.match(m.endpoint, /converse-stream/);
});

run("gemini models.generateContent → per_token, cacheCapable", () => {
  const p = findProvider("gemini");
  const m = findMethod(p, "models.generateContent");
  assert.equal(m.costModel, "per_token");
  assert.equal(m.cacheCapable, true);
  assert.match(m.endpoint, /generateContent$/);
});

run("mistral chat.complete → per_token with pricing", () => {
  const p = findProvider("mistral");
  const m = findMethod(p, "chat.complete");
  assert.equal(m.costModel, "per_token");
  assert.ok(typeof m.inputPricePer1M === "number");
  assert.ok(typeof m.outputPricePer1M === "number");
});

run("vertex generateContent → per_token, aiplatform endpoint", () => {
  const p = findProvider("vertex-ai");
  const m = findMethod(p, "generateContent");
  assert.equal(m.costModel, "per_token");
  assert.match(m.endpoint, /aiplatform\.googleapis\.com/);
});

run("cohere rerank → per_request", () => {
  const p = findProvider("cohere");
  const m = findMethod(p, "rerank");
  assert.equal(m.costModel, "per_request");
});

run("firebase onSnapshot → streaming", () => {
  const p = findProvider("firebase");
  const m = findMethod(p, "onSnapshot");
  assert.equal(m.streaming, true);
});

run("supabase from.select → GET, cacheCapable", () => {
  const p = findProvider("supabase");
  const m = findMethod(p, "from.select");
  assert.equal(m.httpMethod, "GET");
  assert.equal(m.cacheCapable, true);
});

// ── 5. Host patterns ──────────────────────────────────────────────────────────

run("openai hosts include api.openai.com (exact)", () => {
  const p = findProvider("openai");
  assert.ok(p.hosts.some((h) => h.pattern === "api.openai.com" && !h.isRegex));
});

run("anthropic hosts include api.anthropic.com (exact)", () => {
  const p = findProvider("anthropic");
  assert.ok(p.hosts.some((h) => h.pattern === "api.anthropic.com" && !h.isRegex));
});

run("stripe hosts include api.stripe.com (exact)", () => {
  const p = findProvider("stripe");
  assert.ok(p.hosts.some((h) => h.pattern === "api.stripe.com" && !h.isRegex));
});

run("bedrock hosts use a regex pattern", () => {
  const p = findProvider("aws-bedrock");
  assert.ok(p.hosts.some((h) => h.isRegex === true));
});

run("supabase hosts use a regex pattern covering *.supabase.co", () => {
  const p = findProvider("supabase");
  const regexHost = p.hosts.find((h) => h.isRegex);
  assert.ok(regexHost, "supabase should have a regex host pattern");
  const re = new RegExp(regexHost!.pattern);
  assert.ok(re.test("myproject.supabase.co"));
  assert.ok(re.test("supabase.co"));
  assert.ok(!re.test("notsupabase.com"));
});

run("vertex hosts use a regex pattern covering *.aiplatform.googleapis.com", () => {
  const p = findProvider("vertex-ai");
  const regexHost = p.hosts.find((h) => h.isRegex);
  assert.ok(regexHost, "vertex-ai should have a regex host pattern");
  const re = new RegExp(regexHost!.pattern);
  assert.ok(re.test("us-central1-aiplatform.googleapis.com"));
  assert.ok(re.test("europe-west4-aiplatform.googleapis.com"));
});

// ── 6. Pricing sanity ─────────────────────────────────────────────────────────

run("all per_token methods have inputPricePer1M defined", () => {
  for (const p of ALL_PROVIDERS) {
    for (const m of p.methods) {
      if (m.costModel === "per_token") {
        assert.ok(
          typeof m.inputPricePer1M === "number",
          `${p.provider}/${m.pattern}: per_token method missing inputPricePer1M`
        );
        assert.ok(m.inputPricePer1M >= 0, `${p.provider}/${m.pattern}: inputPricePer1M must be >= 0`);
      }
    }
  }
});

run("all per_transaction methods have fixedFee or percentageFee", () => {
  for (const p of ALL_PROVIDERS) {
    for (const m of p.methods) {
      if (m.costModel === "per_transaction") {
        const hasFee =
          typeof m.fixedFee === "number" || typeof m.percentageFee === "number";
        assert.ok(
          hasFee,
          `${p.provider}/${m.pattern}: per_transaction method must have fixedFee or percentageFee`
        );
      }
    }
  }
});

run("pricing values are non-negative where defined", () => {
  for (const p of ALL_PROVIDERS) {
    for (const m of p.methods) {
      if (m.inputPricePer1M !== undefined)
        assert.ok(m.inputPricePer1M >= 0, `${p.provider}/${m.pattern}: inputPricePer1M < 0`);
      if (m.outputPricePer1M !== undefined)
        assert.ok(m.outputPricePer1M >= 0, `${p.provider}/${m.pattern}: outputPricePer1M < 0`);
      if (m.fixedFee !== undefined)
        assert.ok(m.fixedFee >= 0, `${p.provider}/${m.pattern}: fixedFee < 0`);
      if (m.percentageFee !== undefined)
        assert.ok(m.percentageFee >= 0, `${p.provider}/${m.pattern}: percentageFee < 0`);
    }
  }
});

// ── Registry loader tests (1.4) ───────────────────────────────────────────────

// lookupMethod — exact match
run("lookupMethod: openai chat.completions.create returns correct entry", () => {
  const m = lookupMethod("openai", "chat.completions.create");
  assert.ok(m, "expected a result");
  assert.equal(m!.httpMethod, "POST");
  assert.equal(m!.costModel, "per_token");
  assert.ok(typeof m!.inputPricePer1M === "number");
});

run("lookupMethod: anthropic messages.create returns correct endpoint", () => {
  const m = lookupMethod("anthropic", "messages.create");
  assert.ok(m);
  assert.equal(m!.endpoint, "https://api.anthropic.com/v1/messages");
});

run("lookupMethod: stripe paymentIntents.create returns per_transaction", () => {
  const m = lookupMethod("stripe", "paymentIntents.create");
  assert.ok(m);
  assert.equal(m!.costModel, "per_transaction");
});

run("lookupMethod: supabase from.select returns cacheCapable GET", () => {
  const m = lookupMethod("supabase", "from.select");
  assert.ok(m);
  assert.equal(m!.httpMethod, "GET");
  assert.equal(m!.cacheCapable, true);
});

// lookupMethod — variable prefix stripping
run("lookupMethod: strips leading variable name (client.chat.completions.create → openai)", () => {
  const m = lookupMethod("openai", "client.chat.completions.create");
  assert.ok(m, "should match after stripping 'client.' prefix");
  assert.equal(m!.costModel, "per_token");
});

run("lookupMethod: strips arbitrary alias prefix (ai.messages.create → anthropic)", () => {
  const m = lookupMethod("anthropic", "ai.messages.create");
  assert.ok(m, "should match after stripping 'ai.' prefix");
  assert.equal(m!.endpoint, "https://api.anthropic.com/v1/messages");
});

// lookupMethod — misses
run("lookupMethod: unknown method returns null", () => {
  assert.equal(lookupMethod("openai", "totally.unknown.method"), null);
});

run("lookupMethod: unknown provider returns null", () => {
  assert.equal(lookupMethod("nonexistent", "chat.completions.create"), null);
});

run("lookupMethod: empty strings return null", () => {
  assert.equal(lookupMethod("", "chat.completions.create"), null);
  assert.equal(lookupMethod("openai", ""), null);
});

// lookupMethod — case-insensitive provider
run("lookupMethod: provider name is case-insensitive", () => {
  const lower = lookupMethod("openai", "chat.completions.create");
  const upper = lookupMethod("OpenAI", "chat.completions.create");
  const mixed = lookupMethod("OPENAI", "chat.completions.create");
  assert.ok(lower && upper && mixed);
  assert.equal(lower!.endpoint, upper!.endpoint);
  assert.equal(lower!.endpoint, mixed!.endpoint);
});

// lookupHost — exact matches
run("lookupHost: api.openai.com → openai", () => {
  assert.equal(lookupHost("api.openai.com"), "openai");
});

run("lookupHost: api.anthropic.com → anthropic", () => {
  assert.equal(lookupHost("api.anthropic.com"), "anthropic");
});

run("lookupHost: api.stripe.com → stripe", () => {
  assert.equal(lookupHost("api.stripe.com"), "stripe");
});

run("lookupHost: api.mistral.ai → mistral", () => {
  assert.equal(lookupHost("api.mistral.ai"), "mistral");
});

run("lookupHost: generativelanguage.googleapis.com → gemini", () => {
  assert.equal(lookupHost("generativelanguage.googleapis.com"), "gemini");
});

// lookupHost — regex patterns
run("lookupHost: subdomain.supabase.co matches supabase regex", () => {
  assert.equal(lookupHost("myproject.supabase.co"), "supabase");
});

run("lookupHost: bedrock-runtime.us-east-1.amazonaws.com → aws-bedrock", () => {
  assert.equal(lookupHost("bedrock-runtime.us-east-1.amazonaws.com"), "aws-bedrock");
});

run("lookupHost: us-central1-aiplatform.googleapis.com → vertex-ai", () => {
  assert.equal(lookupHost("us-central1-aiplatform.googleapis.com"), "vertex-ai");
});

// lookupHost — misses
run("lookupHost: unknown hostname returns null", () => {
  assert.equal(lookupHost("example.com"), null);
});

run("lookupHost: empty string returns null", () => {
  assert.equal(lookupHost(""), null);
});

// getAllProviders
run("getAllProviders: returns all providers", () => {
  const providers = getAllProviders();
  assert.equal(providers.length, ALL_PROVIDERS.length);
  assert.ok(providers.includes("openai"));
  assert.ok(providers.includes("anthropic"));
  assert.ok(providers.includes("stripe"));
  assert.ok(providers.includes("aws-bedrock"));
  assert.ok(providers.includes("vertex-ai"));
});

run("getAllProviders: no duplicates", () => {
  const providers = getAllProviders();
  assert.equal(providers.length, new Set(providers).size);
});

// getProviderMethods
run("getProviderMethods: openai returns multiple methods", () => {
  const methods = getProviderMethods("openai");
  assert.ok(methods.length > 0);
  assert.ok(methods.some((m) => m.pattern === "chat.completions.create"));
  assert.ok(methods.some((m) => m.pattern === "embeddings.create"));
});

run("getProviderMethods: unknown provider returns empty array", () => {
  assert.deepEqual(getProviderMethods("nonexistent"), []);
});

run("getProviderMethods: empty string returns empty array", () => {
  assert.deepEqual(getProviderMethods(""), []);
});

run("getProviderMethods: case-insensitive provider name", () => {
  const lower = getProviderMethods("anthropic");
  const upper = getProviderMethods("ANTHROPIC");
  assert.equal(lower.length, upper.length);
  assert.ok(lower.length > 0);
});

// ── 7. HOST_MAP_PROVIDERS host lookups (Phase 1.6) ───────────────────────────

run("lookupHost: api.github.com → github", () => {
  assert.equal(lookupHost("api.github.com"), "github");
});

run("lookupHost: api.stripe.com → stripe (exact beats regex)", () => {
  assert.equal(lookupHost("api.stripe.com"), "stripe");
});

run("lookupHost: dashboard.stripe.com → stripe (regex)", () => {
  assert.equal(lookupHost("dashboard.stripe.com"), "stripe");
});

run("lookupHost: hooks.slack.com → slack", () => {
  assert.equal(lookupHost("hooks.slack.com"), "slack");
});

run("lookupHost: ingest.sentry.io → sentry", () => {
  assert.equal(lookupHost("ingest.sentry.io"), "sentry");
});

run("lookupHost: bucket.s3.us-east-1.amazonaws.com → aws-s3", () => {
  assert.equal(lookupHost("bucket.s3.us-east-1.amazonaws.com"), "aws-s3");
});

run("lookupHost: abc123.execute-api.eu-west-1.amazonaws.com → aws-api-gateway", () => {
  assert.equal(lookupHost("abc123.execute-api.eu-west-1.amazonaws.com"), "aws-api-gateway");
});

run("lookupHost: maps.googleapis.com → google-maps", () => {
  assert.equal(lookupHost("maps.googleapis.com"), "google-maps");
});

run("lookupHost: firestore.googleapis.com → firestore (provider override)", () => {
  assert.equal(lookupHost("firestore.googleapis.com"), "firestore");
});

run("lookupHost: api.openrouter.ai → openrouter", () => {
  assert.equal(lookupHost("api.openrouter.ai"), "openrouter");
});

run("lookupHost: api.groq.com → groq", () => {
  assert.equal(lookupHost("api.groq.com"), "groq");
});

run("lookupHost: api.deepseek.com → deepseek", () => {
  assert.equal(lookupHost("api.deepseek.com"), "deepseek");
});

run("lookupHost: localhost → local-openai-compatible", () => {
  assert.equal(lookupHost("localhost"), "local-openai-compatible");
});

run("lookupHost: 127.0.0.1 → local-openai-compatible", () => {
  assert.equal(lookupHost("127.0.0.1"), "local-openai-compatible");
});

run("lookupHost: api.algolia.net → algolia", () => {
  assert.equal(lookupHost("api.algolia.net"), "algolia");
});

run("lookupHost: api.segment.io → segment", () => {
  assert.equal(lookupHost("api.segment.io"), "segment");
});

// ── 8. Pricing detail tests (Phase 1.7) ──────────────────────────────────────

run("pricing: openai chat.completions.create has positive input and output price", () => {
  const m = lookupMethod("openai", "chat.completions.create");
  assert.ok(m, "entry must exist");
  assert.ok(typeof m!.inputPricePer1M === "number" && m!.inputPricePer1M > 0,
    "inputPricePer1M must be > 0");
  assert.ok(typeof m!.outputPricePer1M === "number" && m!.outputPricePer1M > 0,
    "outputPricePer1M must be > 0");
});

run("pricing: anthropic messages.create cheaper input than output", () => {
  const m = lookupMethod("anthropic", "messages.create");
  assert.ok(m);
  assert.ok((m!.inputPricePer1M ?? 0) < (m!.outputPricePer1M ?? 0),
    "input tokens should cost less than output tokens");
});

run("pricing: anthropic messageBatches.create cheaper than messages.create", () => {
  const batch = lookupMethod("anthropic", "messageBatches.create");
  const msg = lookupMethod("anthropic", "messages.create");
  assert.ok(batch && msg);
  assert.ok((batch!.inputPricePer1M ?? 0) < (msg!.inputPricePer1M ?? 999),
    "batch pricing should be cheaper than standard");
});

run("pricing: stripe paymentIntents.create has fixed 0.30 fee and 2.9% rate", () => {
  const m = lookupMethod("stripe", "paymentIntents.create");
  assert.ok(m);
  assert.equal(m!.costModel, "per_transaction");
  assert.equal(m!.fixedFee, 0.30, "fixed fee should be $0.30");
  assert.equal(m!.percentageFee, 0.029, "percentage fee should be 2.9%");
});

run("pricing: bedrock ConverseStreamCommand has per_token pricing", () => {
  const m = lookupMethod("aws-bedrock", "ConverseStreamCommand");
  assert.ok(m);
  assert.equal(m!.costModel, "per_token");
  assert.ok((m!.inputPricePer1M ?? 0) > 0 && (m!.outputPricePer1M ?? 0) > 0);
  // Bedrock is typically more expensive than hosted APIs
  assert.ok((m!.inputPricePer1M ?? 0) > 1, "bedrock input price should be > $1/1M");
});

run("pricing: gemini models.generateContent has per_token pricing", () => {
  const m = lookupMethod("gemini", "models.generateContent");
  assert.ok(m);
  assert.equal(m!.costModel, "per_token");
  assert.ok(typeof m!.inputPricePer1M === "number" && m!.inputPricePer1M >= 0);
});

run("pricing: mistral chat.complete has non-zero pricing", () => {
  const m = lookupMethod("mistral", "chat.complete");
  assert.ok(m);
  assert.ok((m!.inputPricePer1M ?? 0) > 0);
  assert.ok((m!.outputPricePer1M ?? 0) > 0);
});

run("pricing: vertex-ai generateContent has per_token pricing", () => {
  const m = lookupMethod("vertex-ai", "generateContent");
  assert.ok(m);
  assert.equal(m!.costModel, "per_token");
  assert.ok((m!.inputPricePer1M ?? 0) >= 0);
});

run("pricing: cohere embed has per_token, rerank has per_request", () => {
  const embed = lookupMethod("cohere", "embed");
  const rerank = lookupMethod("cohere", "rerank");
  assert.ok(embed && rerank);
  assert.equal(embed!.costModel, "per_token");
  assert.equal(rerank!.costModel, "per_request");
});

run("pricing: supabase from.select is per_request (usage-based)", () => {
  const m = lookupMethod("supabase", "from.select");
  assert.ok(m);
  assert.equal(m!.costModel, "per_request");
});

// ── 9. Integration: scanner matches use registry data (Phase 1.7) ─────────────

run("integration: anthropic scanner match endpoint matches registry", () => {
  const line = "await client.messages.create({ model: 'claude-3-5-haiku-latest' })";
  const matches = matchNormalizedLine(line).filter((m) => m.provider === "anthropic");
  assert.ok(matches.length > 0, "should detect anthropic match");
  const reg = lookupMethod("anthropic", "messages.create");
  assert.ok(reg, "registry must have messages.create");
  const match = matches.find((m) => m.action === "create");
  assert.ok(match, "should find create action");
  assert.equal(match!.endpoint, reg!.endpoint,
    "scanner endpoint should match registry endpoint");
});

run("integration: bedrock scanner streaming flag matches registry", () => {
  const line = "await client.send(new ConverseStreamCommand({ modelId: 'anthropic.claude-3' }))";
  const matches = matchNormalizedLine(line).filter((m) => m.provider === "aws-bedrock");
  assert.ok(matches.length > 0, "should detect bedrock match");
  const reg = lookupMethod("aws-bedrock", "ConverseStreamCommand");
  assert.ok(reg && reg.streaming === true);
  assert.equal(matches[0].streaming, true,
    "scanner streaming flag should come from registry");
});

run("integration: openai chat completions match uses registry costModel endpoint", () => {
  const line = "await openai.chat.completions.create({ model: 'gpt-4o', messages })";
  const matches = matchNormalizedLine(line).filter((m) => m.provider === "openai");
  assert.ok(matches.length > 0, "should detect openai match");
  const reg = lookupMethod("openai", "chat.completions.create");
  assert.ok(reg);
  const match = matches[0];
  assert.match(match.endpoint ?? "", /api\.openai\.com\/v1\/chat\/completions/,
    "endpoint must point to openai completions");
  assert.equal(match.streaming, reg!.streaming ?? false);
});

run("integration: mistral chat stream match has streaming true", () => {
  const line = "await mistral.chat.stream({ model: 'mistral-small' })";
  const matches = matchNormalizedLine(line).filter((m) => m.provider === "mistral");
  assert.ok(matches.length > 0, "should detect mistral match");
  const reg = lookupMethod("mistral", "chat.stream");
  assert.ok(reg && reg.streaming === true);
  assert.equal(matches[0].streaming, true);
});

run("integration: stripe match method and endpoint match registry", () => {
  const line = "await stripe.paymentIntents.create({ amount: 1000, currency: 'usd' })";
  const matches = matchNormalizedLine(line).filter((m) => m.provider === "stripe");
  assert.ok(matches.length > 0, "should detect stripe match");
  const reg = lookupMethod("stripe", "paymentIntents.create");
  assert.ok(reg);
  assert.equal(matches[0].method, reg!.httpMethod,
    "HTTP method should come from registry");
  assert.match(matches[0].endpoint ?? "", /api\.stripe\.com/);
});

run("integration: supabase select match is cacheCapable from registry", () => {
  const line = "await supabase.from('users').select('id, name')";
  const matches = matchNormalizedLine(line).filter((m) => m.provider === "supabase");
  assert.ok(matches.length > 0, "should detect supabase match");
  const reg = lookupMethod("supabase", "from.select");
  assert.ok(reg && reg.cacheCapable === true);
  assert.equal(matches[0].cacheCapable, true,
    "cacheCapable should come from registry");
});

run("integration: firebase onSnapshot match is streaming from registry", () => {
  const line = "onSnapshot(docRef, (snap) => { setData(snap.data()); })";
  const matches = matchNormalizedLine(line).filter((m) => m.provider === "firebase");
  assert.ok(matches.length > 0, "should detect firebase match");
  const reg = lookupMethod("firebase", "onSnapshot");
  assert.ok(reg && reg.streaming === true);
  assert.equal(matches[0].streaming, true,
    "streaming should come from registry");
});
