import Anthropic from "@anthropic-ai/sdk";

export const client = new Anthropic();

export async function chat(text: string) {
  return client.messages.create({
    model: "claude-opus-4-5",
    max_tokens: 1024,
    messages: [{ role: "user", content: text }],
  });
}
