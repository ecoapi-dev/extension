import { ask } from "./index";

async function main() {
  const answer = await ask("Hello, world!");
  console.log(answer);
}
