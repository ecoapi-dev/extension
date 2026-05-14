import OpenAI from "openai";

const client = new OpenAI();
const askFn = client.chat.completions.create.bind(client.chat.completions);

export async function ask(prompt: string): Promise<string> {
  const r = await askFn({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
  });
  return r.choices[0].message.content ?? "";
}
