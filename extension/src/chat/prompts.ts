import type { EndpointRecord, Suggestion, ScanSummary } from "../analysis/types";

export function buildSystemPrompt(
  summary: ScanSummary | null,
  suggestions: Suggestion[],
  endpoints: EndpointRecord[]
): string {
  if (!summary) {
    return `You are an API cost optimization assistant embedded in a VS Code extension called ECO. ECO analyzes codebases for API call patterns, estimates costs, and suggests optimizations like caching, batching, and eliminating redundant calls. No scan has been run yet — ask the user to run a scan first to get insights about their API usage. Be concise since you're in a sidebar panel with limited width.`;
  }

  return `You are an API cost optimization assistant embedded in a VS Code extension called ECO.
The user's project has been scanned and here are the results:

Total endpoints: ${summary.totalEndpoints}
Total monthly cost: $${summary.totalMonthlyCost.toFixed(2)}
Suggestions: ${JSON.stringify(suggestions)}
Endpoints: ${JSON.stringify(endpoints)}

Help the user understand their API usage, explain suggestions, and recommend optimizations.
Be concise since you're in a sidebar panel with limited width.`;
}
