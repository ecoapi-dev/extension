import OpenAI from "openai";
const ai = new OpenAI();
function complete(prompt: string) {
  return ai.chat.completions.create({
    model: "gpt-4o",
    messages: [{ role: "user", content: prompt }],
  });
}
async function answerQuestion(q: string) {
  return complete(q);
}
answerQuestion("hi");
