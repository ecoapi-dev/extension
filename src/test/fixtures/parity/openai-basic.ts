import OpenAI from "openai";
const client = new OpenAI();
async function ask() {
  return client.chat.completions.create({
    model: "gpt-4o",
    messages: [{ role: "user", content: "hi" }],
  });
}
ask();
