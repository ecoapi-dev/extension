async function callOpenAi() {
  return fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: "Bearer sk-x" },
    body: JSON.stringify({ model: "gpt-4o", messages: [] }),
  });
}
callOpenAi();
