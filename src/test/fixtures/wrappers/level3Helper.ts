import { callOpenAi } from "./callOpenAi";

export async function level3Helper(prompt: string) {
  const result = await callOpenAi(prompt);
  return result.trim();
}
