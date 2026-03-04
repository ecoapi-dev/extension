import { useState } from "react";
import { Markdown } from "./Markdown";
import { ChatPage } from "./ChatPage";
import type { Suggestion, ScanSummary, SuggestionContext, EndpointRecord } from "../types";
import { postMessage } from "../vscode";

interface ResultsPageProps {
  suggestions: Suggestion[];
  summary: ScanSummary;
  endpoints: EndpointRecord[];
  onRunAiReview: () => void;
  aiReviewRunning: boolean;
  aiReviewStage: string;
  aiReviewError: string;
  aiReviewStats: { added: number; filtered: number } | null;
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

function resolveSuggestionTarget(
  suggestion: Suggestion,
  endpoints: EndpointRecord[]
): { file?: string; line?: number } {
  if (suggestion.targetLine && suggestion.affectedFiles.length > 0) {
    return { file: suggestion.affectedFiles[0], line: suggestion.targetLine };
  }

  for (const endpointId of suggestion.affectedEndpoints) {
    const endpoint = endpoints.find((ep) => ep.id === endpointId);
    if (!endpoint) continue;

    for (const preferredFile of suggestion.affectedFiles) {
      const match = endpoint.callSites.find((site) => site.file === preferredFile);
      if (match) return { file: match.file, line: match.line };
    }

    if (endpoint.callSites.length > 0) {
      const first = endpoint.callSites[0];
      return { file: first.file, line: first.line };
    }
  }

  if (suggestion.affectedFiles.length > 0) {
    return { file: suggestion.affectedFiles[0] };
  }

  return {};
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

function SourceBadge({ source }: { source?: Suggestion["source"] }) {
  const label = source === "ai" ? "AI" : source === "local-rule" ? "Rule" : "Remote";
  return (
    <span
      style={{
        background: "var(--vscode-editorGroupHeader-tabsBackground)",
        color: "var(--vscode-descriptionForeground)",
        border: "1px solid var(--vscode-panel-border)",
        fontSize: "10px",
        padding: "1px 5px",
        borderRadius: "10px",
        fontWeight: 600,
        flexShrink: 0,
        whiteSpace: "nowrap",
      }}
    >
      {label}
    </span>
  );
}

function CodeFix({ codeFix, file, line }: { codeFix: string; file?: string; line?: number }) {
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
              onClick={() => postMessage({ type: "applyFix", code, file, line })}
              title="Apply fix"
              style={{ fontSize: "11px", gap: "3px", display: "flex", alignItems: "center", color: "var(--vscode-textLink-foreground)" }}
            >
              <span className="codicon codicon-check" style={{ fontSize: "11px" }} />
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
  target,
}: {
  suggestion: Suggestion;
  expanded: boolean;
  onToggle: () => void;
  onAskAI: (s: Suggestion) => void;
  target: { file?: string; line?: number };
}) {
  const firstLine = suggestion.description.split("\n")[0];
  const descShort = firstLine.length > 90 ? `${firstLine.slice(0, 90)}...` : firstLine;

  return (
    <div className="eco-suggestion">
      <button className="eco-suggestion-header" onClick={onToggle}>
        <span aria-hidden="true" className={`eco-disclosure${expanded ? " open" : ""}`} />
        <TypeBadge type={suggestion.type} />
        <SourceBadge source={suggestion.source} />
        {typeof suggestion.confidence === "number" && suggestion.source === "ai" && (
          <span
            style={{
              color: "var(--vscode-descriptionForeground)",
              fontSize: "10px",
              flexShrink: 0,
              whiteSpace: "nowrap",
            }}
          >
            {Math.round(suggestion.confidence * 100)}%
          </span>
        )}
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
            ${suggestion.estimatedMonthlySavings.toFixed(2)}/mo
          </span>
        )}
      </button>

      {expanded && (
        <div className="eco-suggestion-body">
          <Markdown content={suggestion.description} />
          {suggestion.evidence && suggestion.evidence.length > 0 && (
            <ul style={{ marginTop: "8px", marginBottom: 0, paddingLeft: "18px" }}>
              {suggestion.evidence.map((item, idx) => (
                <li key={`${suggestion.id}-e-${idx}`} style={{ fontSize: "11px", color: "var(--vscode-descriptionForeground)" }}>
                  {item}
                </li>
              ))}
            </ul>
          )}

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
            <CodeFix codeFix={suggestion.codeFix} file={target.file} line={target.line} />
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
              color: "#ffffff",
              background: "#2ea8ff",
              border: "1px solid #1b8fdf",
              borderRadius: "4px",
              fontSize: "11px",
              fontWeight: 600,
              padding: "5px 10px",
            }}
          >
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
  open,
  onToggleGroup,
  expanded,
  onToggle,
  onAskAI,
  resolveTarget,
}: {
  label: string;
  suggestions: Suggestion[];
  open: boolean;
  onToggleGroup: () => void;
  expanded: Set<string>;
  onToggle: (id: string) => void;
  onAskAI: (s: Suggestion) => void;
  resolveTarget: (s: Suggestion) => { file?: string; line?: number };
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
      <button
        className="eco-severity-header"
        onClick={onToggleGroup}
        style={{
          color,
        }}
      >
        <span>{label}</span>
        <span style={{ fontSize: "10px", opacity: 0.9 }}>{suggestions.length}</span>
      </button>
      {open &&
        suggestions.map((s) => (
          <SuggestionCard
            key={s.id}
            suggestion={s}
            expanded={expanded.has(s.id)}
            onToggle={() => onToggle(s.id)}
            onAskAI={onAskAI}
            target={resolveTarget(s)}
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

export function ResultsPage({
  suggestions,
  summary,
  endpoints,
  onRunAiReview,
  aiReviewRunning,
  aiReviewStage,
  aiReviewError,
  aiReviewStats,
}: ResultsPageProps) {
  const [tab, setTab] = useState<Tab>("findings");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [chatContext, setChatContext] = useState<SuggestionContext | null>(null);
  const [openGroups, setOpenGroups] = useState<Record<"HIGH" | "MEDIUM" | "LOW", boolean>>({
    HIGH: true,
    MEDIUM: true,
    LOW: true,
  });

  const toggleCard = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleAskAI = (suggestion: Suggestion) => {
    const target = resolveSuggestionTarget(suggestion, endpoints);
    const files = target.file
      ? [target.file, ...suggestion.affectedFiles.filter((f) => f !== target.file)]
      : suggestion.affectedFiles;

    setChatContext({
      type: suggestion.type,
      description: suggestion.description,
      files,
      codeFix: suggestion.codeFix,
      severity: suggestion.severity,
      estimatedMonthlySavings: suggestion.estimatedMonthlySavings,
      targetFile: target.file,
      targetLine: target.line,
    });
    setTab("chat");
  };

  const high = suggestions.filter((s) => s.severity === "high");
  const medium = suggestions.filter((s) => s.severity === "medium");
  const low = suggestions.filter((s) => s.severity === "low");

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
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
        <button
          className="eco-btn-icon"
          onClick={onRunAiReview}
          disabled={aiReviewRunning}
          title="Run AI Review"
          style={{
            marginLeft: "8px",
            padding: "0 8px",
            fontSize: "11px",
            display: "flex",
            alignItems: "center",
            gap: "3px",
            opacity: aiReviewRunning ? 0.7 : 1,
          }}
        >
          {aiReviewRunning ? "Reviewing..." : "Run AI Review"}
        </button>
        <button
          className="eco-btn-icon"
          onClick={() => postMessage({ type: "openDashboard" })}
          title="Open Dashboard"
          style={{ marginLeft: "auto", padding: "0 12px 0 8px", fontSize: "11px", display: "flex", alignItems: "center", gap: "3px" }}
        >
          Dashboard
        </button>
      </div>

      <div className="eco-panel-view" style={{ flex: 1, overflow: "hidden", display: tab === "findings" ? "flex" : "none", flexDirection: "column", minHeight: 0 }}>
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
          <span style={{ margin: "0 5px", opacity: 0.4 }}>|</span>
          {suggestions.length} suggestions
          <span style={{ margin: "0 5px", opacity: 0.4 }}>|</span>
          ${summary.totalMonthlyCost.toFixed(2)}/mo
          {summary.highRiskCount > 0 && (
            <>
              <span style={{ margin: "0 5px", opacity: 0.4 }}>|</span>
              <span style={{ color: "var(--vscode-editorError-foreground)" }}>
                {summary.highRiskCount} high
              </span>
            </>
          )}
          {aiReviewRunning && (
            <>
              <span style={{ margin: "0 5px", opacity: 0.4 }}>|</span>
              <span>{aiReviewStage || "Running AI review..."}</span>
            </>
          )}
          {!aiReviewRunning && aiReviewStats && (
            <>
              <span style={{ margin: "0 5px", opacity: 0.4 }}>|</span>
              <span>AI added {aiReviewStats.added}, filtered {aiReviewStats.filtered}</span>
            </>
          )}
          {!aiReviewRunning && aiReviewError && (
            <>
              <span style={{ margin: "0 5px", opacity: 0.4 }}>|</span>
              <span style={{ color: "var(--vscode-editorError-foreground)" }}>{aiReviewError}</span>
            </>
          )}
        </div>

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
              <SeverityGroup
                label="HIGH"
                suggestions={high}
                open={openGroups.HIGH}
                onToggleGroup={() => setOpenGroups((prev) => ({ ...prev, HIGH: !prev.HIGH }))}
                expanded={expanded}
                onToggle={toggleCard}
                onAskAI={handleAskAI}
                resolveTarget={(s) => resolveSuggestionTarget(s, endpoints)}
              />
              <SeverityGroup
                label="MEDIUM"
                suggestions={medium}
                open={openGroups.MEDIUM}
                onToggleGroup={() => setOpenGroups((prev) => ({ ...prev, MEDIUM: !prev.MEDIUM }))}
                expanded={expanded}
                onToggle={toggleCard}
                onAskAI={handleAskAI}
                resolveTarget={(s) => resolveSuggestionTarget(s, endpoints)}
              />
              <SeverityGroup
                label="LOW"
                suggestions={low}
                open={openGroups.LOW}
                onToggleGroup={() => setOpenGroups((prev) => ({ ...prev, LOW: !prev.LOW }))}
                expanded={expanded}
                onToggle={toggleCard}
                onAskAI={handleAskAI}
                resolveTarget={(s) => resolveSuggestionTarget(s, endpoints)}
              />
            </>
          )}

          {endpoints.length > 0 && <EndpointsList endpoints={endpoints} topBorder={suggestions.length === 0} />}
        </div>
      </div>

      <div className="eco-panel-view" style={{ flex: 1, display: tab === "chat" ? "flex" : "none", flexDirection: "column", minHeight: 0 }}>
        <ChatPage context={chatContext} />
      </div>
    </div>
  );
}
