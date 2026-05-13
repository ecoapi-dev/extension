import { level3Helper } from "./level3Helper";

export async function level2Helper(prompt: string) {
  const result = await level3Helper(prompt);
  return result.toUpperCase();
}
