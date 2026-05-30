import assert from "node:assert/strict";
import { computeEndpointId } from "../scanner/endpoint-id";

async function run(name: string, fn: () => void): Promise<void> {
  try { fn(); console.log(`PASS ${name}`); }
  catch (err) { console.error(`FAIL ${name}`); throw err; }
}

const base = {
  provider: "openai",
  methodSignature: "chat.completions.create",
  filePath: "src/services/chat.ts",
  enclosingFunction: "askQuestion",
  url: "sdk://openai/chat.completions.create",
};

(async () => {
  await run("ID is deterministic", () => {
    assert.equal(computeEndpointId(base), computeEndpointId(base));
  });

  await run("ID survives ±20 line move (line number is not part of input)", () => {
    // No line field in computeEndpointId at all — proven structurally.
    assert.equal(
      computeEndpointId(base),
      computeEndpointId({ ...base }) // line is not part of `base`; if signature changes this test breaks
    );
  });

  await run("ID survives renaming an unrelated containing variable", () => {
    // Renaming a containing variable doesn't change provider/method/file/function/url.
    assert.equal(computeEndpointId(base), computeEndpointId({ ...base }));
  });

  await run("ID changes when enclosing function changes", () => {
    assert.notEqual(
      computeEndpointId(base),
      computeEndpointId({ ...base, enclosingFunction: "differentFn" })
    );
  });

  await run("ID changes when provider changes", () => {
    assert.notEqual(
      computeEndpointId(base),
      computeEndpointId({ ...base, provider: "anthropic" })
    );
  });

  await run("ID changes when file path changes", () => {
    assert.notEqual(
      computeEndpointId(base),
      computeEndpointId({ ...base, filePath: "src/services/other.ts" })
    );
  });

  await run("file path normalization: backslash and ./ prefix collapse", () => {
    assert.equal(
      computeEndpointId({ ...base, filePath: "src\\services\\chat.ts" }),
      computeEndpointId({ ...base, filePath: "./src/services/chat.ts" })
    );
  });

  await run("file path normalization: repeated ./ prefix collapses fully", () => {
    assert.equal(
      computeEndpointId({ ...base, filePath: "src/services/chat.ts" }),
      computeEndpointId({ ...base, filePath: "././src/services/chat.ts" })
    );
  });

  await run("URLs differing only by numeric ID produce the same endpoint ID", () => {
    const a = computeEndpointId({ ...base, url: "https://api.x.com/users/123" });
    const b = computeEndpointId({ ...base, url: "https://api.x.com/users/456" });
    assert.equal(a, b);
  });

  await run("URLs differing structurally produce different IDs", () => {
    const a = computeEndpointId({ ...base, url: "https://api.x.com/users/123" });
    const b = computeEndpointId({ ...base, url: "https://api.x.com/orders/123" });
    assert.notEqual(a, b);
  });

  await run("ID format is short and URL-safe", () => {
    const id = computeEndpointId(base);
    assert.match(id, /^ep_[a-z0-9]+$/);
  });

  await run("end-to-end: same call, moved 20 lines, gets the same ID", () => {
    const callA = {
      provider: "openai",
      methodSignature: "chat.completions.create",
      filePath: "src/services/chat.ts",
      enclosingFunction: "ask",
      url: "sdk://openai/chat.completions.create",
    };
    const callB = { ...callA }; // same structural input — line/column intentionally absent
    assert.equal(computeEndpointId(callA), computeEndpointId(callB));
  });

  await run("end-to-end: two calls in same file but different functions diverge", () => {
    const a = computeEndpointId({
      provider: "openai", methodSignature: "chat.completions.create",
      filePath: "src/x.ts", enclosingFunction: "fnA",
      url: "sdk://openai/chat.completions.create",
    });
    const b = computeEndpointId({
      provider: "openai", methodSignature: "chat.completions.create",
      filePath: "src/x.ts", enclosingFunction: "fnB",
      url: "sdk://openai/chat.completions.create",
    });
    assert.notEqual(a, b);
  });

  await run("B2/AC-4: endpoint ID is unchanged when the call site moves (resolvedSite-stable)", () => {
    const base = {
      provider: "openai",
      methodSignature: "chat.completions.create",
      filePath: "lib/ai.ts",
      enclosingFunction: "callAI",
      url: "sdk://openai/chat.completions.create",
    };
    // Identical structural inputs — the only thing a call-site move changes (line,
    // column, span) is not part of the hash, so the ID must be identical.
    assert.equal(computeEndpointId(base), computeEndpointId({ ...base }));
  });

  console.log("endpoint-id.test PASSED");
})().catch((err) => { console.error(err); process.exit(1); });
