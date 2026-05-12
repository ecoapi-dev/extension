import assert from "node:assert/strict";
import { maskUrlDynamicParts } from "../scanner/url-template";

async function run(name: string, fn: () => void | Promise<void>): Promise<void> {
  try { await fn(); console.log(`PASS ${name}`); }
  catch (err) { console.error(`FAIL ${name}`); throw err; }
}

(async () => {
  await run("masks numeric path segments", () => {
    assert.equal(maskUrlDynamicParts("/api/users/123"), "/api/users/:id");
    assert.equal(maskUrlDynamicParts("/api/users/456/posts/789"), "/api/users/:id/posts/:id");
  });

  await run("masks UUIDs", () => {
    assert.equal(
      maskUrlDynamicParts("/orders/550e8400-e29b-41d4-a716-446655440000"),
      "/orders/:id"
    );
  });

  await run("masks template-literal interpolations", () => {
    assert.equal(maskUrlDynamicParts("/users/${userId}/profile"), "/users/:id/profile");
    assert.equal(maskUrlDynamicParts("/users/{userId}/profile"), "/users/:id/profile");
    assert.equal(maskUrlDynamicParts("/users/<userId>/profile"), "/users/:id/profile");
  });

  await run("preserves protocol and host", () => {
    assert.equal(
      maskUrlDynamicParts("https://api.example.com/v1/users/42"),
      "https://api.example.com/v1/users/:id"
    );
  });

  await run("preserves non-numeric path segments", () => {
    assert.equal(
      maskUrlDynamicParts("/api/users/me/preferences"),
      "/api/users/me/preferences"
    );
  });

  await run("strips query and hash", () => {
    assert.equal(maskUrlDynamicParts("/users/123?include=posts"), "/users/:id");
    assert.equal(maskUrlDynamicParts("/users/123#anchor"), "/users/:id");
  });

  await run("noop on sdk-style pseudo-urls", () => {
    assert.equal(
      maskUrlDynamicParts("sdk://openai/chat.completions.create"),
      "sdk://openai/chat.completions.create"
    );
  });

  console.log("url-template.test PASSED");
})().catch((err) => { console.error(err); process.exit(1); });
