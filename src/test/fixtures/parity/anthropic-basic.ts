import Anthropic from "@anthropic-ai/sdk";
const client = new Anthropic();
async function ask() {
  return client.messages.create({
    model: "claude-3-5-haiku-latest",
    max_tokens: 1024,
    messages: [],
  });
}
ask();
