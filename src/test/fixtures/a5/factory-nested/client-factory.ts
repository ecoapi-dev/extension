import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";

export function makeClient(): OpenAI {
  // Nested helper that returns an Anthropic instance — must NOT confuse the
  // factory detector into thinking makeClient() returns Anthropic.
  const _helper = () => new Anthropic();
  void _helper;
  return new OpenAI();
}
