import OpenAI from "openai";

export function makeClient(_config?: unknown): OpenAI {
  return new OpenAI();
}
