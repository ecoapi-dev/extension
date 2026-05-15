import { handleApi } from "./ts_wrapper_sequential_helper";

export async function main(): Promise<void> {
  const summary = await handleApi({
    path: "/summarize",
    body: { text: "first request" },
  });
  console.log(summary);

  const answer = await handleApi({
    path: "/answer",
    body: { text: "second request" },
  });
  console.log(answer);
}
