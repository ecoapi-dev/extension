import OpenAI from "openai";
import type { SuggestionContext } from "../messages";
import { buildSystemPrompt } from "./prompts";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export async function* streamChatResponse(
  apiKey: string,
  model: string,
  context: SuggestionContext | null,
  fileContents: Map<string, string>,
  userMessage: string,
  history: ChatMessage[]
): AsyncGenerator<string> {
  const client = new OpenAI({ apiKey });
  const systemPrompt = buildSystemPrompt(context, fileContents);

  const stream = await client.chat.completions.create({
    model,
    messages: [
      { role: "system" as const, content: systemPrompt },
      ...history.map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      })),
      { role: "user" as const, content: userMessage },
    ],
    stream: true,
  });

  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta?.content;
    if (delta) {
      yield delta;
    }
  }
}
