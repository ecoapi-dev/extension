const OPENAI_BASE = "https://api.openai.com";
const ANTHROPIC_BASE = "https://api.anthropic.com";

export async function chat(prompt: string) {
  const r = await fetch(`${OPENAI_BASE}/v1/chat/completions`, {
    method: "POST",
    body: JSON.stringify({ model: "gpt-4o-mini", messages: [{ role: "user", content: prompt }] }),
  });
  return r.json();
}

export async function complete(prompt: string) {
  const r = await fetch(`${ANTHROPIC_BASE}/v1/messages`, {
    method: "POST",
    body: JSON.stringify({ model: "claude-3-5-haiku-20241022", messages: [{ role: "user", content: prompt }] }),
  });
  return r.json();
}
