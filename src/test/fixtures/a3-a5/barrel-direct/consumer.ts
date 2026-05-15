import { ask } from "./index";

export async function handle(q: string): Promise<string> {
  return ask(q);
}
