import assert from "node:assert/strict";
import { buildSnapshot } from "../builder";
import { scoreRepoIntelligence, scoreSnapshot } from "../scorer";

function run(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

run("scoreRepoIntelligence returns the expected shape and repo-relative normalized scores", () => {
  const snapshot = buildSnapshot({
    apiCalls: [
      {
        file: "./src/expensive.ts",
        line: 12,
        method: "POST",
        url: "https://api.openai.com/v1/chat/completions",
        provider: "openai",
        costModel: "per_token",
        frequencyClass: "unbounded-loop",
        batchCapable: true,
        cacheCapable: true,
      },
      {
        file: "./src/expensive.ts",
        line: 30,
        method: "POST",
        url: "https://api.stripe.com/v1/payment_intents",
        provider: "stripe",
        costModel: "per_transaction",
        frequencyClass: "parallel",
      },
      {
        file: "./src/simple.ts",
        line: 4,
        method: "GET",
        url: "/api/health",
        frequency: "daily",
      },
      {
        file: "./src/regex-only.ts",
        line: 8,
        method: "GET",
        url: "sdk://custom/health",
        frequency: "daily",
      },
      {
        file: "./src/repeated-null.ts",
        line: 5,
        method: "GET",
        url: "https://api.example.com/items",
        provider: undefined,
        frequencyClass: "bounded-loop",
      },
      {
        file: "./src/repeated-null.ts",
        line: 15,
        method: "GET",
        url: "https://api.example.com/items",
        provider: undefined,
        frequencyClass: "bounded-loop",
      },
    ],
    findings: [
      {
        id: "finding-1",
        type: "rate_limit",
        severity: "high",
        riskScore: 6,
        confidence: 0.95,
        description: "Hot loop can exceed limits",
        affectedFile: "./src/expensive.ts",
        line: 11,
        evidence: ["unbounded-loop"],
      },
      {
        id: "finding-2",
        type: "concurrency_control",
        severity: "medium",
        riskScore: 4,
        confidence: 0.8,
        description: "Parallel fanout lacks guard",
        affectedFile: "./src/expensive.ts",
        line: 29,
        evidence: ["Promise.all"],
      },
      {
        id: "finding-3",
        type: "cache",
        severity: "low",
        riskScore: 1,
        confidence: 0.5,
        description: "Cache the lookup",
        affectedFile: "./src/findings-only.ts",
        line: 3,
        evidence: ["read path"],
      },
    ],
  });

  const scored = scoreRepoIntelligence(snapshot);
  assert.equal(scored.snapshot, snapshot);
  assert.ok(Array.isArray(scored.scoredFiles));
  assert.ok(Array.isArray(scored.rankedProviders));
  assert.ok(Array.isArray(scored.rankedFindings));
  assert.equal(scored.scoredFiles[0].filePath, "src/expensive.ts");
  assert.equal(scored.scoredFiles[0].scores.importance, 10);
  assert.equal(scored.scoredFiles[0].scores.costLeak, 10);
  assert.equal(scored.scoredFiles[0].scores.reliabilityRisk, 10);
  assert.ok(scored.scoredFiles[0].scores.aiReviewPriority <= 10);
  assert.ok(scored.scoredFiles[0].reasons.length >= 2);
  assert.ok(scored.scoredFiles[0].reasons.length <= 5);
  assert.ok(scored.scoredFiles[0].reasons.some((reason) => reason === "2 high-frequency calls" || reason === "2 API calls"));
  assert.ok(scored.scoredFiles[0].reasons.includes("Uses multiple providers"));
  assert.ok(scored.scoredFiles[0].reasons.includes("Contains unbounded-loop traffic"));
  assert.equal(scored.rankedProviders[0].name, "openai");
  assert.equal(scored.rankedFindings[0].id, "finding-1");

  const regexOnly = scored.scoredFiles.find((file) => file.filePath === "src/regex-only.ts");
  assert.ok(regexOnly);
  assert.equal(regexOnly?.scores.costLeak, 0);

  const findingsOnly = scored.scoredFiles.find((file) => file.filePath === "src/findings-only.ts");
  assert.ok(findingsOnly);
  assert.ok((findingsOnly?.scores.importance ?? 0) > 0);
  assert.ok((findingsOnly?.scores.reliabilityRisk ?? 0) > 0);
});

run("scoreSnapshot remains a compatibility alias", () => {
  const snapshot = buildSnapshot({
    apiCalls: [
      {
        file: "./src/alias.ts",
        line: 10,
        method: "GET",
        url: "https://api.example.com/alias",
      },
    ],
    findings: [],
  });

  assert.deepEqual(scoreSnapshot(snapshot), scoreRepoIntelligence(snapshot));
});

run("scoreRepoIntelligence is zero-safe when no file has score signals", () => {
  const snapshot = buildSnapshot({
    apiCalls: [],
    findings: [
      {
        id: "finding-only",
        type: "cache",
        severity: "low",
        riskScore: 1,
        confidence: 0.4,
        description: "Maybe cache this",
        affectedFile: "./src/findings-only.ts",
        evidence: ["repeat read"],
      },
    ],
  });

  const scored = scoreRepoIntelligence({
    ...snapshot,
    findings: {},
    files: {
      "src/empty.ts": {
        id: "src/empty.ts",
        filePath: "src/empty.ts",
        apiCallIds: [],
        findingIds: [],
        providers: [],
      },
    },
  });

  assert.equal(scored.scoredFiles[0].scores.importance, 0);
  assert.equal(scored.scoredFiles[0].scores.costLeak, 0);
  assert.equal(scored.scoredFiles[0].scores.reliabilityRisk, 0);
  assert.equal(scored.scoredFiles[0].scores.aiReviewPriority, 0);
});

run("costLeak applies the expected frequency ordering", () => {
  const snapshot = buildSnapshot({
    apiCalls: [
      {
        file: "./src/unbounded.ts",
        line: 2,
        method: "GET",
        url: "https://api.example.com/unbounded",
        provider: undefined,
        frequencyClass: "unbounded-loop",
      },
      {
        file: "./src/polling.ts",
        line: 3,
        method: "GET",
        url: "https://api.example.com/poll",
        provider: undefined,
        frequencyClass: "polling",
      },
      {
        file: "./src/parallel.ts",
        line: 4,
        method: "GET",
        url: "https://api.example.com/fanout",
        provider: undefined,
        frequencyClass: "parallel",
      },
      {
        file: "./src/bounded.ts",
        line: 4,
        method: "GET",
        url: "https://api.example.com/bounded",
        provider: undefined,
        frequencyClass: "bounded-loop",
      },
      {
        file: "./src/single.ts",
        line: 5,
        method: "GET",
        url: "https://api.example.com/once",
        provider: undefined,
        frequencyClass: "single",
      },
    ],
    findings: [],
  });

  const scored = scoreRepoIntelligence(snapshot);
  const byPath = new Map(scored.scoredFiles.map((file) => [file.filePath, file]));
  assert.ok((byPath.get("src/unbounded.ts")?.scores.costLeak ?? 0) > (byPath.get("src/parallel.ts")?.scores.costLeak ?? 0));
  assert.ok((byPath.get("src/parallel.ts")?.scores.costLeak ?? 0) > (byPath.get("src/bounded.ts")?.scores.costLeak ?? 0));
  assert.ok((byPath.get("src/polling.ts")?.scores.costLeak ?? 0) > (byPath.get("src/bounded.ts")?.scores.costLeak ?? 0));
  assert.ok((byPath.get("src/bounded.ts")?.scores.costLeak ?? 0) > (byPath.get("src/single.ts")?.scores.costLeak ?? 0));
});

run("provider ranking uses file count then api calls then findings", () => {
  const snapshot = buildSnapshot({
    apiCalls: [
      {
        file: "./src/a.ts",
        line: 1,
        method: "GET",
        url: "https://api.alpha.com/1",
        provider: "alpha",
      },
      {
        file: "./src/b.ts",
        line: 1,
        method: "GET",
        url: "https://api.alpha.com/2",
        provider: "alpha",
      },
      {
        file: "./src/c.ts",
        line: 1,
        method: "GET",
        url: "https://api.beta.com/1",
        provider: "beta",
      },
      {
        file: "./src/c.ts",
        line: 2,
        method: "GET",
        url: "https://api.beta.com/2",
        provider: "beta",
      },
    ],
    findings: [
      {
        id: "beta-finding",
        type: "rate_limit",
        severity: "medium",
        riskScore: 4,
        confidence: 0.7,
        description: "beta issue",
        affectedFile: "./src/c.ts",
        line: 2,
        evidence: ["e"],
      },
    ],
  });

  const scored = scoreRepoIntelligence(snapshot);
  assert.deepEqual(
    scored.rankedProviders.map((provider) => provider.name),
    ["alpha", "beta"]
  );
});

run("repetition and cache-capable rules handle null providers and cache-only suppression", () => {
  const snapshot = buildSnapshot({
    apiCalls: [
      {
        file: "./src/repeat-no-cache.ts",
        line: 5,
        method: "GET",
        url: "https://api.example.com/users",
        provider: undefined,
        frequencyClass: "single",
        cacheCapable: true,
      },
      {
        file: "./src/repeat-no-cache.ts",
        line: 12,
        method: "GET",
        url: "https://api.example.com/users",
        provider: undefined,
        frequencyClass: "single",
        cacheCapable: true,
      },
      {
        file: "./src/repeat-with-cache.ts",
        line: 5,
        method: "GET",
        url: "https://api.example.com/users",
        provider: undefined,
        frequencyClass: "single",
        cacheCapable: true,
      },
      {
        file: "./src/repeat-with-cache.ts",
        line: 12,
        method: "GET",
        url: "https://api.example.com/users",
        provider: undefined,
        frequencyClass: "single",
        cacheCapable: true,
      },
    ],
    findings: [
      {
        id: "batch-only",
        type: "batch",
        severity: "low",
        riskScore: 1,
        confidence: 0.6,
        description: "batch possible",
        affectedFile: "./src/repeat-no-cache.ts",
        line: 10,
        evidence: ["loop"],
      },
      {
        id: "cache-present",
        type: "cache",
        severity: "low",
        riskScore: 1,
        confidence: 0.6,
        description: "cache this",
        affectedFile: "./src/repeat-with-cache.ts",
        line: 10,
        evidence: ["memoize"],
      },
    ],
  });

  const scored = scoreRepoIntelligence(snapshot);
  const withoutCacheScore = scored.scoredFiles.find((file) => file.filePath === "src/repeat-no-cache.ts");
  const withCacheScore = scored.scoredFiles.find((file) => file.filePath === "src/repeat-with-cache.ts");

  assert.ok(withoutCacheScore);
  assert.ok(withCacheScore);
  assert.ok(withoutCacheScore?.reasons.includes("Repeated API calls in one file"));
  assert.ok(withoutCacheScore?.reasons.includes("Cache-capable calls without cache finding"));
  assert.ok((withoutCacheScore?.scores.costLeak ?? 0) > (withCacheScore?.scores.costLeak ?? 0));
});

run("files with only findings and files with no calls do not crash", () => {
  const snapshot = buildSnapshot({
    apiCalls: [],
    findings: [
      {
        id: "finding-only",
        type: "concurrency_control",
        severity: "high",
        riskScore: 6,
        confidence: 0.9,
        description: "needs limiter",
        affectedFile: "./src/findings-only.ts",
        line: 4,
        evidence: ["Promise.all"],
      },
    ],
  });

  const scored = scoreRepoIntelligence(snapshot);
  assert.equal(scored.scoredFiles[0].filePath, "src/findings-only.ts");
  assert.equal(scored.scoredFiles[0].scores.costLeak, 0);
  assert.ok(scored.scoredFiles[0].scores.reliabilityRisk > 0);
  assert.ok(scored.scoredFiles[0].reasons.some((reason) => reason.includes("findings")));
});

run("test files receive a deterministic context-generation penalty", () => {
  const snapshot = buildSnapshot({
    apiCalls: [
      {
        file: "./src/worker.ts",
        line: 8,
        method: "POST",
        url: "https://api.openai.com/v1/chat/completions",
        provider: "openai",
        frequencyClass: "parallel",
      },
      {
        file: "./tests/worker.spec.ts",
        line: 8,
        method: "POST",
        url: "https://api.openai.com/v1/chat/completions",
        provider: "openai",
        frequencyClass: "parallel",
      },
      {
        file: "./src/test/providers.test.ts",
        line: 12,
        method: "POST",
        url: "https://api.openai.com/v1/chat/completions",
        provider: "openai",
        frequencyClass: "bounded-loop",
      },
    ],
    findings: [
      {
        id: "worker-finding",
        type: "rate_limit",
        severity: "high",
        riskScore: 6,
        confidence: 0.9,
        description: "Main path can burst requests",
        affectedFile: "./src/worker.ts",
        line: 8,
        evidence: ["Promise.all"],
      },
      {
        id: "test-finding",
        type: "rate_limit",
        severity: "high",
        riskScore: 6,
        confidence: 0.9,
        description: "Test path can burst requests",
        affectedFile: "./tests/worker.spec.ts",
        line: 8,
        evidence: ["Promise.all"],
      },
      {
        id: "src-test-finding",
        type: "cache",
        severity: "low",
        riskScore: 1,
        confidence: 0.4,
        description: "Exercise provider list",
        affectedFile: "./src/test/providers.test.ts",
        line: 12,
        evidence: ["loop"],
      },
    ],
  });

  const scored = scoreRepoIntelligence(snapshot);
  const mainFile = scored.scoredFiles.find((file) => file.filePath === "src/worker.ts");
  const testFile = scored.scoredFiles.find((file) => file.filePath === "tests/worker.spec.ts");
  const srcTestFile = scored.scoredFiles.find((file) => file.filePath === "src/test/providers.test.ts");
  assert.ok(mainFile);
  assert.ok(testFile);
  assert.ok(srcTestFile);
  assert.ok((mainFile?.scores.aiReviewPriority ?? 0) > (testFile?.scores.aiReviewPriority ?? 0));
  assert.ok((mainFile?.scores.aiReviewPriority ?? 0) > (srcTestFile?.scores.aiReviewPriority ?? 0));
  assert.equal(scored.scoredFiles[0].filePath, "src/worker.ts");
});

run("generated assets and analysis tooling files receive a deterministic context-generation penalty", () => {
  const snapshot = buildSnapshot({
    apiCalls: [
      {
        file: "./src/runtime.ts",
        line: 8,
        method: "POST",
        url: "https://api.openai.com/v1/chat/completions",
        provider: "openai",
        frequencyClass: "parallel",
      },
      {
        file: "./dashboard-dist/assets/index-abc123.js",
        line: 8,
        method: "POST",
        url: "https://api.openai.com/v1/chat/completions",
        provider: "openai",
        frequencyClass: "parallel",
      },
      {
        file: "./src/scanner/patterns/provider-gemini.ts",
        line: 8,
        method: "POST",
        url: "https://generativelanguage.googleapis.com/v1beta/models/gemini:generateContent",
        provider: "gemini",
        frequencyClass: "parallel",
      },
    ],
    findings: [],
  });

  const scored = scoreRepoIntelligence(snapshot);
  const runtimeFile = scored.scoredFiles.find((file) => file.filePath === "src/runtime.ts");
  const generatedFile = scored.scoredFiles.find((file) => file.filePath === "dashboard-dist/assets/index-abc123.js");
  const toolingFile = scored.scoredFiles.find((file) => file.filePath === "src/scanner/patterns/provider-gemini.ts");

  assert.ok(runtimeFile);
  assert.ok(generatedFile);
  assert.ok(toolingFile);
  assert.ok((runtimeFile?.scores.aiReviewPriority ?? 0) > (generatedFile?.scores.aiReviewPriority ?? 0));
  assert.ok((runtimeFile?.scores.aiReviewPriority ?? 0) > (toolingFile?.scores.aiReviewPriority ?? 0));
  assert.equal(scored.scoredFiles[0].filePath, "src/runtime.ts");
});
