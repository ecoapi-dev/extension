import { ChatAdapterError, ensureStringContent } from "../errors";
import type { ChatProviderAdapter, HttpErrorContext, NormalizedChatResponse } from "../types";
import { RECOST_API_BASE_URL } from "../../config";

export const ecoAdapter: ChatProviderAdapter = {
  id: "recost",
  displayName: "ReCost AI",
  baseUrl: RECOST_API_BASE_URL,
  defaultChatEndpoint: "/chat",
  authHeaderFormat: "none",
  supportsStreaming: false,
  auth: {
    required: false,
  },
  models: [
    { id: "recost-ai", displayName: "Llama 3.1 (Free)", provider: "recost", supportsStreaming: false },
  ],
  authHeaders() {
    return {};
  },
  validateRequest(request) {
    if (!ecoAdapter.models.some((model) => model.id === request.model)) {
      throw new ChatAdapterError("unsupported_model", `Unsupported ReCost model: ${request.model}`, { provider: "recost" });
    }
    if (request.stream) {
      throw new ChatAdapterError("streaming_not_supported", "ReCost AI streaming is not supported.", { provider: "recost" });
    }
  },
  toRequestBody(request) {
    ecoAdapter.validateRequest(request);
    return {
      url: `${ecoAdapter.baseUrl}${ecoAdapter.defaultChatEndpoint}`,
      headers: { "Content-Type": "application/json" },
      body: { messages: request.messages },
    };
  },
  parseResponse(response, request): NormalizedChatResponse {
    const payload = response as { data?: { response?: string } };
    return {
      provider: ecoAdapter.id,
      model: request.model,
      content: ensureStringContent(payload?.data?.response, "No response from ReCost AI. The service may be temporarily unavailable.", "recost"),
      raw: response,
    };
  },
  mapHttpError(context: HttpErrorContext) {
    return new ChatAdapterError("provider_error", `ReCost AI request failed: ${context.bodyText || "Unknown error"}`, { provider: "recost", status: context.status });
  },
};
