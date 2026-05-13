// Data-only file. NO call should be detected here.
export const METHOD_PRICING = {
  openai: {
    "chat.completions.create": { costModel: "per_token", inputPricePer1M: 0.15 },
    "embeddings.create": { costModel: "per_token", inputPricePer1M: 0.02 },
  },
  stripe: {
    "charges.create": { costModel: "per_transaction", fixedFee: 0.30 },
  },
};
