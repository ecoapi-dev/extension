import assert from "node:assert/strict";
import { buildSnapshot } from "../builder";
import { buildReviewClusters } from "../clusters";
import { scoreRepoIntelligence } from "../scorer";

function run(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

run("buildReviewClusters builds explainable file-level clusters with providers, findings, and review questions", () => {
  const snapshot = buildSnapshot({
    apiCalls: [
      {
        file: "./src/chat/loop.ts",
        line: 10,
        method: "POST",
        url: "https://api.openai.com/v1/chat/completions",
        provider: "openai",
        frequencyClass: "unbounded-loop",
        cacheCapable: true,
      },
      {
        file: "./src/chat/loop.ts",
        line: 20,
        method: "POST",
        url: "https://api.openai.com/v1/chat/completions",
        provider: "openai",
        frequencyClass: "unbounded-loop",
        cacheCapable: true,
      },
      {
        file: "./src/chat/batch.ts",
        line: 8,
        method: "POST",
        url: "https://api.openai.com/v1/chat/completions",
        provider: "openai",
        frequencyClass: "parallel",
      },
      {
        file: "./src/chat/cache.ts",
        line: 5,
        method: "GET",
        url: "https://api.openai.com/v1/models",
        provider: "openai",
        cacheCapable: true,
      },
      {
        file: "./src/chat/observed.ts",
        line: 12,
        method: "POST",
        url: "https://api.openai.com/v1/moderations",
        provider: "openai",
      },
      {
        file: "./src/payments/poller.ts",
        line: 9,
        method: "POST",
        url: "https://api.stripe.com/v1/payment_intents",
        provider: "stripe",
        frequencyClass: "polling",
      },
      {
        file: "./src/payments/guard.ts",
        line: 14,
        method: "POST",
        url: "https://api.stripe.com/v1/payment_intents",
        provider: "stripe",
      },
      {
        file: "./src/lib/cache.ts",
        line: 7,
        method: "GET",
        url: "https://api.example.com/cache/status",
        provider: undefined,
      },
    ],
    findings: [
      {
        id: "loop-rate-limit",
        type: "rate_limit",
        severity: "high",
        riskScore: 6,
        confidence: 0.95,
        description: "Loop can exceed limits",
        affectedFile: "./src/chat/loop.ts",
        line: 11,
        evidence: ["unbounded-loop"],
      },
      {
        id: "loop-redundancy",
        type: "redundancy",
        severity: "medium",
        riskScore: 4,
        confidence: 0.8,
        description: "Repeated prompt body",
        affectedFile: "./src/chat/loop.ts",
        line: 18,
        evidence: ["same payload"],
      },
      {
        id: "batch-concurrency",
        type: "concurrency_control",
        severity: "medium",
        riskScore: 4,
        confidence: 0.88,
        description: "Parallel fanout lacks guard",
        affectedFile: "./src/chat/batch.ts",
        line: 8,
        evidence: ["Promise.all"],
      },
      {
        id: "guard-rate-limit",
        type: "rate_limit",
        severity: "medium",
        riskScore: 4,
        confidence: 0.81,
        description: "Polling path needs backoff",
        affectedFile: "./src/payments/guard.ts",
        line: 14,
        evidence: ["retry loop"],
      },
      {
        id: "findings-only-cache",
        type: "cache",
        severity: "low",
        riskScore: 1,
        confidence: 0.55,
        description: "Could cache this read",
        affectedFile: "./src/chat/findings-only.ts",
        line: 5,
        evidence: ["repeated read"],
      },
    ],
  });

  const scored = scoreRepoIntelligence(snapshot);
  const clusters = buildReviewClusters(scored);

  assert.ok(clusters.length >= 1);
  assert.ok(clusters.length <= 5);

  const loopCluster = clusters.find((cluster) => cluster.primaryFile.filePath === "src/chat/loop.ts");
  assert.ok(loopCluster);
  assert.ok((loopCluster?.relatedFiles.length ?? 0) >= 2);
  assert.ok((loopCluster?.relatedFiles.length ?? 0) <= 5);
  assert.deepEqual(loopCluster?.providers, ["openai"]);
  assert.equal(loopCluster?.estimatedMonthlyCost, null);
  assert.ok((loopCluster?.topFindings.length ?? 0) >= 3);
  assert.ok(loopCluster?.reviewQuestion.includes("OpenAI calls inside unbounded loops"));

  const relationships = new Map(loopCluster?.relatedFiles.map((file) => [file.filePath, file.relationship]));
  assert.equal(relationships.get("src/chat/batch.ts"), "Shares API endpoint pattern");
  assert.equal(relationships.get("src/chat/cache.ts"), "Uses same OpenAI provider");
  assert.equal(relationships.get("src/chat/observed.ts"), "Uses same OpenAI provider");
});

run("buildReviewClusters prefers same directory over module-only matches and uses rank proximity only as fallback", () => {
  const snapshot = buildSnapshot({
    apiCalls: [
      {
        file: "./src/chat/root.ts",
        line: 1,
        method: "GET",
        url: "https://api.example.com/chat/root",
      },
      {
        file: "./src/chat/sibling.ts",
        line: 1,
        method: "GET",
        url: "https://api.example.com/chat/sibling",
      },
      {
        file: "./src/chat/sub/nested.ts",
        line: 1,
        method: "GET",
        url: "https://api.example.com/chat/sub",
      },
      {
        file: "./src/lib/high.ts",
        line: 1,
        method: "GET",
        url: "https://api.example.com/lib/high",
      },
      {
        file: "./src/lib/other.ts",
        line: 1,
        method: "GET",
        url: "https://api.example.com/lib/other",
      },
    ],
    findings: [
      {
        id: "root-finding",
        type: "rate_limit",
        severity: "high",
        riskScore: 6,
        confidence: 0.92,
        description: "Hot path",
        affectedFile: "./src/chat/root.ts",
        line: 1,
        evidence: ["burst"],
      },
      {
        id: "sibling-finding",
        type: "redundancy",
        severity: "medium",
        riskScore: 4,
        confidence: 0.75,
        description: "Shared module work",
        affectedFile: "./src/chat/sibling.ts",
        line: 1,
        evidence: ["repeat"],
      },
      {
        id: "nested-finding",
        type: "redundancy",
        severity: "low",
        riskScore: 1,
        confidence: 0.6,
        description: "Review this path",
        affectedFile: "./src/chat/sub/nested.ts",
        line: 1,
        evidence: ["repeat"],
      },
      {
        id: "high-finding",
        type: "cache",
        severity: "medium",
        riskScore: 4,
        confidence: 0.83,
        description: "High-ranked unrelated path",
        affectedFile: "./src/lib/high.ts",
        line: 1,
        evidence: ["hot read"],
      },
    ],
  });

  const clusters = buildReviewClusters(scoreRepoIntelligence(snapshot));
  const chatCluster = clusters.find(
    (entry) => entry.primaryFile.filePath === "src/chat/sibling.ts"
  );
  const libCluster = clusters.find(
    (entry) => entry.primaryFile.filePath === "src/lib/high.ts"
  );

  assert.ok(chatCluster);
  const chatRelationships = new Map(chatCluster?.relatedFiles.map((file) => [file.filePath, file.relationship]));
  assert.equal(chatRelationships.get("src/chat/root.ts"), "Located in same directory");
  assert.equal(chatRelationships.get("src/chat/sub/nested.ts"), "Located in same module");
  assert.ok(!chatRelationships.has("src/lib/high.ts"));

  assert.ok(libCluster);
  const libRelationships = new Map(libCluster?.relatedFiles.map((file) => [file.filePath, file.relationship]));
  assert.ok(Array.from(libRelationships.values()).includes("Also high-priority file"));
});

run("buildReviewClusters uses exact endpoint-key normalization for unknown providers and suppresses overlapping duplicates", () => {
  const snapshot = buildSnapshot({
    apiCalls: [
      {
        file: "./src/shared/a.ts",
        line: 5,
        method: "GET",
        url: "https://api.example.com/items",
        provider: undefined,
      },
      {
        file: "./src/shared/b.ts",
        line: 6,
        method: "GET",
        url: "https://api.example.com/items",
        provider: undefined,
      },
      {
        file: "./src/shared/c.ts",
        line: 7,
        method: "GET",
        url: "https://api.example.com/items",
        provider: undefined,
      },
      {
        file: "./src/shared/d.ts",
        line: 8,
        method: "GET",
        url: "https://api.example.com/items",
        provider: undefined,
      },
      {
        file: "./src/shared/findings-only.ts",
        line: 3,
        method: "GET",
        url: "https://api.example.com/other",
        provider: undefined,
      },
    ],
    findings: [
      {
        id: "shared-a",
        type: "redundancy",
        severity: "high",
        riskScore: 6,
        confidence: 0.9,
        description: "Duplicate requests",
        affectedFile: "./src/shared/a.ts",
        line: 5,
        evidence: ["same endpoint"],
      },
      {
        id: "shared-b",
        type: "redundancy",
        severity: "medium",
        riskScore: 4,
        confidence: 0.8,
        description: "Duplicate requests",
        affectedFile: "./src/shared/b.ts",
        line: 6,
        evidence: ["same endpoint"],
      },
      {
        id: "shared-c",
        type: "redundancy",
        severity: "medium",
        riskScore: 4,
        confidence: 0.7,
        description: "Duplicate requests",
        affectedFile: "./src/shared/c.ts",
        line: 7,
        evidence: ["same endpoint"],
      },
      {
        id: "findings-only",
        type: "cache",
        severity: "low",
        riskScore: 1,
        confidence: 0.5,
        description: "No calls but has finding",
        affectedFile: "./src/findings-only.ts",
        line: 1,
        evidence: ["read path"],
      },
    ],
  });

  const clusters = buildReviewClusters(scoreRepoIntelligence(snapshot));
  const sharedCluster = clusters.find((cluster) => cluster.primaryFile.filePath === "src/shared/a.ts");

  assert.ok(sharedCluster);
  assert.deepEqual(sharedCluster?.providers, []);
  assert.ok(sharedCluster?.relatedFiles.some((file) => file.filePath === "src/shared/b.ts"));
  assert.equal(
    sharedCluster?.relatedFiles.find((file) => file.filePath === "src/shared/b.ts")?.relationship,
    "Shares API endpoint pattern"
  );

  const sharedPrimaries = clusters.filter((cluster) => cluster.primaryFile.filePath.startsWith("src/shared/"));
  assert.equal(sharedPrimaries.length, 1);
});

run("buildReviewClusters prefers runtime primaries over test primaries when runtime files exist", () => {
  const snapshot = buildSnapshot({
    apiCalls: [
      {
        file: "./src/runtime.ts",
        line: 5,
        method: "POST",
        url: "https://api.openai.com/v1/chat/completions",
        provider: "openai",
        frequencyClass: "parallel",
      },
      {
        file: "./src/runtime-helper.ts",
        line: 7,
        method: "GET",
        url: "https://api.openai.com/v1/models",
        provider: "openai",
      },
      {
        file: "./src/test/runtime.test.ts",
        line: 5,
        method: "POST",
        url: "https://api.openai.com/v1/chat/completions",
        provider: "openai",
        frequencyClass: "parallel",
      },
    ],
    findings: [
      {
        id: "runtime-finding",
        type: "rate_limit",
        severity: "high",
        riskScore: 6,
        confidence: 0.9,
        description: "Runtime path can burst",
        affectedFile: "./src/runtime.ts",
        line: 5,
        evidence: ["Promise.all"],
      },
      {
        id: "test-finding",
        type: "rate_limit",
        severity: "high",
        riskScore: 6,
        confidence: 0.9,
        description: "Test path can burst",
        affectedFile: "./src/test/runtime.test.ts",
        line: 5,
        evidence: ["Promise.all"],
      },
    ],
  });

  const clusters = buildReviewClusters(scoreRepoIntelligence(snapshot));
  assert.ok(clusters.some((cluster) => cluster.primaryFile.filePath === "src/runtime.ts"));
  assert.ok(!clusters.some((cluster) => cluster.primaryFile.filePath === "src/test/runtime.test.ts"));
});

run("buildReviewClusters avoids test related files when a runtime related file already exists", () => {
  const snapshot = buildSnapshot({
    apiCalls: [
      {
        file: "./src/runtime.ts",
        line: 5,
        method: "POST",
        url: "https://api.openai.com/v1/chat/completions",
        provider: "openai",
      },
      {
        file: "./src/runtime-helper.ts",
        line: 6,
        method: "POST",
        url: "https://api.openai.com/v1/chat/completions",
        provider: "openai",
      },
      {
        file: "./src/test/runtime.test.ts",
        line: 7,
        method: "POST",
        url: "https://api.openai.com/v1/chat/completions",
        provider: "openai",
      },
    ],
    findings: [
      {
        id: "runtime-finding",
        type: "rate_limit",
        severity: "high",
        riskScore: 6,
        confidence: 0.9,
        description: "Runtime path can burst",
        affectedFile: "./src/runtime.ts",
        line: 5,
        evidence: ["Promise.all"],
      },
    ],
  });

  const cluster = buildReviewClusters(scoreRepoIntelligence(snapshot)).find(
    (entry) => entry.primaryFile.filePath === "src/runtime.ts"
  );

  assert.ok(cluster);
  assert.ok(cluster?.relatedFiles.some((file) => file.filePath === "src/runtime-helper.ts"));
  assert.ok(!cluster?.relatedFiles.some((file) => file.filePath === "src/test/runtime.test.ts"));
});

run("buildReviewClusters demotes tooling-only broad overlaps behind runtime provider wrapper context", () => {
  const snapshot = buildSnapshot({
    apiCalls: [
      {
        file: "./src/chat/providers/xai.ts",
        line: 5,
        method: "GET",
        url: "https://api.openai.com/v1/models",
        provider: "openai",
        cacheCapable: true,
      },
      {
        file: "./src/chat/providers/openai.ts",
        line: 5,
        method: "GET",
        url: "https://api.openai.com/v1/chat/completions",
        provider: "openai",
        cacheCapable: true,
      },
      {
        file: "./src/chat/providers/perplexity.ts",
        line: 5,
        method: "GET",
        url: "https://api.perplexity.ai/chat/completions",
        provider: "perplexity",
        cacheCapable: true,
      },
      {
        file: "./src/chat/providers/mistral.ts",
        line: 5,
        method: "GET",
        url: "https://api.mistral.ai/v1/chat/completions",
        provider: "mistral",
        cacheCapable: true,
      },
      {
        file: "./src/ast/call-visitor.ts",
        line: 5,
        method: "GET",
        url: "https://api.openai.com/v1/files",
        provider: "openai",
      },
      {
        file: "./src/scanner/patterns/provider-anthropic.ts",
        line: 5,
        method: "POST",
        url: "https://api.anthropic.com/v1/messages",
        provider: "anthropic",
      },
    ],
    findings: [
      {
        id: "xai-primary",
        type: "rate_limit",
        severity: "high",
        riskScore: 6,
        confidence: 0.95,
        description: "Wrapper path is hot",
        affectedFile: "./src/chat/providers/xai.ts",
        line: 5,
        evidence: ["hot path"],
      },
    ],
  });

  const cluster = buildReviewClusters(scoreRepoIntelligence(snapshot)).find(
    (entry) => entry.primaryFile.filePath === "src/chat/providers/xai.ts"
  );

  assert.ok(cluster);
  assert.ok(cluster?.relatedFiles.some((file) => file.filePath === "src/chat/providers/openai.ts"));
  assert.ok(cluster?.relatedFiles.some((file) => file.filePath === "src/chat/providers/perplexity.ts"));
  assert.ok(cluster?.relatedFiles.some((file) => file.filePath === "src/chat/providers/mistral.ts"));
  assert.ok(!cluster?.relatedFiles.some((file) => file.filePath === "src/ast/call-visitor.ts"));
  assert.ok(!cluster?.relatedFiles.some((file) => file.filePath === "src/scanner/patterns/provider-anthropic.ts"));
});

run("buildReviewClusters still keeps tooling files when they are the only exact shared match", () => {
  const snapshot = buildSnapshot({
    apiCalls: [
      {
        file: "./src/runtime.ts",
        line: 5,
        method: "POST",
        url: "https://api.openai.com/v1/chat/completions",
        provider: "openai",
      },
      {
        file: "./src/ast/call-visitor.ts",
        line: 7,
        method: "POST",
        url: "https://api.openai.com/v1/chat/completions",
        provider: "openai",
      },
    ],
    findings: [
      {
        id: "runtime-primary",
        type: "rate_limit",
        severity: "high",
        riskScore: 6,
        confidence: 0.95,
        description: "Runtime path can burst",
        affectedFile: "./src/runtime.ts",
        line: 5,
        evidence: ["Promise.all"],
      },
    ],
  });

  const cluster = buildReviewClusters(scoreRepoIntelligence(snapshot)).find(
    (entry) => entry.primaryFile.filePath === "src/runtime.ts"
  );

  assert.ok(cluster);
  assert.equal(
    cluster?.relatedFiles.find((file) => file.filePath === "src/ast/call-visitor.ts")?.relationship,
    "Shares API endpoint pattern"
  );
});

run("buildReviewClusters follows deterministic review-question priority order", () => {
  const snapshot = buildSnapshot({
    apiCalls: [
      {
        file: "./src/priority/hot.ts",
        line: 4,
        method: "POST",
        url: "https://api.openai.com/v1/chat/completions",
        provider: "openai",
        frequencyClass: "parallel",
        cacheCapable: true,
      },
      {
        file: "./src/priority/hot.ts",
        line: 12,
        method: "POST",
        url: "https://api.openai.com/v1/chat/completions",
        provider: "openai",
        frequencyClass: "parallel",
        cacheCapable: true,
      },
      {
        file: "./src/priority/neighbor.ts",
        line: 2,
        method: "POST",
        url: "https://api.openai.com/v1/chat/completions",
        provider: "openai",
      },
    ],
    findings: [
      {
        id: "priority-rate-limit",
        type: "rate_limit",
        severity: "high",
        riskScore: 6,
        confidence: 0.9,
        description: "Burst traffic",
        affectedFile: "./src/priority/hot.ts",
        line: 4,
        evidence: ["parallel"],
      },
      {
        id: "priority-redundancy",
        type: "redundancy",
        severity: "medium",
        riskScore: 4,
        confidence: 0.85,
        description: "Repeated requests",
        affectedFile: "./src/priority/hot.ts",
        line: 12,
        evidence: ["duplicate body"],
      },
    ],
  });

  const cluster = buildReviewClusters(scoreRepoIntelligence(snapshot)).find(
    (entry) => entry.primaryFile.filePath === "src/priority/hot.ts"
  );

  assert.ok(cluster);
  assert.equal(
    cluster?.reviewQuestion,
    "Check whether OpenAI parallel API fanout can be batched, cached, or guarded with tighter limits."
  );
});
