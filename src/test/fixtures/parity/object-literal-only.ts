// Pure data — no executable API calls. Both paths should produce zero matches.
// This guards the A6 (object-literal false positive) fix once it lands.
export const METHOD_PRICING = {
  openai: {
    "chat.completions.create": { costModel: "per_token" },
    "embeddings.create": { costModel: "per_token" },
  },
  anthropic: {
    "messages.create": { costModel: "per_token" },
  },
};
