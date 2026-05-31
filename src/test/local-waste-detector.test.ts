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
  assert.equal(inlineParallel?.type, "unbatched_parallel", "inline-parallel finding must be unbatched_parallel");
});

run("regex path flags Array.from bounded-replication fanout as unbatched_parallel (guard removal regression)", () => {
  const text = [
    "async function generateVariants(prompt) {",
    "  return Promise.all(Array.from({ length: 4 }).map(() => openai.images.generate({ prompt })));",
    "}",
  ].join("\n");
  const findings = detectLocalWasteFindingsInText("src/lib/variants.ts", text);
  const inlineParallel = findings.find((finding) => finding.id.includes("inline_parallel"));
  assert.ok(inlineParallel, "expected an inline-parallel finding for Array.from fanout over images.generate");
  assert.equal(inlineParallel?.type, "unbatched_parallel", "inline-parallel finding must be unbatched_parallel");
});

run("#112: bare 'cache' in a comment does not suppress a cache finding", () => {
  const text = [
    "// we should cache this someday but do not yet",
    "export async function loadUsers(ids) {",
    "  const out = [];",
    "  for (const id of ids) {",
    "    out.push(await fetch(`https://api.example.com/users/${id}`));",
    "  }",
    "  return out;",
    "}",
  ].join("\n");
  const findings = detectLocalWasteFindingsInText("src/users.ts", text);
  assert.ok(findings.some((f) => f.type === "cache"), "expected a cache finding despite the comment word");
});

run("#112: bare 'batch' in a comment does not suppress a batch finding", () => {
  const text = [
    "// batch these calls in a follow-up PR",
    "export async function embedAll(items) {",
    "  for (const it of items) {",
    "    await openai.embeddings.create({ input: it });",
    "  }",
    "}",
  ].join("\n");
  const findings = detectLocalWasteFindingsInText("src/embed.ts", text);
  assert.ok(findings.some((f) => f.type === "batch"), "expected a batch finding despite the comment word");
});

run("#112: a real cache mechanism in code still suppresses the cache finding", () => {
  const text = [
    "import { queryClient } from './qc';",
    "export async function loadUsers(ids) {",
    "  const out = [];",
    "  for (const id of ids) {",
    "    out.push(await queryClient.fetchQuery(['u', id], () => fetch(`/users/${id}`), { staleTime: 60000 }));",
    "  }",
    "  return out;",
    "}",
  ].join("\n");
  const findings = detectLocalWasteFindingsInText("src/users2.ts", text);
  assert.ok(!findings.some((f) => f.type === "cache"), "real staleTime/queryClient guard should still suppress");
});

run("#112: a real cache option on the same line as an https:// URL still suppresses", () => {
  const text = [
    "export async function loadUsers(ids) {",
    "  const out = [];",
    "  for (const id of ids) {",
    "    out.push(await fetch(`https://api.example.com/users/${id}`, { cache: 'force-cache' }));",
    "  }",
    "  return out;",
    "}",
  ].join("\n");
  const findings = detectLocalWasteFindingsInText("src/users3.ts", text);
  assert.ok(!findings.some((f) => f.type === "cache"), "inline cache option must still suppress despite the https:// URL");
});

run("#112: bare 'cleanup'/'guard' word in a comment does not suppress", () => {
  const text = [
    "// cleanup this endpoint later",
    "export async function loadItems(ids) {",
    "  const out = [];",
    "  for (const id of ids) {",
    "    out.push(await fetch(`https://api.example.com/items/${id}`));",
    "  }",
    "  return out;",
    "}",
  ].join("\n");
  const findings = detectLocalWasteFindingsInText("src/items.ts", text);
  assert.ok(
    findings.some((f) => f.type === "n_plus_one" || f.type === "cache"),
    "comment-only 'cleanup' must not suppress findings; expected n_plus_one or cache finding"
  );
});

console.log("All local waste detector tests passed");
