import assert from "node:assert/strict";
import { validateRcApiKey, validateApiKey } from "../api-client";

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

function installFetch(
  handler: (input: FetchInput, init: FetchInit) => Response | Promise<Response>
) {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: FetchInput, init?: FetchInit) =>
    handler(input, init)) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

async function runTests() {
  // -------- validateRcApiKey --------
  // Returns Promise<void>; throws on non-rc- prefix and on any non-OK response from /projects?limit=1.

  // 1. validateRcApiKey rejects keys that don't start with rc- (no fetch made)
  {
    let called = false;
    const restore = installFetch(() => {
      called = true;
      return new Response("", { status: 200 });
    });
    try {
      await assert.rejects(() => validateRcApiKey("sk-1234"), /rc-/);
      assert.equal(called, false, "fetch should not be called for malformed key");
    } finally {
      restore();
    }
  }

  // 2. validateRcApiKey throws on 401 from backend
  {
    const restore = installFetch(
      () =>
        new Response(JSON.stringify({ error: { message: "invalid" } }), { status: 401 })
    );
    try {
      await assert.rejects(() => validateRcApiKey("rc-bad"));
    } finally {
      restore();
    }
  }

  // 3. validateRcApiKey resolves (void) on 200
  {
    const restore = installFetch(
      () => new Response(JSON.stringify({ data: [] }), { status: 200 })
    );
    try {
      const result = await validateRcApiKey("rc-good");
      assert.equal(result, undefined, "validateRcApiKey should resolve to undefined on 200");
    } finally {
      restore();
    }
  }

  // -------- validateApiKey (the /auth/me variant) --------
  // Returns AuthMeUser on 200; throws on 404, 401, network errors, or bad prefix.

  // 4. validateApiKey rejects keys that don't start with rc- (no fetch made)
  {
    let called = false;
    const restore = installFetch(() => {
      called = true;
      return new Response("", { status: 200 });
    });
    try {
      await assert.rejects(() => validateApiKey("sk-1234"), /rc-/);
      assert.equal(called, false, "fetch should not be called for malformed key");
    } finally {
      restore();
    }
  }

  // 5. validateApiKey throws with status: 404 when /auth/me returns 404
  {
    const restore = installFetch(() => new Response("", { status: 404 }));
    try {
      let caught: (Error & { status?: number }) | null = null;
      try {
        await validateApiKey("rc-validlooking");
      } catch (err) {
        caught = err as Error & { status?: number };
      }
      assert.ok(caught, "expected validateApiKey to throw on 404");
      assert.equal(caught!.status, 404);
    } finally {
      restore();
    }
  }

  // 6. validateApiKey throws on 401
  {
    const restore = installFetch(
      () =>
        new Response(JSON.stringify({ error: { message: "invalid" } }), { status: 401 })
    );
    try {
      await assert.rejects(() => validateApiKey("rc-bad"));
    } finally {
      restore();
    }
  }

  // 7. validateApiKey returns user payload on 200
  {
    const restore = installFetch(
      () =>
        new Response(JSON.stringify({ data: { email: "x@y.z" } }), { status: 200 })
    );
    try {
      const r = await validateApiKey("rc-good");
      assert.equal((r as { email: string }).email, "x@y.z");
    } finally {
      restore();
    }
  }

  console.log("PASS api-client");
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
