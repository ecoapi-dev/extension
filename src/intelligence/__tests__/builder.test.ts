import assert from "node:assert/strict";
import { buildRepoIntelligenceSnapshot } from "../builder";

function run(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

run("buildRepoIntelligenceSnapshot normalizes paths, stores null providers, and aggregates by file/provider", () => {
  const snapshot = buildRepoIntelligenceSnapshot({
    apiCalls: [
      {
        file: ".\\src\\worker.ts",
        line: 10,
        method: "POST",
        url: "https://api.openai.com/v1/chat/completions",
        provider: "openai",
        costModel: "per_token",
        frequencyClass: "unbounded-loop",
        library: "openai",
        cacheCapable: false,
        batchCapable: false,
      },
      {
        file: "./src/payments.ts",
        line: 15,
        method: "POST",
        url: "https://api.stripe.com/v1/payment_intents",
        provider: "stripe",
        costModel: "per_transaction",
        frequencyClass: "polling",
        library: "stripe",
      },
      {
        file: "./src/payments.ts",
        line: 40,
        method: "GET",
        url: "https://api.stripe.com/v1/customers",
        provider: "stripe",
        costModel: "per_request",
        frequencyClass: "single",
        library: "stripe",
      },
      {
        file: "./src/regex-only.ts",
        line: 22,
        method: "GET",
        url: "/internal/status",
        frequency: "daily",
        library: "fetch",
      },
      {
        file: "./src/unknown.ts",
        line: 7,
        method: "GET",
        url: "sdk://custom/status",
        provider: undefined,
        frequency: "per-request",
        library: "custom-client",
      },
    ],
    findings: [
      {
        id: "finding-a",
        type: "rate_limit",
        severity: "high",
        confidence: 0.9,
        description: "Polling call can hit limits",
        affectedFile: "./src/payments.ts",
        line: 14,
        evidence: ["setInterval nearby"],
      },
      {
        id: "finding-b",
        type: "concurrency_control",
        severity: "medium",
        confidence: 0.8,
        description: "Loop fanout lacks limiter",
        affectedFile: ".\\src\\worker.ts",
        line: 12,
        evidence: ["Promise.all in loop"],
      },
      {
        id: "finding-only",
        type: "cache",
        severity: "low",
        confidence: 0.6,
        description: "Could cache this response",
        affectedFile: "./src/findings-only.ts",
        line: 5,
        evidence: ["Repeated reads"],
      },
      {
        type: "redundancy",
        severity: "low",
        confidence: 0.55,
        description: "No stable ID upstream",
        affectedFile: "./src/payments.ts",
        evidence: ["duplicate request"],
      } as unknown as import("../../scanner/local-waste-detector").LocalWasteFinding,
    ],
    repoRoot: "/repo",
  });

  assert.deepEqual(Object.keys(snapshot.files).sort(), [
    "src/findings-only.ts",
    "src/payments.ts",
    "src/regex-only.ts",
    "src/unknown.ts",
    "src/worker.ts",
  ]);

  assert.equal(snapshot.totalFilesScanned, 5);
  assert.equal(snapshot.files["src/findings-only.ts"].apiCallIds.length, 0);
  assert.equal(snapshot.files["src/findings-only.ts"].findingIds.length, 1);

  const workerCall = Object.values(snapshot.apiCalls).find((apiCall) => apiCall.filePath === "src/worker.ts" && apiCall.line === 10);
  assert.ok(workerCall);
  assert.equal(workerCall.provider, "openai");
  assert.equal(workerCall.library, "openai");
  assert.equal(workerCall.filePath, "src/worker.ts");

  const stripeCall = Object.values(snapshot.apiCalls).find((apiCall) => apiCall.filePath === "src/payments.ts" && apiCall.line === 15);
  assert.ok(stripeCall);
  assert.equal(stripeCall.provider, "stripe");
  assert.equal(stripeCall.library, "stripe");

  const regexOnlyCall = Object.values(snapshot.apiCalls).find((apiCall) => apiCall.filePath === "src/regex-only.ts" && apiCall.line === 22);
  assert.ok(regexOnlyCall);
  assert.equal(regexOnlyCall.provider, null);
  assert.equal(regexOnlyCall.frequencyClass, null);

  const unknownCall = Object.values(snapshot.apiCalls).find((apiCall) => apiCall.filePath === "src/unknown.ts" && apiCall.line === 7);
  assert.ok(unknownCall);
  assert.equal(unknownCall.provider, null);
  assert.equal(unknownCall.library, "custom-client");

  const synthesizedFindingId = Object.keys(snapshot.findings).find((id) => id.startsWith("finding:src/payments.ts:null:redundancy:"));
  assert.ok(synthesizedFindingId);
  assert.equal(snapshot.findings["finding-a"].line, 14);
  assert.equal(snapshot.findings["finding-b"].line, 12);
  assert.equal(snapshot.findings["finding-only"].line, 5);
  assert.equal(snapshot.findings[synthesizedFindingId!].line, null);

  assert.deepEqual(snapshot.files["src/payments.ts"].providers, ["stripe"]);
  assert.deepEqual(snapshot.files["src/unknown.ts"].providers, []);
  assert.deepEqual(snapshot.providers.openai.fileIds, ["src/worker.ts"]);
  assert.deepEqual(snapshot.providers.stripe.findingIds, ["finding-a"]);
  assert.deepEqual(snapshot.providers.stripe.urls, [
    "https://api.stripe.com/v1/customers",
    "https://api.stripe.com/v1/payment_intents",
  ]);
  assert.deepEqual(snapshot.providers.stripe.costModels, ["per_request", "per_transaction"]);
  assert.equal(snapshot.providers.openai.findingIds[0], "finding-b");
});

run("buildRepoIntelligenceSnapshot validates provider lists against file apiCalls", () => {
  const snapshot = buildRepoIntelligenceSnapshot({
    apiCalls: [
      {
        file: "./src/mixed.ts",
        line: 5,
        method: "GET",
        url: "https://api.openai.com/v1/models",
        provider: "openai",
      },
      {
        file: "./src/mixed.ts",
        line: 9,
        method: "GET",
        url: "/health",
      },
    ],
    findings: [],
  });

  assert.deepEqual(snapshot.files["src/mixed.ts"].providers, ["openai"]);
});

run("buildRepoIntelligenceSnapshot preserves explicit scanned-file totals", () => {
  const snapshot = buildRepoIntelligenceSnapshot({
    apiCalls: [
      {
        file: "./src/runtime.ts",
        line: 5,
        method: "GET",
        url: "https://api.openai.com/v1/models",
        provider: "openai",
      },
    ],
    findings: [],
    totalFilesScanned: 26,
  });

  assert.equal(Object.keys(snapshot.files).length, 1);
  assert.equal(snapshot.totalFilesScanned, 26);
});

run("buildRepoIntelligenceSnapshot keeps distinct same-line API calls with deterministic unique ids", () => {
  const snapshot = buildRepoIntelligenceSnapshot({
    apiCalls: [
      {
        file: "./dist-test/api-client.js",
        line: 43,
        method: "POST",
        url: "/projects/${projectId}/scans",
        library: "fetch",
        provider: undefined,
      },
      {
        file: "./dist-test/api-client.js",
        line: 43,
        method: "GET",
        url: "/projects/${projectId}/scans",
        library: "axios",
        provider: undefined,
      },
    ],
    findings: [],
  });

  const calls = Object.values(snapshot.apiCalls).filter((apiCall) => apiCall.filePath === "dist-test/api-client.js");
  assert.equal(calls.length, 2);
  assert.equal(new Set(calls.map((apiCall) => apiCall.id)).size, 2);
  assert.ok(calls.every((apiCall) => /^ep_[a-z0-9]+(?:_L\d+)?$/.test(apiCall.id)));
});
