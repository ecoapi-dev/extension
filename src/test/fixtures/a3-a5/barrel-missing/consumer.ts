import { summarize } from "./index";

export async function handle(q: string): Promise<string> {
  return summarize(q);
}
