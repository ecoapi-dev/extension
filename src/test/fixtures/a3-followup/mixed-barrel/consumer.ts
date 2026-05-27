import gen, { ask } from "./barrel";

export async function handle(q: string): Promise<string> {
  const a = await gen(q);
  const b = await ask(q);
  return a + b;
}
