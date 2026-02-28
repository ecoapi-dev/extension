import { useState } from "react";
import { Markdown } from "./Markdown";
import { ChatPage } from "./ChatPage";
import type { Suggestion, ScanSummary, SuggestionContext, EndpointRecord } from "../types";
import { postMessage } from "../vscode";

interface ResultsPageProps {
  suggestions: Suggestion[];
  summary: ScanSummary;
  endpoints: EndpointRecord[];
}

type Tab = "findings" | "chat";

const typeLabels: Record<string, string> = {
  n_plus_one: "n+1",
  cache: "cache",
  batch: "batch",
  redundancy: "redundancy",
  rate_limit: "rate-limit",
};

function extractCode(raw: string): { code: string; language: string } {
  const fenced = raw.match(/^```(\w*)\n([\s\S]*?)```\s*$/);
  if (fenced) return { language: fenced[1], code: fenced[2].trim() };
  return { language: "", code: raw.trim() };
}

function SeverityIcon({ severity }: { severity: string }) {
  if (severity === "high") {
    return (
      <span
        className="codicon codicon-error"
        style={{ color: "var(--vscode-editorError-foreground)", fontSize: "14px", flexShrink: 0 }}
      />
    );
  }
  if (severity === "medium") {
    return (
      <span
        className="codicon codicon-warning"
        style={{ color: "var(--vscode-editorWarning-foreground)", fontSize: "14px", flexShrink: 0 }}
      />
    );
  }
  return (
    <span
      className="codicon codicon-info"
      style={{ color: "var(--vscode-descriptionForeground)", fontSize: "14px", flexShrink: 0 }}
    />
  );
}

function TypeBadge({ type }: { type: string }) {
  return (
    <span
      style={{
        background: "var(--vscode-badge-background)",
        color: "var(--vscode-badge-foreground)",
        fontSize: "10px",
        padding: "1px 5px",
        borderRadius: "10px",
        fontWeight: 600,
        flexShrink: 0,
        whiteSpace: "nowrap",
      }}
    >
      {typeLabels[type] ?? type}
    </span>
  );
}

function CodeFix({ codeFix, file }: { codeFix: string; file?: string }) {
  const [copied, setCopied] = useState(false);
  const { code, language } = extractCode(codeFix);
  if (!code) return null;

  const handleCopy = () => {
    navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div
      style={{
        marginTop: "10px",
        borderRadius: "4px",
        overflow: "hidden",
        border: "1px solid var(--vscode-panel-border)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "4px 8px",
          background: "var(--vscode-editorGroupHeader-tabsBackground)",
          borderBottom: "1px solid var(--vscode-panel-border)",
        }}
      >
        <span style={{ color: "var(--vscode-descriptionForeground)", fontSize: "11px" }}>
          {language || "code"}
        </span>
        <div style={{ display: "flex", alignItems: "center", gap: "4px" }}>
          {file && (
            <button
              className="eco-btn-icon"
              onClick={() => postMessage({ type: "applyFix", code, file })}
              title="Apply fix"
              style={{ fontSize: "11px", gap: "3px", display: "flex", alignItems: "center", color: "var(--vscode-textLink-foreground)" }}
            >
              <span className="codicon codicon-arrow-right" style={{ fontSize: "11px" }} />
              apply
            </button>
          )}
          <button className="eco-btn-icon" onClick={handleCopy} title="Copy">
            <span
              className={`codicon ${copied ? "codicon-check" : "codicon-copy"}`}
              style={{ fontSize: "12px" }}
            />
          </button>
        </div>
      </div>
      <pre
        style={{
          margin: 0,
          padding: "12px",
          background: "var(--vscode-textCodeBlock-background)",
          fontFamily: "var(--vscode-editor-font-family)",
          fontSize: "var(--vscode-editor-font-size)",
          overflowX: "auto",
          lineHeight: 1.5,
          color: "var(--vscode-editor-foreground, var(--vscode-foreground))",
        }}
      >
        {code}
      </pre>
    </div>
  );
}

function SuggestionCard({
  suggestion,
  expanded,
  onToggle,
  onAskAI,
}: {
  suggestion: Suggestion;
  expanded: boolean;
  onToggle: () => void;
  onAskAI: (s: Suggestion) => void;
}) {
  const firstLine = suggestion.description.split("\n")[0];
  const descShort = firstLine.length > 90 ? firstLine.slice(0, 90) + "…" : firstLine;

  return (
    <div className="eco-suggestion">
      <button className="eco-suggestion-header" onClick={onToggle}>
        <span
          className={`codicon ${expanded ? "codicon-chevron-down" : "codicon-chevron-right"}`}
          style={{ fontSize: "12px", flexShrink: 0, marginTop: "1px", color: "var(--vscode-descriptionForeground)" }}
        />
        <SeverityIcon severity={suggestion.severity} />
        <TypeBadge type={suggestion.type} />
        <span style={{ flex: 1, lineHeight: 1.4, overflow: "hidden" }}>{descShort}</span>
        {suggestion.estimatedMonthlySavings > 0 && (
          <span
            style={{
              color: "var(--vscode-charts-green, #4caf50)",
              fontSize: "11px",
              flexShrink: 0,
              whiteSpace: "nowrap",
            }}
          >
            −${suggestion.estimatedMonthlySavings.toFixed(2)}/mo
          </span>
        )}
      </button>

      {expanded && (
        <div className="eco-suggestion-body">
          <Markdown content={suggestion.description} />

          {suggestion.affectedFiles.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: "6px", marginTop: "10px" }}>
              {suggestion.affectedFiles.map((f) => (
                <button
                  key={f}
                  className="eco-btn-link"
                  style={{ fontSize: "11px" }}
                  onClick={() => postMessage({ type: "openFile", file: f })}
                >
                  {f}
                </button>
              ))}
            </div>
          )}

          {suggestion.codeFix && (
            <CodeFix codeFix={suggestion.codeFix} file={suggestion.affectedFiles[0]} />
          )}

          <button
            className="eco-btn-icon"
            onClick={() => onAskAI(suggestion)}
            style={{
              marginTop: "10px",
              gap: "4px",
              display: "flex",
              justifyContent: "flex-start",
              alignItems: "center",
              color: "var(--vscode-textLink-foreground)",
              fontSize: "11px",
              padding: "4px 0",
            }}
          >
            <span className="codicon codicon-comment" style={{ fontSize: "12px" }} />
            Ask AI
          </button>
        </div>
      )}
    </div>
  );
}

function SeverityGroup({
  label,
  suggestions,
  expanded,
  onToggle,
  onAskAI,
}: {
  label: string;
  suggestions: Suggestion[];
  expanded: Set<string>;
  onToggle: (id: string) => void;
  onAskAI: (s: Suggestion) => void;
}) {
  if (suggestions.length === 0) return null;

  const color =
    label === "HIGH"
      ? "var(--vscode-editorError-foreground)"
      : label === "MEDIUM"
      ? "var(--vscode-editorWarning-foreground)"
      : "var(--vscode-descriptionForeground)";

  return (
    <div>
      <div
        style={{
          padding: "4px 12px",
          fontSize: "10px",
          fontWeight: 600,
          letterSpacing: "0.08em",
          color,
          borderBottom: "1px solid var(--vscode-panel-border)",
        }}
      >
        {label}
      </div>
      {suggestions.map((s) => (
        <SuggestionCard
          key={s.id}
          suggestion={s}
          expanded={expanded.has(s.id)}
          onToggle={() => onToggle(s.id)}
          onAskAI={onAskAI}
        />
      ))}
    </div>
  );
}

function EndpointsList({ endpoints, topBorder }: { endpoints: EndpointRecord[]; topBorder: boolean }) {
  const [open, setOpen] = useState(false);

  return (
    <div style={topBorder ? { borderTop: "1px solid var(--vscode-panel-border)" } : undefined}>
      <button className="eco-section-header" onClick={() => setOpen((v) => !v)}>
        <span
          className={`codicon ${open ? "codicon-chevron-down" : "codicon-chevron-right"}`}
          style={{ fontSize: "12px" }}
        />
        Endpoints ({endpoints.length})
      </button>

      {open &&
        endpoints.map((ep) => (
          <div key={ep.id} className="eco-endpoint-row">
            <span
              style={{
                background: "var(--vscode-badge-background)",
                color: "var(--vscode-badge-foreground)",
                fontSize: "10px",
                padding: "1px 4px",
                borderRadius: "2px",
                fontWeight: 700,
                flexShrink: 0,
                letterSpacing: "0.04em",
              }}
            >
              {ep.method}
            </span>
            <span
              style={{
                flex: 1,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                fontSize: "11px",
              }}
              title={ep.url}
            >
              {ep.url}
            </span>
            <span
              style={{
                background: "var(--vscode-editorGroupHeader-tabsBackground)",
                color: "var(--vscode-descriptionForeground)",
                fontSize: "10px",
                padding: "1px 5px",
                borderRadius: "10px",
                flexShrink: 0,
                border: "1px solid var(--vscode-panel-border)",
              }}
            >
              {ep.provider}
            </span>
            <span style={{ color: "var(--vscode-descriptionForeground)", fontSize: "10px", flexShrink: 0 }}>
              ${ep.monthlyCost.toFixed(2)}/mo
            </span>
            <span
              style={{
                fontSize: "10px",
                flexShrink: 0,
                color:
                  ep.status === "redundant" || ep.status === "n_plus_one_risk"
                    ? "var(--vscode-editorError-foreground)"
                    : ep.status === "cacheable" || ep.status === "batchable" || ep.status === "rate_limit_risk"
                    ? "var(--vscode-editorWarning-foreground)"
                    : "var(--vscode-descriptionForeground)",
              }}
            >
              {ep.status.replace(/_/g, " ")}
            </span>
          </div>
        ))}
    </div>
  );
}

export function ResultsPage({ suggestions, summary, endpoints }: ResultsPageProps) {
  const [tab, setTab] = useState<Tab>("findings");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [chatContext, setChatContext] = useState<SuggestionContext | null>(null);

  const toggleCard = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

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

  const high = suggestions.filter((s) => s.severity === "high");
  const medium = suggestions.filter((s) => s.severity === "medium");
  const low = suggestions.filter((s) => s.severity === "low");

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      {/* Tab bar */}
      <div className="eco-tabs">
        <button
          className={`eco-tab${tab === "findings" ? " active" : ""}`}
          onClick={() => setTab("findings")}
        >
          Findings
        </button>
        <button
          className={`eco-tab${tab === "chat" ? " active" : ""}`}
          onClick={() => setTab("chat")}
        >
          Chat
        </button>
      </div>

      {/* Findings — always mounted to preserve scroll position; hidden via display */}
      <div style={{ flex: 1, overflow: "hidden", display: tab === "findings" ? "flex" : "none", flexDirection: "column", minHeight: 0 }}>
        {/* Summary bar */}
        <div
          style={{
            padding: "5px 12px",
            borderBottom: "1px solid var(--vscode-panel-border)",
            flexShrink: 0,
            color: "var(--vscode-descriptionForeground)",
            fontSize: "11px",
          }}
        >
          {summary.totalEndpoints} endpoints
          <span style={{ margin: "0 5px", opacity: 0.4 }}>·</span>
          {suggestions.length} suggestions
          <span style={{ margin: "0 5px", opacity: 0.4 }}>·</span>
          ${summary.totalMonthlyCost.toFixed(2)}/mo
          {summary.highRiskCount > 0 && (
            <>
              <span style={{ margin: "0 5px", opacity: 0.4 }}>·</span>
              <span style={{ color: "var(--vscode-editorError-foreground)" }}>
                {summary.highRiskCount} high
              </span>
            </>
          )}
        </div>

        {/* Content */}
        <div style={{ flex: 1, overflowY: "auto", minHeight: 0 }}>
          {suggestions.length === 0 ? (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                padding: "40px 16px",
                gap: "8px",
                color: "var(--vscode-descriptionForeground)",
              }}
            >
              <span className="codicon codicon-check" style={{ fontSize: "24px" }} />
              <span>No issues found</span>
            </div>
          ) : (
            <>
              <SeverityGroup label="HIGH" suggestions={high} expanded={expanded} onToggle={toggleCard} onAskAI={handleAskAI} />
              <SeverityGroup label="MEDIUM" suggestions={medium} expanded={expanded} onToggle={toggleCard} onAskAI={handleAskAI} />
              <SeverityGroup label="LOW" suggestions={low} expanded={expanded} onToggle={toggleCard} onAskAI={handleAskAI} />
            </>
          )}

          {endpoints.length > 0 && <EndpointsList endpoints={endpoints} topBorder={suggestions.length === 0} />}
        </div>
      </div>

      {/* Chat — always mounted to preserve message history; hidden via display */}
      <div style={{ flex: 1, display: tab === "chat" ? "flex" : "none", flexDirection: "column", minHeight: 0 }}>
        <ChatPage context={chatContext} />
      </div>
    </div>
  );
}
