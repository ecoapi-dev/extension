import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as path from "node:path";

// Resolve the compiled config.js relative to this test file's compiled output.
// Tests compile to dist-test/test/config.test.js; config.js compiles to dist-test/config.js.
const CONFIG_PATH = path.resolve(__dirname, "..", "config.js");

function runConfigInSubprocess(env: Record<string, string | undefined>): {
  api: string;
  dashboard: string;
} {
  const script = `
    const c = require(${JSON.stringify(CONFIG_PATH)});
    process.stdout.write(JSON.stringify({
      api: c.RECOST_API_BASE_URL,
      dashboard: c.RECOST_DASHBOARD_BASE_URL,
    }));
  `;
  const child = spawnSync(process.execPath, ["-e", script], {
    env: { ...process.env, ...env, RECOST_API_BASE_URL: env.RECOST_API_BASE_URL ?? "", RECOST_DASHBOARD_BASE_URL: env.RECOST_DASHBOARD_BASE_URL ?? "" },
    encoding: "utf8",
  });
  if (child.status !== 0) {
    throw new Error(`config subprocess exited ${child.status}: ${child.stderr}`);
  }
  return JSON.parse(child.stdout);
}

async function runTests() {
  // 1. Defaults apply when env vars are unset (passed as empty strings -> trimmed to falsy -> fall back)
  {
    const result = runConfigInSubprocess({});
    assert.equal(result.api, "https://api.recost.dev");
    assert.equal(result.dashboard, "https://recost.dev");
  }

  // 2. Env override applies cleanly
  {
    const result = runConfigInSubprocess({
      RECOST_API_BASE_URL: "https://staging.api.recost.dev",
      RECOST_DASHBOARD_BASE_URL: "https://staging.recost.dev",
    });
    assert.equal(result.api, "https://staging.api.recost.dev");
    assert.equal(result.dashboard, "https://staging.recost.dev");
  }

  // 3. Whitespace-only env vars fall back to defaults
  {
    const result = runConfigInSubprocess({
      RECOST_API_BASE_URL: "   ",
      RECOST_DASHBOARD_BASE_URL: "\t\n",
    });
    assert.equal(result.api, "https://api.recost.dev");
    assert.equal(result.dashboard, "https://recost.dev");
  }

  console.log("PASS config");
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
