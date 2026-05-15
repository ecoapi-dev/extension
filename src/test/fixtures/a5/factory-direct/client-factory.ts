import OpenAI from "openai";

export function makeClient(): OpenAI {
  return new OpenAI();
}
