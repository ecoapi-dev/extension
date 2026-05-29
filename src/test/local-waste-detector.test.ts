import assert from "node:assert/strict";
import { detectLocalWasteFindingsInText } from "../scanner/local-waste-detector";

function run(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

run("detects n+1 and concurrency fanout in route handlers", () => {
  const text = [
    "router.get('/users', async (req, res) => {",
    "  await Promise.all(userIds.map((id) => client.responses.create({ model: 'gpt-4.1-mini', input: id })));",
    "});",
  ].join("\n");
  const findings = detectLocalWasteFindingsInText("src/routes/users.ts", text);
  assert.ok(findings.some((finding) => finding.type === "n_plus_one" && finding.severity === "high"));
  assert.ok(findings.some((finding) => finding.type === "concurrency_control" && finding.confidence >= 0.7));
});

run("suppresses cache finding when query client caching is nearby", () => {
  const text = [
    "useEffect(() => {",
    "  queryClient.fetchQuery(['user', id], () => fetch(`/api/users/${id}`));",
    "}, [id]);",
  ].join("\n");
  const findings = detectLocalWasteFindingsInText("src/app/profile.tsx", text);
  assert.ok(!findings.some((finding) => finding.type === "cache"));
});

run("detects repeated config and auth lookup redundancy", () => {
  const text = [
    "router.get('/profile', async (req, res) => {",
    "  const session = await auth.getSession();",
    "  const config = getConfig();",
    "  await fetch('https://api.example.com/profile');",
    "});",
  ].join("\n");
  const findings = detectLocalWasteFindingsInText("src/routes/profile.ts", text);
  const redundancy = findings.find((finding) => finding.type === "redundancy");
  assert.ok(redundancy);
  assert.ok((redundancy?.evidence ?? []).some((item) => /Auth\/session\/config/.test(item)));
});

run("reduces confidence when polling already has backoff and concurrency guards", () => {
  const text = [
    "setInterval(async () => {",
    "  await limit(() => client.responses.create({ model: 'gpt-4.1-mini', input: 'ping' }));",
    "  await sleep(backoffMs);",
    "}, 1000);",
  ].join("\n");
  const findings = detectLocalWasteFindingsInText("src/workers/poller.ts", text);
  const rateLimit = findings.find((finding) => finding.type === "rate_limit");
  assert.ok(rateLimit);
  assert.ok((rateLimit?.confidence ?? 1) < 0.75);
});

run("flags inline-parallel fanout for an n/count-capable endpoint (regex-only path)", () => {
  const text = [
    "async function makeThumbnails(prompts) {",
    "  return Promise.all(prompts.map((prompt) => client.images.generate({ prompt })));",
    "}",
  ].join("\n");
  const findings = detectLocalWasteFindingsInText("src/lib/thumbnails.ts", text);
  const inlineParallel = findings.find((finding) => finding.id.includes("inline_parallel"));
  assert.ok(inlineParallel, "expected an inline-parallel finding for images.generate fanout");
  assert.match(inlineParallel?.description ?? "", /n\/count parameter/);
});

console.log("All local waste detector tests passed");
