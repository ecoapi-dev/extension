import OpenAI from "openai";

const client = new OpenAI();

export async function handleApi(arg: { path: string; body: unknown }): Promise<string> {
  const r = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: JSON.stringify(arg) }],
  });
  return r.choices[0]?.message?.content ?? "";
}
