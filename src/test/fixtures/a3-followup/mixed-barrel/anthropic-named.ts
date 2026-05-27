import Anthropic from "@anthropic-ai/sdk";

const anthropic = new Anthropic();

export async function ask(prompt: string): Promise<string> {
  const r = await anthropic.messages.create({
    model: "claude-opus-4-5",
    max_tokens: 256,
    messages: [{ role: "user", content: prompt }],
  });
  return r.content[0]?.type === "text" ? r.content[0].text : "";
}
