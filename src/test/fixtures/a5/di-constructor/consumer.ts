import OpenAI from "openai";

export class SummaryService {
  constructor(private readonly ai: OpenAI) {}

  async summarize(text: string): Promise<string> {
    const r = await this.ai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: `Summarize: ${text}` }],
    });
    return r.choices[0].message.content ?? "";
  }
}
