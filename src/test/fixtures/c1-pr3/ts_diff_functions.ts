import OpenAI from "openai";
const client = new OpenAI();

export async function summarize(text: string): Promise<string> {
  const r = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: `Summarize: ${text}` }],
  });
  return r.choices[0].message.content ?? "";
}

export async function translate(text: string, lang: string): Promise<string> {
  const r = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: `Translate to ${lang}: ${text}` }],
  });
  return r.choices[0].message.content ?? "";
}
