import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildSnapshot } from "../builder";
import { buildReviewClusters } from "../clusters";
import { compressClusters } from "../compression";
import { buildExportContext, formatAsJSON, formatAsMarkdown } from "../export";
import { scoreRepoIntelligence } from "../scorer";
import type { CompressedCluster, ExportedContext } from "../types";

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
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "export-test-"));

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

run("buildExportContext assembles meta, top files, key risks, and passes clusters through unchanged", async () => {
  await withTempWorkspace(
    {
      "src/chat/loop.ts": [
        "export async function loop(items) {",
        "  for (const item of items) {",
        "    await client.chat.completions.create({ model: 'gpt-4.1-mini' });",
        "  }",
        "}",
      ].join("\n"),
      "src/chat/cache.ts": [
        "export async function loadModel() {",
        "  return await client.models.list();",
        "}",
      ].join("\n"),
      "src/payments/poller.ts": [
        "setInterval(async () => {",
        "  await stripe.paymentIntents.create({ amount: 10 });",
        "}, 1000);",
      ].join("\n"),
    },
    async (workspaceDir) => {
      const snapshot = buildSnapshot({
        apiCalls: [
          {
            file: "./src/chat/loop.ts",
            line: 3,
            method: "POST",
            url: "https://api.openai.com/v1/chat/completions",
            provider: "openai",
            frequencyClass: "unbounded-loop",
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
            id: "cache-finding",
            type: "cache",
            severity: "medium",
            riskScore: 4,
            confidence: 0.8,
            description: "Could cache model lookup",
            affectedFile: "./src/chat/cache.ts",
            line: 2,
            evidence: ["cacheable"],
          },
        ],
      });

      const scored = scoreRepoIntelligence(snapshot);
      const clusters = await compressClusters(buildReviewClusters(scored), snapshot);
      const context = buildExportContext(clusters, snapshot, scored, { generatorVersion: "0.1.0" });

      assert.equal(context.meta.projectName, path.basename(workspaceDir));
      assert.match(context.meta.generatedAt, /^\d{4}-\d{2}-\d{2}T/);
      assert.equal(context.meta.generatorVersion, "0.1.0");
      assert.equal(context.meta.totalFiles, snapshot.totalFilesScanned);
      assert.equal(context.meta.totalClusters, clusters.length);
      assert.deepEqual(context.meta.providers, ["openai", "stripe"]);
      assert.ok(context.summary.topFiles.length >= 1);
      assert.ok(context.summary.topFiles.length <= 5);
      assert.ok(context.summary.topFiles.every((file) => file.filePath.length > 0 && file.whyItMatters.length > 0));
      assert.ok(context.summary.keyRisks.length <= 5);
      assert.ok(context.summary.keyRisks.includes("Unbounded loop API calls"));
      assert.ok(context.summary.keyRisks.includes("Rate-limit risk"));
      assert.equal(context.clusters, clusters);
    }
  );
});

run("formatAsMarkdown and formatAsJSON render stable onboarding output", () => {
  const clusters: CompressedCluster[] = [
    {
      id: "cluster:src/chat/loop.ts",
      primarySummary: {
        filePath: "src/chat/loop.ts",
        description: "This file contains 1 API call. It shows unbounded loop API calls.",
        providers: ["openai"],
        topRisks: ["Unbounded loop API calls", "Repeated endpoint calls"],
        estimatedMonthlyCost: null,
        whyItMatters: "This file runs repeated API work inside an unbounded loop, so it is a strong review target.",
      },
      relatedSummaries: [
        {
          filePath: "src/chat/cache.ts",
          description: "This file contains 1 API call in a focused request path.",
          providers: ["openai"],
          topRisks: ["Missing caching on hot path"],
          estimatedMonthlyCost: null,
          whyItMatters: "This file makes cache-capable reads without cache evidence, so it may be doing avoidable repeated work.",
        },
      ],
      findings: [
        {
          title: "Rate-limit risk",
          severity: "high",
          description: "Loop can exceed limits.",
          estimatedMonthlyCost: null,
        },
      ],
      snippets: [
        {
          filePath: "src/chat/loop.ts",
          startLine: 1,
          endLine: 4,
          code: "for (const item of items) {\n  await client.chat.completions.create({});\n}",
          label: "API call inside loop",
        },
        {
          filePath: "src/chat/notes.custom",
          startLine: 1,
          endLine: 2,
          code: "custom snippet",
          label: "Relevant API call",
        },
      ],
      providers: ["openai", "stripe"],
      estimatedMonthlyCost: null,
      reviewQuestion: "Check whether OpenAI calls inside unbounded loops can be batched or cached.",
    },
  ];
  const context: ExportedContext = {
    meta: {
      projectName: "demo-project",
      generatedAt: "2026-03-26T12:00:00.000Z",
      generatorVersion: "0.1.0",
      totalFiles: 3,
      totalClusters: 1,
      providers: ["openai", "stripe"],
    },
    summary: {
      topFiles: [
        {
          filePath: "src/chat/loop.ts",
          whyItMatters: "This file runs repeated API work inside an unbounded loop, so it is a strong review target.",
        },
      ],
      keyRisks: ["Unbounded loop API calls", "Rate-limit risk"],
      costLeaks: [],
    },
    providerSummary: [],
    clusters,
  };

  const markdown = formatAsMarkdown(context);
  assert.ok(markdown.includes("# ReCost Scan — demo-project"));
  assert.ok(markdown.includes("## Summary"));
  assert.ok(markdown.includes("- Generator: ReCost 0.1.0"));
  assert.ok(markdown.includes("- Files scanned: 3"));
  assert.ok(markdown.includes("- Detected providers: OpenAI, Stripe"));
  assert.ok(markdown.includes("## Top Files"));
  assert.ok(markdown.includes("- src/chat/loop.ts — this file runs repeated API work inside an unbounded loop, so it is a strong review target"));
  assert.ok(markdown.includes("## Cluster 1 — src/chat/loop.ts"));
  assert.ok(markdown.includes("### Related Files"));
  assert.ok(markdown.includes("- src/chat/cache.ts — this file makes cache-capable reads without cache evidence, so it may be doing avoidable repeated work"));
  assert.ok(markdown.includes("```ts"));
  assert.ok(markdown.includes("// API call inside loop"));
  assert.ok(markdown.includes("```\n// Relevant API call\ncustom snippet\n```"));
  assert.ok(!markdown.includes("```txt"));

  const json = formatAsJSON(context);
  assert.deepEqual(JSON.parse(json), context);
});

run("buildExportContext falls back to snapshot providers when clusters do not expose provider names", () => {
  const snapshot = buildSnapshot({
    apiCalls: [
      {
        file: "./src/only-provider.ts",
        line: 2,
        method: "POST",
        url: "https://api.openai.com/v1/chat/completions",
        provider: "openai",
      },
    ],
    findings: [],
  });
  const scored = scoreRepoIntelligence(snapshot);
  const context = buildExportContext(
    [
      {
        id: "cluster:src/only-provider.ts",
        primarySummary: {
          filePath: "src/only-provider.ts",
          description: "This file contains 1 API call in a focused request path.",
          providers: [],
          topRisks: ["Relevant API path"],
          estimatedMonthlyCost: null,
          whyItMatters: "This file contains an API path in the current cluster, but the evidence here is still limited.",
        },
        relatedSummaries: [],
        findings: [],
        snippets: [],
        providers: [],
        estimatedMonthlyCost: null,
        reviewQuestion: "Check this API path.",
      },
    ],
    snapshot,
    scored
  );

  assert.deepEqual(context.meta.providers, ["openai"]);
});

run("buildExportContext filters junk provider names and normalizes case/style variants", () => {
  const snapshot = buildSnapshot({
    apiCalls: [
      {
        file: "./src/a.ts",
        line: 1,
        method: "POST",
        url: "https://api.openai.com/v1/chat/completions",
        provider: "Open_AI",
      },
      {
        file: "./src/b.ts",
        line: 1,
        method: "POST",
        url: "https://api.stripe.com/v1/payment_intents",
        provider: " STRIPE ",
      },
      {
        file: "./src/c.ts",
        line: 1,
        method: "GET",
        url: "/local/path",
        provider: "Fs",
      },
      {
        file: "./src/d.ts",
        line: 1,
        method: "GET",
        url: "/local/path",
        provider: "node:assert/strict",
      },
      {
        file: "./src/e.ts",
        line: 1,
        method: "GET",
        url: "/local/path",
        provider: "./helpers/assertions",
      },
      {
        file: "./src/f.ts",
        line: 1,
        method: "GET",
        url: "/local/path",
        provider: "Path",
      },
      {
        file: "./src/g.ts",
        line: 1,
        method: "GET",
        url: "/local/path",
        provider: "Vscode",
      },
    ],
    findings: [],
  });

  const scored = scoreRepoIntelligence(snapshot);
  const context = buildExportContext([], snapshot, scored);
  assert.deepEqual(context.meta.providers, ["openai", "stripe"]);
});

run("buildExportContext derives contextProviders only from rendered canonical file paths", () => {
  const snapshot = buildSnapshot({
    apiCalls: [
      {
        file: "./src/runtime.ts",
        line: 2,
        method: "POST",
        url: "https://api.openai.com/v1/chat/completions",
        provider: "openai",
      },
    ],
    findings: [
      {
        id: "rendered-xai",
        type: "cache",
        severity: "low",
        riskScore: 1,
        confidence: 0.5,
        description: "Rendered provider wrapper context",
        affectedFile: "./src/chat/providers/xai.ts",
        line: 3,
        evidence: ["wrapper"],
      },
      {
        id: "rendered-mistral",
        type: "cache",
        severity: "low",
        riskScore: 1,
        confidence: 0.5,
        description: "Rendered provider pattern context",
        affectedFile: "./src/scanner/patterns/provider-mistral.ts",
        line: 3,
        evidence: ["pattern"],
      },
      {
        id: "hidden-perplexity",
        type: "cache",
        severity: "low",
        riskScore: 1,
        confidence: 0.5,
        description: "Hidden provider wrapper context",
        affectedFile: "./src/chat/providers/perplexity.ts",
        line: 3,
        evidence: ["hidden"],
      },
      {
        id: "noncanonical-openai",
        type: "cache",
        severity: "low",
        riskScore: 1,
        confidence: 0.5,
        description: "Non-canonical provider filename",
        affectedFile: "./src/providers/openai.ts",
        line: 3,
        evidence: ["noncanonical"],
      },
    ],
  });

  const context = buildExportContext(
    [
      {
        id: "cluster:src/runtime.ts",
        primarySummary: {
          filePath: "src/runtime.ts",
          description: "This file contains 1 API call in a focused request path.",
          providers: ["openai"],
          topRisks: ["Potential relevant API path"],
          estimatedMonthlyCost: null,
          whyItMatters: "This file contains an API path in the current cluster, but the evidence here is still limited.",
        },
        relatedSummaries: [
          {
            filePath: "src/chat/providers/xai.ts",
            description: "This file contains wrapper context.",
            providers: [],
            topRisks: ["Potential relevant API path"],
            estimatedMonthlyCost: null,
            whyItMatters: "This file contains an API path in the current cluster, but the evidence here is still limited.",
          },
          {
            filePath: "src/providers/openai.ts",
            description: "This file contains wrapper context.",
            providers: [],
            topRisks: ["Potential relevant API path"],
            estimatedMonthlyCost: null,
            whyItMatters: "This file contains an API path in the current cluster, but the evidence here is still limited.",
          },
        ],
        findings: [],
        snippets: [],
        providers: ["openai"],
        estimatedMonthlyCost: null,
        reviewQuestion: "Check runtime path.",
      },
      {
        id: "cluster:src/scanner/patterns/provider-mistral.ts",
        primarySummary: {
          filePath: "src/scanner/patterns/provider-mistral.ts",
          description: "This file contains scanner pattern context.",
          providers: [],
          topRisks: ["Potential relevant API path"],
          estimatedMonthlyCost: null,
          whyItMatters: "This file contains an API path in the current cluster, but the evidence here is still limited.",
        },
        relatedSummaries: [],
        findings: [],
        snippets: [],
        providers: [],
        estimatedMonthlyCost: null,
        reviewQuestion: "Check scanner path.",
      },
    ],
    snapshot,
    {
      snapshot,
      scoredFiles: [
        {
          filePath: "src/chat/providers/xai.ts",
          fileId: "src/chat/providers/xai.ts",
          scores: { importance: 8, costLeak: 8, reliabilityRisk: 8, aiReviewPriority: 8 },
          reasons: ["Cache-capable calls without cache finding"],
        },
        {
          filePath: "src/providers/openai.ts",
          fileId: "src/providers/openai.ts",
          scores: { importance: 7, costLeak: 7, reliabilityRisk: 7, aiReviewPriority: 7 },
          reasons: ["Cache-capable calls without cache finding"],
        },
        {
          filePath: "src/runtime.ts",
          fileId: "src/runtime.ts",
          scores: { importance: 6, costLeak: 6, reliabilityRisk: 6, aiReviewPriority: 6 },
          reasons: ["1 API calls"],
        },
      ],
      rankedProviders: [],
      rankedFindings: [],
    }
  );

  assert.deepEqual(context.meta.providers, ["openai"]);
  assert.deepEqual(context.meta.contextProviders, ["mistral", "xai"]);
  assert.ok(!context.meta.contextProviders?.includes("perplexity"));
  assert.ok(!context.meta.contextProviders?.includes("openai"));
});

run("buildExportContext prefers non-test top files when runtime files exist", () => {
  const snapshot = buildSnapshot({
    apiCalls: [
      {
        file: "./src/runtime.ts",
        line: 2,
        method: "POST",
        url: "https://api.openai.com/v1/chat/completions",
        provider: "openai",
      },
      {
        file: "./src/test/runtime.test.ts",
        line: 2,
        method: "POST",
        url: "https://api.openai.com/v1/chat/completions",
        provider: "openai",
      },
    ],
    findings: [],
  });

  const context = buildExportContext(
    [
      {
        id: "cluster:src/runtime.ts",
        primarySummary: {
          filePath: "src/runtime.ts",
          description: "This file contains 1 API call in a focused request path.",
          providers: ["openai"],
          topRisks: ["Rate-limit risk"],
          estimatedMonthlyCost: null,
          whyItMatters: "This file surfaces rate-limit signals around API calls and should be reviewed for guardrails.",
        },
        relatedSummaries: [],
        findings: [],
        snippets: [],
        providers: ["openai"],
        estimatedMonthlyCost: null,
        reviewQuestion: "Check runtime path.",
      },
      {
        id: "cluster:src/test/runtime.test.ts",
        primarySummary: {
          filePath: "src/test/runtime.test.ts",
          description: "This test file combines 1 API call with 1 surfaced finding.",
          providers: ["openai"],
          topRisks: ["Rate-limit risk"],
          estimatedMonthlyCost: null,
          whyItMatters: "This test file surfaces rate-limit-related signals that may help reproduce guardrail gaps.",
        },
        relatedSummaries: [],
        findings: [],
        snippets: [],
        providers: ["openai"],
        estimatedMonthlyCost: null,
        reviewQuestion: "Check test path.",
      },
    ],
    snapshot,
    {
      snapshot,
      scoredFiles: [
        {
          filePath: "src/runtime.ts",
          fileId: "src/runtime.ts",
          scores: { importance: 9, costLeak: 8, reliabilityRisk: 7, aiReviewPriority: 9 },
          reasons: ["Contains parallel traffic"],
        },
        {
          filePath: "src/test/runtime.test.ts",
          fileId: "src/test/runtime.test.ts",
          scores: { importance: 10, costLeak: 10, reliabilityRisk: 9, aiReviewPriority: 8 },
          reasons: ["Contains parallel traffic"],
        },
      ],
      rankedProviders: [],
      rankedFindings: [],
    }
  );

  assert.equal(context.summary.topFiles[0]?.filePath, "src/runtime.ts");
  assert.ok(!context.summary.topFiles.some((file) => file.filePath === "src/test/runtime.test.ts"));
});

run("buildExportContext uses scanned-file total instead of signal-file total", () => {
  const snapshot = buildSnapshot({
    apiCalls: [
      {
        file: "./src/runtime.ts",
        line: 2,
        method: "GET",
        url: "https://api.openai.com/v1/models",
        provider: "openai",
      },
    ],
    findings: [],
    totalFilesScanned: 26,
  });

  const scored = scoreRepoIntelligence(snapshot);
  const context = buildExportContext([], snapshot, scored, { generatorVersion: "0.1.0" });
  const markdown = formatAsMarkdown(context);

  assert.equal(Object.keys(snapshot.files).length, 1);
  assert.equal(context.meta.totalFiles, 26);
  assert.equal(context.meta.generatorVersion, "0.1.0");
  assert.match(markdown, /Generator: ReCost 0\.1\.0/);
  assert.match(markdown, /Files scanned: 26/);
});

run("formatAsMarkdown clarifies cluster-vs-primary providers and softens heuristic-only risks", () => {
  const context: ExportedContext = {
    meta: {
      projectName: "demo-project",
      generatedAt: "2026-03-26T12:00:00.000Z",
      generatorVersion: "0.1.0",
      totalFiles: 10,
      totalClusters: 1,
      providers: ["anthropic", "openai"],
      contextProviders: ["xai"],
    },
    summary: {
      topFiles: [
        {
          filePath: "src/chat/providers/xai.ts",
          whyItMatters: "This file makes cache-capable reads without cache evidence, so it may be doing avoidable repeated work.",
        },
      ],
      keyRisks: ["Potential missing caching on hot path"],
      costLeaks: [],
    },
    providerSummary: [],
    clusters: [
      {
        id: "cluster:src/chat/providers/xai.ts",
        primarySummary: {
          filePath: "src/chat/providers/xai.ts",
          description: "This file contains 1 API call in a focused request path.",
          providers: ["anthropic"],
          topRisks: ["Potential missing caching on hot path"],
          estimatedMonthlyCost: null,
          whyItMatters: "This file makes cache-capable reads without cache evidence, so it may be doing avoidable repeated work.",
        },
        relatedSummaries: [],
        findings: [],
        snippets: [],
        providers: ["anthropic", "openai"],
        estimatedMonthlyCost: null,
        reviewQuestion: "Check provider wrapper path.",
      },
    ],
  };

  const markdown = formatAsMarkdown(context);
  assert.match(markdown, /Detected providers: Anthropic, OpenAI/);
  assert.match(markdown, /Provider-related files in rendered context: xAI/);
  assert.match(markdown, /### Providers/);
  assert.match(markdown, /Detected in cluster: Anthropic, OpenAI/);
  assert.match(markdown, /Detected in primary file: Anthropic/);
  assert.match(markdown, /Added by related files: OpenAI/);
  assert.match(markdown, /Primary file identity: xAI \(from file path only\)/);
  assert.match(markdown, /- Potential missing caching on hot path/);
});

run("buildExportContext keeps potential heuristic risks in the top-level summary", () => {
  const snapshot = buildSnapshot({
    apiCalls: [
      {
        file: "./src/chat/providers/xai.ts",
        line: 2,
        method: "GET",
        url: "https://api.openai.com/v1/models",
        provider: "openai",
        cacheCapable: true,
      },
    ],
    findings: [],
  });

  const scored = scoreRepoIntelligence(snapshot);
  const context = buildExportContext(
    [
      {
        id: "cluster:src/chat/providers/xai.ts",
        primarySummary: {
          filePath: "src/chat/providers/xai.ts",
          description: "This file contains 1 API call in a focused request path.",
          providers: ["openai"],
          topRisks: ["Potential missing caching on hot path"],
          estimatedMonthlyCost: null,
          whyItMatters: "This file makes cache-capable reads without cache evidence, so it may be doing avoidable repeated work.",
        },
        relatedSummaries: [],
        findings: [],
        snippets: [],
        providers: ["openai"],
        estimatedMonthlyCost: null,
        reviewQuestion: "Check provider wrapper path.",
      },
    ],
    snapshot,
    scored
  );

  assert.deepEqual(context.summary.keyRisks, ["Potential missing caching on hot path"]);
});

run("buildExportContext upgrades heuristic risks when confirmed evidence exists", () => {
  const snapshot = buildSnapshot({
    apiCalls: [
      {
        file: "./src/runtime.ts",
        line: 2,
        method: "GET",
        url: "https://api.openai.com/v1/models",
        provider: "openai",
        cacheCapable: true,
      },
    ],
    findings: [],
  });

  const scored = scoreRepoIntelligence(snapshot);
  const context = buildExportContext(
    [
      {
        id: "cluster:src/runtime.ts",
        primarySummary: {
          filePath: "src/runtime.ts",
          description: "This file contains 1 API call in a focused request path.",
          providers: ["openai"],
          topRisks: ["Potential missing caching on hot path"],
          estimatedMonthlyCost: null,
          whyItMatters: "This file makes cache-capable reads without cache evidence, so it may be doing avoidable repeated work.",
        },
        relatedSummaries: [],
        findings: [
          {
            title: "Missing caching",
            severity: "medium",
            description: "Confirmed cache gap.",
            estimatedMonthlyCost: null,
          },
        ],
        snippets: [],
        providers: ["openai"],
        estimatedMonthlyCost: null,
        reviewQuestion: "Check provider wrapper path.",
      },
    ],
    snapshot,
    scored
  );

  assert.deepEqual(context.summary.keyRisks, ["Missing caching on hot path"]);
});

run("buildExportContext prefers non-generated non-tooling top files when runtime files exist", () => {
  const snapshot = buildSnapshot({
    apiCalls: [
      {
        file: "./src/runtime.ts",
        line: 2,
        method: "POST",
        url: "https://api.openai.com/v1/chat/completions",
        provider: "openai",
      },
      {
        file: "./dashboard-dist/assets/index-abc123.js",
        line: 2,
        method: "POST",
        url: "https://api.openai.com/v1/chat/completions",
        provider: "openai",
      },
      {
        file: "./src/scanner/patterns/provider-gemini.ts",
        line: 2,
        method: "POST",
        url: "https://generativelanguage.googleapis.com/v1beta/models/gemini:generateContent",
        provider: "gemini",
      },
    ],
    findings: [],
  });

  const context = buildExportContext(
    [
      {
        id: "cluster:src/runtime.ts",
        primarySummary: {
          filePath: "src/runtime.ts",
          description: "This file contains 1 API call in a focused request path.",
          providers: ["openai"],
          topRisks: ["Rate-limit risk"],
          estimatedMonthlyCost: null,
          whyItMatters: "This file surfaces rate-limit signals around API calls and should be reviewed for guardrails.",
        },
        relatedSummaries: [],
        findings: [],
        snippets: [],
        providers: ["openai"],
        estimatedMonthlyCost: null,
        reviewQuestion: "Check runtime path.",
      },
      {
        id: "cluster:dashboard-dist/assets/index-abc123.js",
        primarySummary: {
          filePath: "dashboard-dist/assets/index-abc123.js",
          description: "This file repeats endpoint patterns.",
          providers: ["openai"],
          topRisks: ["Repeated endpoint calls"],
          estimatedMonthlyCost: null,
          whyItMatters: "This file repeats endpoint patterns, which can amplify request volume.",
        },
        relatedSummaries: [],
        findings: [],
        snippets: [],
        providers: ["openai"],
        estimatedMonthlyCost: null,
        reviewQuestion: "Check generated path.",
      },
      {
        id: "cluster:src/scanner/patterns/provider-gemini.ts",
        primarySummary: {
          filePath: "src/scanner/patterns/provider-gemini.ts",
          description: "This file repeats endpoint patterns.",
          providers: ["gemini"],
          topRisks: ["Repeated endpoint calls"],
          estimatedMonthlyCost: null,
          whyItMatters: "This file repeats endpoint patterns, which can amplify request volume.",
        },
        relatedSummaries: [],
        findings: [],
        snippets: [],
        providers: ["gemini"],
        estimatedMonthlyCost: null,
        reviewQuestion: "Check tooling path.",
      },
    ],
    snapshot,
    {
      snapshot,
      scoredFiles: [
        {
          filePath: "dashboard-dist/assets/index-abc123.js",
          fileId: "dashboard-dist/assets/index-abc123.js",
          scores: { importance: 10, costLeak: 10, reliabilityRisk: 10, aiReviewPriority: 1 },
          reasons: ["Contains parallel traffic"],
        },
        {
          filePath: "src/scanner/patterns/provider-gemini.ts",
          fileId: "src/scanner/patterns/provider-gemini.ts",
          scores: { importance: 9, costLeak: 9, reliabilityRisk: 9, aiReviewPriority: 1 },
          reasons: ["Contains parallel traffic"],
        },
        {
          filePath: "src/runtime.ts",
          fileId: "src/runtime.ts",
          scores: { importance: 8, costLeak: 8, reliabilityRisk: 8, aiReviewPriority: 8 },
          reasons: ["Contains parallel traffic"],
        },
      ],
      rankedProviders: [],
      rankedFindings: [],
    }
  );

  assert.equal(context.summary.topFiles[0]?.filePath, "src/runtime.ts");
  assert.ok(!context.summary.topFiles.some((file) => file.filePath === "dashboard-dist/assets/index-abc123.js"));
  assert.ok(!context.summary.topFiles.some((file) => file.filePath === "src/scanner/patterns/provider-gemini.ts"));
});

(async () => {
  for (const test of pendingTests) {
    await test();
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
