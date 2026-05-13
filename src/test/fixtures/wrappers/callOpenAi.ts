import OpenAI from "openai";

const client = new OpenAI();

export async function callOpenAi(prompt: string) {
  const response = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
  });
  return response.choices[0]?.message?.content ?? "";
}
