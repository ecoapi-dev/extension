import { useState } from "react";
import { RotateCcw, ExternalLink, Sparkles } from "lucide-react";
import { LeafIcon, SmallLeafIcon } from "./LeafIcon";
import { ChatPage } from "./ChatPage";
import type { Suggestion, ScanSummary, SuggestionContext } from "../types";
import { postMessage } from "../vscode";

interface ResultsPageProps {
  onRescan: () => void;
  suggestions: Suggestion[];
  summary: ScanSummary;
}

type SeverityDisplay = "HIGH" | "MEDIUM" | "LOW";
type Tab = "suggestions" | "chat";

const severityMap: Record<string, SeverityDisplay> = {
  high: "HIGH",
  medium: "MEDIUM",
  low: "LOW",
};

const severityColor: Record<SeverityDisplay, string> = {
  HIGH: "#E85454",
  MEDIUM: "#D4A843",
  LOW: "#4EAA57",
};

const typeLabels: Record<string, string> = {
  n_plus_one: "n+1",
  cache: "cache",
  batch: "batch",
  redundancy: "redundancy",
  rate_limit: "rate-limit",
};

function SuggestionCard({
  suggestion,
  onAskAI,
}: {
  suggestion: Suggestion;
  onAskAI: (s: Suggestion) => void;
}) {
  return (
    <div
      className="group cursor-default px-3.5 py-3.5 rounded-md"
      style={{ border: "1px solid #1a2a1a" }}
    >
      <div className="flex items-start gap-2">
        <span
          style={{
            color: "#4EAA57",
            fontSize: "0.65rem",
            flexShrink: 0,
            marginTop: "1px",
          }}
        >
          {typeLabels[suggestion.type] || suggestion.type}
        </span>
        <span style={{ color: "#9EBF9E", fontSize: "0.75rem", lineHeight: 1.5 }}>
          {suggestion.description}
        </span>
      </div>
      <div className="flex items-center justify-between mt-2">
        <div className="flex items-center gap-1 flex-wrap">
          {suggestion.affectedFiles.map((f) => (
            <span
              key={f}
              className="cursor-pointer hover:underline"
              style={{ color: "#2D4A2D", fontSize: "0.6rem" }}
              onClick={() => postMessage({ type: "openFile", file: f })}
            >
              {f}
            </span>
          ))}
        </div>
        <button
          onClick={() => onAskAI(suggestion)}
          className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer"
          style={{
            color: "#4EAA57",
            fontSize: "0.6rem",
            backgroundColor: "transparent",
            border: "none",
          }}
        >
          fix
          <Sparkles size={10} />
        </button>
      </div>
    </div>
  );
}

function SeveritySection({
  severity,
  suggestions,
  onAskAI,
}: {
  severity: SeverityDisplay;
  suggestions: Suggestion[];
  onAskAI: (s: Suggestion) => void;
}) {
  if (suggestions.length === 0) return null;

  return (
    <div className="mb-5">
      <div className="flex items-center gap-3">
        <div className="flex-1" style={{ height: "1px", backgroundColor: "#1a2a1a" }} />
        <span
          style={{
            color: severityColor[severity],
            fontSize: "0.65rem",
            fontWeight: 600,
            letterSpacing: "0.1em",
          }}
        >
          {severity}
        </span>
        <div className="flex-1" style={{ height: "1px", backgroundColor: "#1a2a1a" }} />
      </div>
      <div className="flex flex-col gap-3 mt-3">
        {suggestions.map((s) => (
          <SuggestionCard key={s.id} suggestion={s} onAskAI={onAskAI} />
        ))}
      </div>
    </div>
  );
}

export function ResultsPage({ onRescan, suggestions, summary }: ResultsPageProps) {
  const [tab, setTab] = useState<Tab>("suggestions");
  const [chatContext, setChatContext] = useState<SuggestionContext | null>(null);

  const handleAskAI = (suggestion: Suggestion) => {
    setChatContext({
      type: suggestion.type,
      description: suggestion.description,
      files: suggestion.affectedFiles,
      codeFix: suggestion.codeFix,
      severity: suggestion.severity,
      estimatedMonthlySavings: suggestion.estimatedMonthlySavings,
    });
    setTab("chat");
  };

  const highSuggestions = suggestions.filter((s) => s.severity === "high");
  const mediumSuggestions = suggestions.filter((s) => s.severity === "medium");
  const lowSuggestions = suggestions.filter((s) => s.severity === "low");

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div
        className="flex items-center justify-between px-4 py-2 shrink-0"
        style={{ borderBottom: "1px solid #1a2a1a" }}
      >
        <div className="flex items-center gap-2">
          <LeafIcon size={18} />
          <span
            style={{
              color: "#7EA87E",
              fontSize: "0.75rem",
              fontWeight: 600,
              letterSpacing: "0.1em",
            }}
          >
            ECO
          </span>
        </div>

        {/* Toggle */}
        <div
          className="flex items-center rounded-md overflow-hidden"
          style={{ border: "1px solid #1a2a1a" }}
        >
          <button
            onClick={() => setTab("suggestions")}
            className="px-3 py-1 cursor-pointer transition-colors"
            style={{
              fontSize: "0.65rem",
              color: tab === "suggestions" ? "#D6EDD0" : "#3A5A3A",
              backgroundColor: tab === "suggestions" ? "#1a2a1a" : "transparent",
              border: "none",
            }}
          >
            Suggestions
          </button>
          <button
            onClick={() => setTab("chat")}
            className="px-3 py-1 cursor-pointer transition-colors"
            style={{
              fontSize: "0.65rem",
              color: tab === "chat" ? "#D6EDD0" : "#3A5A3A",
              backgroundColor: tab === "chat" ? "#1a2a1a" : "transparent",
              border: "none",
            }}
          >
            Chat
          </button>
        </div>

        <button
          onClick={onRescan}
          className="flex items-center gap-1 cursor-pointer"
          style={{
            color: "#3A5A3A",
            fontSize: "0.65rem",
            backgroundColor: "transparent",
            border: "none",
          }}
        >
          <RotateCcw size={11} />
          rescan
        </button>
      </div>

      {tab === "suggestions" ? (
        <>
          {/* Summary */}
          <div
            className="px-4 py-3.5 shrink-0"
            style={{ borderBottom: "1px solid #131A13" }}
          >
            <div className="flex items-center gap-3">
              <div className="flex-1" style={{ height: "1px", backgroundColor: "#1a2a1a" }} />
              <span
                style={{
                  color: "#3A5A3A",
                  fontSize: "0.7rem",
                  fontWeight: 600,
                  letterSpacing: "0.1em",
                }}
              >
                SCAN RESULTS
              </span>
              <div className="flex-1" style={{ height: "1px", backgroundColor: "#1a2a1a" }} />
            </div>
            <div className="flex items-start gap-2.5 mt-2">
              <div className="shrink-0 mt-0.5">
                <SmallLeafIcon size={14} />
              </div>
              <div>
                <p style={{ color: "#9EBF9E", fontSize: "0.75rem", lineHeight: 1.7 }}>
                  Scanned{" "}
                  <span style={{ color: "#D6EDD0" }}>
                    {summary.totalEndpoints} endpoints
                  </span>{" "}
                  across your workspace. Found{" "}
                  <span style={{ color: "#D6EDD0" }}>
                    {suggestions.length} suggestions
                  </span>{" "}
                  with an estimated{" "}
                  <span style={{ color: "#4EAA57" }}>
                    ${summary.totalMonthlyCost.toFixed(2)}/mo
                  </span>{" "}
                  in total API costs.{" "}
                  {summary.highRiskCount > 0 && (
                    <>
                      <span style={{ color: "#E85454" }}>
                        {summary.highRiskCount} high-risk
                      </span>{" "}
                      issues need attention.
                    </>
                  )}
                </p>
              </div>
            </div>
          </div>

          {/* Suggestions list */}
          <div className="flex-1 overflow-y-auto px-4 py-4">
            {suggestions.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12">
                <SmallLeafIcon size={32} />
                <p
                  className="mt-4 text-center"
                  style={{ color: "#7EA87E", fontSize: "0.8rem" }}
                >
                  No issues found. Your API usage looks clean!
                </p>
              </div>
            ) : (
              <>
                <SeveritySection
                  severity="HIGH"
                  suggestions={highSuggestions}
                  onAskAI={handleAskAI}
                />
                <SeveritySection
                  severity="MEDIUM"
                  suggestions={mediumSuggestions}
                  onAskAI={handleAskAI}
                />
                <SeveritySection
                  severity="LOW"
                  suggestions={lowSuggestions}
                  onAskAI={handleAskAI}
                />
              </>
            )}
          </div>
        </>
      ) : (
        <ChatPage context={chatContext} />
      )}
    </div>
  );
}
