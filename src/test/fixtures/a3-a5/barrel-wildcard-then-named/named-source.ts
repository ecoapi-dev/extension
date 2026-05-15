import OpenAI from "openai";

const client = new OpenAI();

export async function ask(prompt: string): Promise<string> {
  const res = await client.chat.completions.create({
    model: "gpt-4o",
    messages: [{ role: "user", content: prompt }],
  });
  return res.choices[0]?.message?.content ?? "";
}
