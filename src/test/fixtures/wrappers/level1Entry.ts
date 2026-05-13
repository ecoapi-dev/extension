import { level2Helper } from "./level2Helper";

export async function handleRequest(prompt: string) {
  const answer = await level2Helper(prompt);
  return { answer };
}
