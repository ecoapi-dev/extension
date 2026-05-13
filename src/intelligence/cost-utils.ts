import { lookupMethod, lookupByUrlPath } from "../scanner/fingerprints/registry";

// Best-effort local cost estimation shared by the webview and intelligence
// layer. When a provider or pricing signal is missing, callers can fall back
// to null rather than blocking snapshot creation.
const LOCAL_PRICING: Record<string, number> = {
  openai: 0.00015,
  anthropic: 0.00025,
  stripe: 0.59,
  paypal: 0.84,
  braintree: 0.75,
  square: 0.59,
  twilio: 0.0079,
  sendgrid: 0.0009,
  mailgun: 0.0018,
  postmark: 0.0015,
  "aws-s3": 0.0000004,
  "aws-api-gateway": 0.0000035,
  "aws-lambda": 0.0000002,
  "google-maps": 0.005,
  "google-translate": 0.01,
  "google-vision": 0.0015,
  "google-speech": 0.006,
  firestore: 0.0000003,
  auth0: 0.00023,
  okta: 0.0002,
  salesforce: 0.0025,
  mixpanel: 0.00028,
  segment: 0.00007,
  amplitude: 0.00049,
  datadog: 0.0000017,
  sentry: 0.000363,
  algolia: 0.0005,
  cloudinary: 0.000089,
  mux: 0.032,
  shipengine: 0.02,
  easypost: 0.02,
  cloudflare: 0.0000003,
  vercel: 0.0000006,
};

const DEFAULT_PER_CALL_COST = 0.0001;

export function estimateLocalMonthlyCost(
  provider: string,
  callsPerDay: number,
  methodSignature?: string,
  /**
   * A7 (issue #79): URL for the call, used when `methodSignature` is undefined
   * (e.g. raw `fetch()` with a known provider host but no SDK method chain).
   */
  url?: string,
): number | null {
  if (!provider || provider === "unknown") return null;
  if (!Number.isFinite(callsPerDay) || callsPerDay < 0) return null;

  let fingerprint = methodSignature ? lookupMethod(provider, methodSignature) : null;

  // A7: fall back to URL-path lookup when the SDK chain didn't resolve.
  if (!fingerprint && url) {
    fingerprint = lookupByUrlPath(provider, url);
  }

  if (fingerprint) {
    if (fingerprint.costModel === "free") return 0;
    if (fingerprint.costModel === "per_token") {
      const inputTokens = 500;
      const outputTokens = 200;
      const inputCost = (inputTokens / 1_000_000) * (fingerprint.inputPricePer1M ?? 0);
      const outputCost = (outputTokens / 1_000_000) * (fingerprint.outputPricePer1M ?? 0);
      return Math.round((inputCost + outputCost) * callsPerDay * 30 * 100) / 100;
    }
    if (fingerprint.costModel === "per_transaction") {
      const txValue = 50;
      const fee = (fingerprint.fixedFee ?? 0) + txValue * (fingerprint.percentageFee ?? 0);
      return Math.round(fee * callsPerDay * 30 * 100) / 100;
    }
    if (fingerprint.costModel === "per_request") {
      return Math.round((fingerprint.fixedFee ?? fingerprint.perRequestCostUsd ?? DEFAULT_PER_CALL_COST) * callsPerDay * 30 * 100) / 100;
    }
    return null;
  }

  const perCall = LOCAL_PRICING[provider];
  if (perCall === undefined) return null;
  return Math.round(callsPerDay * perCall * 30 * 100) / 100;
}
