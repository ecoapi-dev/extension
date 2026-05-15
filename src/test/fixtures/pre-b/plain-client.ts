import OpenAI from "openai";

const apiClient = new OpenAI();

export async function ask(prompt: string): Promise<string> {
  const r = await apiClient.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
  });
  return r.choices[0].message.content ?? "";
}
