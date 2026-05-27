import { makeClient } from "./factory";

const c0 = makeClient();
const c1 = makeClient(config);
const c2 = makeClient({ apiKey: process.env.KEY });
const c3 = makeClient(env, options);
const c4 = makeClient(
  env,
  options,
);

export async function run() {
  await c0.chat.completions.create({ model: "gpt-4o", messages: [] });
  await c1.chat.completions.create({ model: "gpt-4o", messages: [] });
  await c2.chat.completions.create({ model: "gpt-4o", messages: [] });
  await c3.chat.completions.create({ model: "gpt-4o", messages: [] });
  await c4.chat.completions.create({ model: "gpt-4o", messages: [] });
}
