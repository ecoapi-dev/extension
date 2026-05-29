import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildSnapshot } from "../builder";
import { buildReviewClusters } from "../clusters";
import { compressClusters } from "../compression";
import { scoreRepoIntelligence } from "../scorer";

const pendingTests: Array<() => Promise<void>> = [];

function run(name: string, fn: () => void | Promise<void>): void {
  pendingTests.push(async () => {
    try {
      await fn();
      console.log(`PASS ${name}`);
    } catch (error) {
      console.error(`FAIL ${name}`);
      throw error;
    }
  });
}

async function withTempWorkspace(
  files: Record<string, string>,
  fn: (workspaceDir: string) => void | Promise<void>
): Promise<void> {
  const originalCwd = process.cwd();
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "compression-test-"));

  try {
    for (const [relativePath, content] of Object.entries(files)) {
      const absolutePath = path.join(workspaceDir, relativePath);
      fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
      fs.writeFileSync(absolutePath, content, "utf8");
    }
    process.chdir(workspaceDir);
    await fn(workspaceDir);
  } finally {
    process.chdir(originalCwd);
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
}

run("compressClusters returns compact summaries, normalized findings, and bounded snippets", async () => {
  await withTempWorkspace(
    {
      "src/chat/loop.ts": [
        "export async function loop(items) {",
        "  for (const item of items) {",
        "    await client.chat.completions.create({ model: 'gpt-4.1-mini' });",
        "    await client.chat.completions.create({ model: 'gpt-4.1-mini' });",
        "  }",
        "}",
      ].join("\n"),
      "src/chat/cache.ts": [
        "export async function loadModel() {",
        "  return await client.models.list();",
        "}",
      ].join("\n"),
      "src/chat/findings-only.ts": [
        "export function getConfig() {",
        "  return readConfig();",
        "}",
      ].join("\n"),
      "src/payments/poller.ts": [
        "setInterval(async () => {",
        "  await stripe.paymentIntents.create({ amount: 10 });",
        "}, 1000);",
      ].join("\n"),
    },
    async () => {
      const snapshot = buildSnapshot({
        apiCalls: [
          {
            file: "./src/chat/loop.ts",
            line: 3,
            method: "POST",
            url: "https://api.openai.com/v1/chat/completions",
            provider: "openai",
            frequencyClass: "unbounded-loop",
            cacheCapable: true,
          },
          {
            file: "./src/chat/loop.ts",
            line: 4,
            method: "POST",
            url: "https://api.openai.com/v1/chat/completions",
            provider: "openai",
            frequencyClass: "unbounded-loop",
            cacheCapable: true,
          },
          {
            file: "./src/chat/cache.ts",
            line: 2,
            method: "GET",
            url: "https://api.openai.com/v1/models",
            provider: "openai",
            cacheCapable: true,
          },
          {
            file: "./src/payments/poller.ts",
            line: 2,
            method: "POST",
            url: "https://api.stripe.com/v1/payment_intents",
            provider: "stripe",
            frequencyClass: "polling",
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
            line: 3,
            evidence: ["unbounded-loop"],
          },
          {
            id: "loop-redundancy",
            type: "redundancy",
            severity: "medium",
            riskScore: 4,
            confidence: 0.84,
            description: "Repeated endpoint body",
            affectedFile: "./src/chat/loop.ts",
            line: 4,
            evidence: ["duplicate call"],
          },
          {
            id: "findings-only-cache",
            type: "cache",
            severity: "low",
            riskScore: 1,
            confidence: 0.55,
            description: "Could cache this read",
            affectedFile: "./src/chat/findings-only.ts",
            line: 2,
            evidence: ["repeated read"],
          },
        ],
      });

      const clusters = buildReviewClusters(scoreRepoIntelligence(snapshot));
      const compressed = await compressClusters(clusters, snapshot);

      assert.ok(compressed.length >= 1);
      const loopCluster = compressed.find((cluster) => cluster.primarySummary.filePath === "src/chat/loop.ts");
      assert.ok(loopCluster);
      assert.ok(
        loopCluster?.estimatedMonthlyCost === null ||
          (typeof loopCluster?.estimatedMonthlyCost === "number" && loopCluster.estimatedMonthlyCost >= 0)
      );
      assert.ok((loopCluster?.findings.length ?? 0) <= 5);
      assert.ok((loopCluster?.snippets.length ?? 0) <= 5);
      assert.deepEqual(loopCluster?.providers, ["openai"]);
      assert.deepEqual(loopCluster?.primarySummary.providers, ["openai"]);
      assert.ok((loopCluster?.primarySummary.topRisks ?? []).includes("Unbounded loop API calls"));
      assert.ok((loopCluster?.primarySummary.topRisks ?? []).includes("Repeated endpoint calls"));
      assert.ok(
        loopCluster?.primarySummary.estimatedMonthlyCost === null ||
          (typeof loopCluster?.primarySummary.estimatedMonthlyCost === "number" &&
            loopCluster.primarySummary.estimatedMonthlyCost >= 0)
      );
      assert.equal(
        loopCluster?.primarySummary.whyItMatters,
        "This file runs repeated API work inside an unbounded loop, so it is a strong review target."
      );
      assert.equal(
        loopCluster?.primarySummary.description,
        "This file contains 2 API calls against openai and shows unbounded loop API calls."
      );
      assert.ok(!(loopCluster?.primarySummary.whyItMatters.includes("likely API inefficiency or reliability issues") ?? false));
      assert.ok((loopCluster?.primarySummary.description.match(/[.!?](?:\s|$)/g)?.length ?? 1) <= 2);
      assert.ok((loopCluster?.primarySummary.whyItMatters.match(/[.!?](?:\s|$)/g)?.length ?? 1) <= 1);
      assert.ok(!(loopCluster?.primarySummary.description.includes("OpenAI") ?? false));
      assert.ok(!(loopCluster?.primarySummary.whyItMatters.includes("OpenAI") ?? false));

      assert.equal(loopCluster?.findings[0].title, "Rate-limit risk");
      assert.equal(loopCluster?.findings[0].estimatedMonthlyCost, null);
      assert.ok(loopCluster?.findings.every((finding) => finding.description.length > 0));

      assert.ok((loopCluster?.snippets.length ?? 0) >= 1);
      assert.ok(loopCluster?.snippets.every((snippet) => snippet.startLine <= snippet.endLine));
      assert.ok(loopCluster?.snippets.every((snippet) => snippet.code.trim().length > 0));
      assert.ok(loopCluster?.snippets.some((snippet) => snippet.label === "API call inside loop"));
      const mergedLoopSnippet = loopCluster?.snippets.find((snippet) => snippet.filePath === "src/chat/loop.ts");
      assert.ok(mergedLoopSnippet);
      assert.equal(mergedLoopSnippet?.startLine, 1);
      assert.equal(mergedLoopSnippet?.endLine, 6);
    }
  );
});

run("compressClusters dedupes repeated same-file findings and collapses repeated titles in export output", async () => {
  await withTempWorkspace(
    {
      "src/chat/cache.ts": [
        "export async function loadModel() {",
        "  return await client.models.list();",
        "  return await stripe.paymentIntents.list();",
        "}",
      ].join("\n"),
    },
    async () => {
      const snapshot = buildSnapshot({
        apiCalls: [
          {
            file: "./src/chat/cache.ts",
            line: 2,
            method: "GET",
            url: "https://api.openai.com/v1/models",
            provider: "openai",
            cacheCapable: true,
          },
          {
            file: "./src/chat/cache.ts",
            line: 3,
            method: "GET",
            url: "https://api.stripe.com/v1/payment_intents",
            provider: "stripe",
            cacheCapable: true,
          },
        ],
        findings: [
          {
            id: "cache-a",
            type: "cache",
            severity: "medium",
            riskScore: 4,
            confidence: 0.9,
            description: "Cache model list",
            affectedFile: "./src/chat/cache.ts",
            line: 2,
            evidence: ["repeated read", "openai models"],
          },
          {
            id: "cache-b",
            type: "cache",
            severity: "low",
            riskScore: 1,
            confidence: 0.5,
            description: "Cache model list",
            affectedFile: "./src/chat/cache.ts",
            line: 2,
            evidence: ["openai models", "repeated read"],
          },
          {
            id: "cache-c",
            type: "cache",
            severity: "medium",
            riskScore: 4,
            confidence: 0.85,
            description: "Cache payment intent list",
            affectedFile: "./src/chat/cache.ts",
            line: 3,
            evidence: ["secondary path", "stripe payment intents"],
          },
        ],
      });

      const compressed = await compressClusters(buildReviewClusters(scoreRepoIntelligence(snapshot)), snapshot);
      const cluster = compressed.find((entry) => entry.primarySummary.filePath === "src/chat/cache.ts");
      assert.ok(cluster);
      assert.equal(cluster?.findings.filter((finding) => finding.title === "Missing caching").length, 1);
      assert.ok(cluster?.findings.some((finding) => finding.description.includes("Cache model list")));
    }
  );
});

run("compressClusters uses softer evidence language for weak test-derived files", async () => {
  await withTempWorkspace(
    {
      "src/test/providers.test.ts": [
        "for (const provider of ALL_PROVIDERS) {",
        "  expect(provider).toBeDefined();",
        "}",
      ].join("\n"),
    },
    async () => {
      const snapshot = buildSnapshot({
        apiCalls: [
          {
            file: "./src/test/providers.test.ts",
            line: 1,
            method: "POST",
            url: "https://api.openai.com/v1/chat/completions",
            provider: "Open_AI",
            frequencyClass: "bounded-loop",
          },
        ],
        findings: [],
      });

      const compressed = await compressClusters(buildReviewClusters(scoreRepoIntelligence(snapshot)), snapshot);
      const testCluster = compressed.find((cluster) => cluster.primarySummary.filePath === "src/test/providers.test.ts");
      assert.ok(testCluster);
      assert.ok(testCluster?.primarySummary.description.startsWith("This test file"));
      assert.ok(testCluster?.primarySummary.whyItMatters.includes("test file"));
      assert.ok(testCluster?.primarySummary.whyItMatters.includes("reproduce"));
      assert.ok(!(testCluster?.primarySummary.whyItMatters.includes("likely API inefficiency or reliability issues") ?? false));
      assert.ok(!(testCluster?.primarySummary.whyItMatters.includes("strong review target") ?? false));
      assert.ok(!(testCluster?.primarySummary.whyItMatters.includes("burst load") ?? false));
    }
  );
});

run("compressClusters uses neutral snippet labels for test helper cache-like code", async () => {
  await withTempWorkspace(
    {
      "src/test/providers.test.ts": [
        "function findProvider(id) {",
        "  return ALL_PROVIDERS.find((x) => x.provider === id);",
        "}",
      ].join("\n"),
    },
    async () => {
      const snapshot = buildSnapshot({
        apiCalls: [
          {
            file: "./src/test/providers.test.ts",
            line: 2,
            method: "GET",
            url: "https://api.openai.com/v1/models",
            provider: "openai",
            cacheCapable: true,
          },
        ],
        findings: [
          {
            id: "test-cache-finding",
            type: "cache",
            severity: "low",
            riskScore: 1,
            confidence: 0.6,
            description: "Exercise cache-like helper behavior",
            affectedFile: "./src/test/providers.test.ts",
            line: 2,
            evidence: ["find helper"],
          },
        ],
      });

      const compressed = await compressClusters(buildReviewClusters(scoreRepoIntelligence(snapshot)), snapshot);
      const testCluster = compressed.find((cluster) => cluster.primarySummary.filePath === "src/test/providers.test.ts");
      assert.ok(testCluster);
      assert.ok(testCluster?.snippets.some((snippet) => snippet.label === "Relevant test helper context"));
      assert.ok(!testCluster?.snippets.some((snippet) => snippet.label === "Cacheable call without cache"));
    }
  );
});

run("compressClusters handles files with only findings, null providers, and missing snippet files", async () => {
  await withTempWorkspace(
    {
      "src/shared/a.ts": [
        "export async function a() {",
        "  return fetch('https://api.example.com/items');",
        "}",
      ].join("\n"),
      "src/shared/b.ts": [
        "export async function b() {",
        "  return fetch('https://api.example.com/items');",
        "}",
      ].join("\n"),
      "src/findings-only.ts": [
        "export function config() {",
        "  return readConfig();",
        "}",
      ].join("\n"),
    },
    async () => {
      const snapshot = buildSnapshot({
        apiCalls: [
          {
            file: "./src/shared/a.ts",
            line: 2,
            method: "GET",
            url: "https://api.example.com/items",
            provider: undefined,
          },
          {
            file: "./src/shared/b.ts",
            line: 2,
            method: "GET",
            url: "https://api.example.com/items",
            provider: undefined,
          },
        ],
        findings: [
          {
            id: "redundancy-a",
            type: "redundancy",
            severity: "high",
            riskScore: 6,
            confidence: 0.9,
            description: "Duplicate request pattern",
            affectedFile: "./src/shared/a.ts",
            line: 2,
            evidence: ["same endpoint"],
          },
          {
            id: "findings-only",
            type: "cache",
            severity: "high",
            riskScore: 6,
            confidence: 0.92,
            description: "Could cache this read",
            affectedFile: "./src/findings-only.ts",
            line: 2,
            evidence: ["repeated read"],
          },
          {
            id: "missing-file",
            type: "rate_limit",
            severity: "low",
            riskScore: 1,
            confidence: 0.4,
            description: "Missing file should not crash snippets",
            affectedFile: "./src/missing.ts",
            line: 2,
            evidence: ["synthetic"],
          },
        ],
      });

      const compressed = await compressClusters(buildReviewClusters(scoreRepoIntelligence(snapshot)), snapshot);
      assert.ok(compressed.length >= 1);

      const sharedCluster = compressed.find((cluster) => cluster.primarySummary.filePath.startsWith("src/shared/"));
      assert.ok(sharedCluster);
      assert.deepEqual(sharedCluster?.providers, []);
      assert.deepEqual(sharedCluster?.primarySummary.providers, []);
      assert.ok(sharedCluster?.findings.some((finding) => finding.title === "Repeated API pattern"));

      const findingsOnlySummary = sharedCluster?.relatedSummaries.find((summary) => summary.filePath === "src/findings-only.ts");
      assert.ok(findingsOnlySummary);
      assert.ok((findingsOnlySummary?.description.length ?? 0) > 0);
      assert.ok((findingsOnlySummary?.whyItMatters.length ?? 0) > 0);
      assert.ok((findingsOnlySummary?.topRisks.length ?? 0) > 0);

      assert.ok(sharedCluster?.snippets.every((snippet) => snippet.filePath !== "src/missing.ts"));
      assert.ok(sharedCluster?.snippets.every((snippet) => snippet.code.trim().length > 0));
    }
  );
});

run("compressClusters uses snapshot.repoRoot instead of process.cwd() for snippet reads", async () => {
  await withTempWorkspace(
    {
      "src/chat/loop.ts": [
        "export async function loop(items) {",
        "  for (const item of items) {",
        "    await client.chat.completions.create({ model: 'gpt-4.1-mini' });",
        "  }",
        "}",
      ].join("\n"),
    },
    async (workspaceDir) => {
      const snapshot = buildSnapshot({
        repoRoot: workspaceDir,
        apiCalls: [
          {
            file: "./src/chat/loop.ts",
            line: 3,
            method: "POST",
            url: "https://api.openai.com/v1/chat/completions",
            provider: "openai",
            frequencyClass: "unbounded-loop",
          },
        ],
        findings: [],
      });

      const originalCwd = process.cwd();
      process.chdir(os.tmpdir());

      try {
        const compressed = await compressClusters(buildReviewClusters(scoreRepoIntelligence(snapshot)), snapshot);
        const loopCluster = compressed.find((cluster) => cluster.primarySummary.filePath === "src/chat/loop.ts");
        assert.ok(loopCluster);
        assert.ok((loopCluster?.snippets.length ?? 0) >= 1);
      } finally {
        process.chdir(originalCwd);
      }
    }
  );
});

(async () => {
  for (const test of pendingTests) {
    await test();
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
