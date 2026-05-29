import assert from "node:assert/strict";
import { matchNormalizedLine, matchLine, matchRouteDefinitionLine } from "../scanner/patterns";

function run(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

function pickProvider(line: string, provider: string) {
  return matchNormalizedLine(line).find((m) => m.provider === provider);
}

run("keeps existing generic HTTP detection", () => {
  const matches = matchLine("await axios.post('/v1/foo', payload)");
  assert.ok(matches.some((m) => m.method === "POST" && m.url === "/v1/foo"));
});

run("detects openai-compatible custom baseURL host", () => {
  const line = "const client = new OpenAI({ baseURL: 'https://api.together.xyz/v1' }); await client.responses.create({ model: 'x' });";
  const match = pickProvider(line, "together");
  assert.ok(match);
  assert.equal(match?.sdk, "openai-compatible");
  assert.equal(match?.method, "POST");
  assert.match(match?.endpoint ?? "", /api\.together\.xyz\/v1\/responses/);
});

run("detects anthropic messages and batches", () => {
  const line = "await anthropic.messages.create({ model: 'claude' }); await anthropic.messageBatches.create({ requests: [] });";
  const matches = matchNormalizedLine(line).filter((m) => m.provider === "anthropic");
  assert.ok(matches.some((m) => m.endpoint === "https://api.anthropic.com/v1/messages"));
  assert.ok(matches.some((m) => m.endpoint === "https://api.anthropic.com/v1/messages/batches" && m.batchCapable));
});

run("detects gemini generate and file methods", () => {
  const line = "await genai.models.generateContent({}); await client.files.upload(file);";
  const matches = matchNormalizedLine(line).filter((m) => m.provider === "gemini");
  assert.ok(matches.some((m) => /:generateContent$/.test(m.endpoint ?? "")));
  assert.ok(matches.some((m) => /\/upload\/v1beta\/files/.test(m.endpoint ?? "")));
});

run("detects bedrock runtime commands", () => {
  const line = "await client.send(new ConverseStreamCommand({ modelId }));";
  const match = pickProvider(line, "aws-bedrock");
  assert.ok(match);
  assert.equal(match?.streaming, true);
  assert.match(match?.endpoint ?? "", /converse-stream/);
});

run("detects vertex ai SDK call", () => {
  const line = "await vertex.generateContent({ model: 'gemini-2.0-pro' });";
  const match = pickProvider(line, "vertex-ai");
  assert.ok(match);
  assert.match(match?.endpoint ?? "", /aiplatform\.googleapis\.com/);
});

run("detects graphql fetch and operation name", () => {
  const line = "fetch('/graphql', { method: 'POST', body: JSON.stringify({ query: 'query GetUsers { users { id } }', variables }) });";
  const match = matchNormalizedLine(line).find((m) => m.kind === "graphql");
  assert.ok(match);
  assert.equal(match?.action, "query");
  assert.equal(match?.operationName, "GetUsers");
});

run("detects supabase CRUD and firebase listeners", () => {
  const line = "await supabase.from('todos').select('*'); onSnapshot(ref, () => {});";
  const matches = matchNormalizedLine(line);
  assert.ok(matches.some((m) => m.provider === "supabase" && m.action === "select"));
  assert.ok(matches.some((m) => m.provider === "firebase" && m.streaming));
});

run("detects cohere and mistral", () => {
  const line = "await cohere.embed({}); await mistral.chat.stream({});";
  const matches = matchNormalizedLine(line);
  assert.ok(matches.some((m) => m.provider === "cohere" && m.action === "embed"));
  assert.ok(matches.some((m) => m.provider === "mistral" && m.streaming));
});

run("detects stripe create calls", () => {
  const line = "await stripe.paymentIntents.create({ amount: 10, currency: 'usd' });";
  const match = pickProvider(line, "stripe");
  assert.ok(match);
  assert.equal(match?.method, "POST");
});

run("detects trpc and grpc patterns", () => {
  const line = "await trpc.user.profile.query({ id }); const c = new GreeterClient(addr); c.SayHello(request);";
  const matches = matchNormalizedLine(line);
  assert.ok(matches.some((m) => m.provider === "trpc" && m.action === "query"));
  assert.ok(matches.some((m) => m.provider === "grpc"));
});

run("keeps route definition detection", () => {
  const routes = matchRouteDefinitionLine("router.post('/webhook/stripe', handler)");
  assert.ok(routes.some((r) => r.method === "POST" && r.url === "/webhook/stripe"));
});

run("emits inlineParallelCapable from the registry for images.generate", () => {
  const match = pickProvider("await client.images.generate({ prompt: 'a cat', n: 4 });", "openai");
  assert.ok(match);
  assert.equal(match?.inlineParallelCapable, true);
  // images.generate is inline-parallel, not batch-capable (reclassified in #116).
  assert.notEqual(match?.batchCapable, true);
});

run("leaves inlineParallelCapable unset for non-inline-parallel methods", () => {
  const match = pickProvider("await client.chat.completions.create({ model: 'gpt-4.1' });", "openai");
  assert.ok(match);
  assert.notEqual(match?.inlineParallelCapable, true);
});

console.log("All scanner matcher tests passed");
