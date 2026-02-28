import { ProviderPricing } from "./types";

export const DEFAULT_PER_CALL_COST_USD = 0.0001;

export const PROVIDER_PRICING: Record<string, ProviderPricing> = {
  stripe: {
    name: "stripe",
    perCallCostUsd: 0.01,
    notes: "Approximate per-call blended API/platform cost."
  },
  openai: {
    name: "openai",
    perCallCostUsd: 0.006,
    notes: "Approximate token-to-request blended estimate."
  },
  twilio: {
    name: "twilio",
    perCallCostUsd: 0.0075,
    notes: "Approximate messaging/communications API estimate."
  },
  sendgrid: {
    name: "sendgrid",
    perCallCostUsd: 0.001,
    notes: "Approximate email send API estimate."
  },
  "aws-s3": {
    name: "aws-s3",
    perCallCostUsd: 0.0004,
    notes: "Approximate storage request estimate."
  },
  "google-maps": {
    name: "google-maps",
    perCallCostUsd: 0.005,
    notes: "Approximate geocoding/maps API estimate."
  },
  internal: {
    name: "internal",
    perCallCostUsd: DEFAULT_PER_CALL_COST_USD,
    notes: "Fallback for private/internal APIs."
  }
};

export const PROVIDER_KEYWORDS: Record<string, string[]> = {
  stripe: ["stripe"],
  openai: ["openai"],
  twilio: ["twilio"],
  sendgrid: ["sendgrid"],
  "aws-s3": ["s3.amazonaws.com", "amazonaws.com/s3", "aws/s3", "s3"],
  "google-maps": ["maps.googleapis.com", "googleapis.com/maps", "google maps"]
};
