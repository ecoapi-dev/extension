import test from "node:test";
import assert from "node:assert/strict";
import { buildRemoteApiCalls } from "../webview/build-remote-api-calls";
import type { ApiCallInput } from "../analysis/types";

function call(over: Partial<ApiCallInput>): ApiCallInput {
  return {
    file: "src/x.ts",
    line: 1,
    method: "GET",
    url: "https://api.openai.com/v1/chat/completions",
    library: "fetch",
    ...over,
  };
}

test("buildRemoteApiCalls passes through known-provider calls unchanged", () => {
  const result = buildRemoteApiCalls([call({ provider: "openai" })]);
  assert.equal(result.submitted.length, 1);
  assert.equal(result.submitted[0].provider, "openai");
  assert.equal(result.unknownProviderCount, 0);
  assert.deepEqual(result.unknownProviderHosts, {});
});

test("buildRemoteApiCalls fills missing provider via URL detection", () => {
  const result = buildRemoteApiCalls([call({ provider: undefined })]);
  assert.equal(result.submitted.length, 1);
  assert.equal(result.submitted[0].provider, "openai");
  assert.equal(result.unknownProviderCount, 0);
});

test("buildRemoteApiCalls keeps unrecognized-host calls and tags them 'unknown'", () => {
  const result = buildRemoteApiCalls([
    call({ url: "https://acme.fictional/data", provider: undefined }),
    call({ url: "https://internal.example/x", provider: undefined }),
    call({ url: "https://acme.fictional/data2", provider: undefined }),
  ]);
  assert.equal(result.submitted.length, 3);
  for (const c of result.submitted) assert.equal(c.provider, "unknown");
  assert.equal(result.unknownProviderCount, 3);
  assert.deepEqual(result.unknownProviderHosts, {
    "acme.fictional": 2,
    "internal.example": 1,
  });
});

test("buildRemoteApiCalls drops calls that fail shouldSubmitRemote (no library / low-confidence URL)", () => {
  const result = buildRemoteApiCalls([
    call({ library: undefined, url: "https://api.openai.com/v1/chat" }),
    call({ url: "${ENDPOINT}/x", library: "fetch" }),
  ]);
  assert.equal(result.submitted.length, 0);
  assert.equal(result.unknownProviderCount, 0);
});
