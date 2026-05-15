import OpenAI from "openai";
import { withRetry } from "./retry";

const client = new OpenAI();

export async function summarizeShort(text: string): Promise<string> {
  const prompt = `Summarize: ${text}`;
  return withRetry(() => client.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
  }));
}
