import OpenAI from "openai";

const client = new OpenAI();

export async function complete(prompt: string): Promise<string> {
  const result = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
  });
  return result.choices[0]?.message.content ?? "";
}

export async function embedBatch(items: string[]): Promise<number[][]> {
  const out: number[][] = [];
  for (const item of items) {
    const res = await client.embeddings.create({ model: "text-embedding-3-small", input: item });
    out.push(res.data[0]?.embedding ?? []);
  }
  return out;
}
