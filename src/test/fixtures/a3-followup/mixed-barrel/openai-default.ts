import OpenAI from "openai";

const openai = new OpenAI();

export default async function gen(prompt: string): Promise<string> {
  const r = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
  });
  return r.choices[0]?.message?.content ?? "";
}
