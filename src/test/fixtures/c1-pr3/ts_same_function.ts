import OpenAI from "openai";
const client = new OpenAI();

export async function dualPrompts(textA: string, textB: string): Promise<[string, string]> {
  const a = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: textA }],
  });
  const b = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: textB }],
  });
  return [a.choices[0].message.content ?? "", b.choices[0].message.content ?? ""];
}
