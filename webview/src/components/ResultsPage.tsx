import { useState } from "react";
import { Markdown } from "./Markdown";
import { EstimateDisclaimer } from "./EstimateDisclaimer";
import type { Suggestion, ScanSummary, EndpointRecord } from "../types";
import { postMessage } from "../vscode";

interface ResultsPageProps {
  suggestions: Suggestion[];
  summary: ScanSummary;
  endpoints: EndpointRecord[];
}

function formatCost(n: number): string {
  if (n < 0.01) return '<$0.01';
  if (n >= 1_000) return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `$${n.toFixed(2)}`;
}

const typeLabels: Record<string, string> = {
  n_plus_one: "n+1",
  cache: "cache",
  batch: "batch",
  redundancy: "redundancy",
  rate_limit: "rate-limit",
  concurrency_control: "concurrency",
  retry_storm: "retry storm",
  event_amplification: "event amp",
  sequential: "sequential",
};

const PROVIDER_COLORS: Record<string, string> = {
  openai: "var(--vscode-charts-green)",
  anthropic: "var(--vscode-charts-orange)",
  stripe: "var(--vscode-charts-purple)",
  supabase: "var(--vscode-charts-green)",
  firebase: "var(--vscode-charts-yellow)",
  sendgrid: "var(--vscode-charts-blue)",
  twilio: "var(--vscode-charts-red)",
};


function providerColor(provider: string): string {
  return PROVIDER_COLORS[provider.toLowerCase()] ?? "var(--vscode-descriptionForeground)";
}

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


function ConfidenceBadge({ confidence }: { confidence?: number }) {
  if (typeof confidence !== "number") return null;
  const pct = Math.round(confidence * 100);
  const color =
    confidence >= 0.8
      ? "var(--vscode-charts-green)"
      : confidence >= 0.6
      ? "var(--vscode-foreground)"
      : confidence >= 0.4
      ? "var(--vscode-editorWarning-foreground)"
      : "var(--vscode-editorError-foreground)";
  return (
    <span
      title="How certain the detector is about this finding"
      style={{ color, fontSize: "10px", flexShrink: 0, whiteSpace: "nowrap" }}
    >
      {pct}% confidence
    </span>
  );
}

function PricingBadge({ pricingClass }: { pricingClass?: "paid" | "free" | "unknown" }) {
  if (!pricingClass || pricingClass === "unknown") return null;
  return (
    <span
      style={{
        fontSize: "10px",
        fontWeight: 500,
        padding: "1px 6px",
        borderRadius: "4px",
        backgroundColor: pricingClass === "paid" ? "rgba(234, 179, 8, 0.15)" : "rgba(107, 114, 128, 0.15)",
        color: pricingClass === "paid" ? "var(--vscode-charts-yellow)" : "var(--vscode-descriptionForeground)",
      }}
    >
      {pricingClass === "paid" ? "paid" : "free"}
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
            <span className={`codicon ${copied ? "codicon-check" : "codicon-copy"}`} style={{ fontSize: "12px" }} />
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
  target,
  endpoints,
}: {
  suggestion: Suggestion;
  target: { file?: string; line?: number };
  endpoints: EndpointRecord[];
}) {
  const [expanded, setExpanded] = useState(false);
  const provider = endpoints.find((ep) => suggestion.affectedEndpoints.includes(ep.id))?.provider;

  return (
    <div className="eco-suggestion">
      <button className="eco-suggestion-header" onClick={() => setExpanded((v) => !v)}>
        <span aria-hidden="true" className={`eco-disclosure${expanded ? " open" : ""}`} />
        <TypeBadge type={suggestion.type} />
        {provider && (
          <span style={{ fontSize: "11px", color: "var(--vscode-descriptionForeground)" }}>{provider}</span>
        )}
        <PricingBadge pricingClass={suggestion.pricingClass} />
        {suggestion.sources && suggestion.sources.length > 1 && (
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
            title={suggestion.sources.join(", ")}
          >
            detected by {suggestion.sources.length} sources
          </span>
        )}
        <span style={{ flex: 1 }} />
        {suggestion.estimatedMonthlySavings > 0 && (
          <span style={{ color: "var(--vscode-charts-green, #4caf50)", fontSize: "11px", flexShrink: 0, whiteSpace: "nowrap" }}>
            {formatCost(suggestion.estimatedMonthlySavings)}/mo est. savings
          </span>
        )}
      </button>

      {expanded && (
        <div className="eco-suggestion-body">
          <Markdown content={suggestion.description} />
          {typeof suggestion.confidence === "number" && (
            <span style={{ fontSize: "10px", color: "var(--vscode-descriptionForeground)", opacity: 0.7 }}>
              {Math.round(suggestion.confidence * 100)}% confidence
            </span>
          )}
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
                  onClick={() => postMessage({ type: "openFile", file: f, line: suggestion.targetLine })}
                >
                  {f}
                </button>
              ))}
            </div>
          )}

          {suggestion.codeFix && <CodeFix codeFix={suggestion.codeFix} file={target.file} line={target.line} />}
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
  resolveTarget,
  endpoints,
}: {
  label: string;
  suggestions: Suggestion[];
  open: boolean;
  onToggleGroup: () => void;
  resolveTarget: (s: Suggestion) => { file?: string; line?: number };
  endpoints: EndpointRecord[];
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
      <button className="eco-severity-header" onClick={onToggleGroup} style={{ color }}>
        <span>{label}</span>
        <span style={{ fontSize: "10px", opacity: 0.9 }}>{suggestions.length}</span>
      </button>
      {open &&
        suggestions.map((s) => (
          <SuggestionCard
            key={s.id}
            suggestion={s}
            target={resolveTarget(s)}
            endpoints={endpoints}
          />
        ))}
    </div>
  );
}

function SeverityGroups({ suggestions, endpoints }: { suggestions: Suggestion[]; endpoints: EndpointRecord[] }) {
  const [openGroups, setOpenGroups] = useState<Record<"HIGH" | "MEDIUM" | "LOW", boolean>>({
    HIGH: true,
    MEDIUM: true,
    LOW: true,
  });
  const high = suggestions.filter((s) => s.severity === "high");
  const medium = suggestions.filter((s) => s.severity === "medium");
  const low = suggestions.filter((s) => s.severity === "low");
  const resolveTarget = (s: Suggestion) => resolveSuggestionTarget(s, endpoints);
  return (
    <>
      <SeverityGroup
        label="HIGH"
        suggestions={high}
        open={openGroups.HIGH}
        onToggleGroup={() => setOpenGroups((p) => ({ ...p, HIGH: !p.HIGH }))}
        resolveTarget={resolveTarget}
        endpoints={endpoints}
      />
      <SeverityGroup
        label="MEDIUM"
        suggestions={medium}
        open={openGroups.MEDIUM}
        onToggleGroup={() => setOpenGroups((p) => ({ ...p, MEDIUM: !p.MEDIUM }))}
        resolveTarget={resolveTarget}
        endpoints={endpoints}
      />
      <SeverityGroup
        label="LOW"
        suggestions={low}
        open={openGroups.LOW}
        onToggleGroup={() => setOpenGroups((p) => ({ ...p, LOW: !p.LOW }))}
        resolveTarget={resolveTarget}
        endpoints={endpoints}
      />
    </>
  );
}

function PricingSection({
  title,
  description,
  suggestions,
  endpoints,
  defaultOpen,
}: {
  title: string;
  description: string;
  suggestions: Suggestion[];
  endpoints: EndpointRecord[];
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  if (suggestions.length === 0) return null;
  return (
    <div>
      <button className="eco-severity-header" onClick={() => setOpen(!open)}>
        <span>{title}</span>
        <span style={{ fontSize: "10px", opacity: 0.9 }}>{suggestions.length}</span>
      </button>
      {open && (
        <div>
          <p style={{ fontSize: "11px", color: "var(--vscode-descriptionForeground)", margin: "4px 12px 8px" }}>
            {description}
          </p>
          <SeverityGroups suggestions={suggestions} endpoints={endpoints} />
        </div>
      )}
    </div>
  );
}

// ── Simple endpoint list ──────────────────────────────────────────────────────

const RISK_STATUSES = new Set(["redundant", "n_plus_one_risk", "rate_limit_risk", "cacheable", "batchable"]);
const RISK_FREQUENCIES = new Set(["unbounded-loop", "polling", "bounded-loop", "parallel"]);
function isAtRisk(ep: EndpointRecord): boolean {
  return RISK_STATUSES.has(ep.status) || Boolean(ep.frequencyClass && RISK_FREQUENCIES.has(ep.frequencyClass));
}

const METHOD_ORDER = ["POST", "GET", "PUT", "PATCH", "DELETE"];

function atRiskTooltip(ep: EndpointRecord): string {
  const reasons: string[] = [];
  if (ep.status === "redundant") reasons.push("redundant call");
  if (ep.status === "n_plus_one_risk") reasons.push("N+1 risk");
  if (ep.status === "rate_limit_risk") reasons.push("rate limit risk");
  if (ep.status === "cacheable") reasons.push("cacheable but not cached");
  if (ep.status === "batchable") reasons.push("batchable but not batched");
  if (ep.frequencyClass === "unbounded-loop") reasons.push("inside unbounded loop");
  if (ep.frequencyClass === "polling") reasons.push("polling on timer");
  if (ep.frequencyClass === "bounded-loop") reasons.push("inside loop");
  if (ep.frequencyClass === "parallel") reasons.push("parallel calls");
  return `At risk: ${reasons.join(", ")}`;
}

function ProviderGroup({ provider, eps, pColor }: { provider: string; eps: EndpointRecord[]; pColor: string }) {
  const [open, setOpen] = useState(true);
  return (
    <div>
      <button
        onClick={() => setOpen((v) => !v)}
        style={{
          display: "flex", alignItems: "center", gap: "6px",
          width: "100%", padding: "3px 12px 3px 16px",
          background: "none", border: "none", cursor: "pointer",
          borderBottom: "1px solid var(--vscode-panel-border)",
        }}
      >
        <span style={{ fontSize: "13px", color: pColor, fontWeight: 600 }}>{provider}</span>
        <span style={{ fontSize: "10px", opacity: 0.35, color: "var(--vscode-descriptionForeground)" }}>{eps.length}</span>
        <span className="eco-chevron" style={{ marginLeft: "auto", fontSize: "14px", opacity: 0.5, transform: open ? "rotate(90deg)" : "rotate(0deg)" }}>›</span>
      </button>
      {open && eps.map((ep) => {
        const site = ep.callSites?.[0];
        const filePath = site?.file ?? ep.files?.[0];
        const fileName = filePath ? filePath.replace(/\\/g, "/").split("/").pop() : undefined;
        const risk = isAtRisk(ep);
        return (
          <div key={ep.id} style={{ padding: "5px 12px 5px 24px", borderBottom: "1px solid var(--vscode-panel-border)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "5px" }}>
              <div style={{ fontSize: "12px", color: "var(--vscode-foreground)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }} title={ep.url}>
                {ep.url}
              </div>
              {risk && (
                <span title={atRiskTooltip(ep)} style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: "40px", height: "40px", flexShrink: 0, cursor: "default" }}>
                  <span style={{ width: "6px", height: "6px", borderRadius: "50%", background: "var(--vscode-editorError-foreground)", display: "block", pointerEvents: "none" }} />
                </span>
              )}
            </div>
            {fileName && filePath && (
              <div style={{ display: "flex", flexDirection: "column", gap: "1px" }}>
                <button
                  className="eco-btn-link"
                  style={{ fontSize: "10px", opacity: 0.7, maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", textAlign: "left" }}
                  title={site?.callTrace?.callSite.file ?? filePath}
                  onClick={() =>
                    postMessage({
                      type: "openFile",
                      file: site?.callTrace?.callSite.file ?? filePath,
                      line: site?.callTrace?.callSite.span.startLine ?? site?.line,
                      span: site?.callTrace?.callSite.span ?? site?.span,
                    })
                  }
                >
                  {fileName}{(site?.callTrace?.callSite.span.startLine ?? site?.line) ? `:${site?.callTrace?.callSite.span.startLine ?? site?.line}` : ""}
                </button>
                {site?.callTrace && site.callTrace.hops > 0 && (
                  <button
                    className="eco-btn-link"
                    style={{ fontSize: "10px", opacity: 0.55, maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", textAlign: "left" }}
                    title={`Underlying call: ${site.callTrace.resolvedSite.file}:${site.callTrace.resolvedSite.span.startLine}`}
                    onClick={() =>
                      postMessage({
                        type: "openFile",
                        file: site.callTrace!.resolvedSite.file,
                        line: site.callTrace!.resolvedSite.span.startLine,
                        span: site.callTrace!.resolvedSite.span,
                      })
                    }
                  >
                    ↳ underlying call ({site.callTrace.resolvedSite.file.split("/").pop()}:{site.callTrace.resolvedSite.span.startLine})
                  </button>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function MethodGroup({ method, providerMap, pColor }: { method: string; providerMap: Map<string, EndpointRecord[]>; pColor: (p: string) => string }) {
  const [open, setOpen] = useState(true);
  const sortedProviders = [...providerMap.keys()].sort((a, b) => a.localeCompare(b));
  const total = [...providerMap.values()].reduce((s, v) => s + v.length, 0);
  return (
    <div>
      <button
        onClick={() => setOpen((v) => !v)}
        style={{
          display: "flex", alignItems: "center", gap: "6px",
          width: "100%", padding: "6px 12px",
          background: "var(--vscode-editorGroupHeader-tabsBackground)",
          border: "none", cursor: "pointer",
          borderBottom: "1px solid var(--vscode-panel-border)",
        }}
      >
        <span style={{ fontSize: "17px", fontWeight: 700, letterSpacing: "0.06em", color: "var(--vscode-foreground)" }}>{method}</span>
        <span style={{ fontWeight: 400, opacity: 0.45, fontSize: "10px" }}>{total}</span>
        <span className="eco-chevron" style={{ marginLeft: "auto", fontSize: "16px", opacity: 0.5, transform: open ? "rotate(90deg)" : "rotate(0deg)" }}>›</span>
      </button>
      {open && sortedProviders.map((provider) => (
        <ProviderGroup key={provider} provider={provider} eps={providerMap.get(provider)!} pColor={pColor(provider)} />
      ))}
    </div>
  );
}

function GroupedEndpointList({ endpoints }: { endpoints: EndpointRecord[] }) {
  const byMethod = new Map<string, Map<string, EndpointRecord[]>>();
  const methodsSeen: string[] = [];
  for (const ep of endpoints) {
    const m = ep.method.toUpperCase();
    if (!byMethod.has(m)) { byMethod.set(m, new Map()); methodsSeen.push(m); }
    const byProvider = byMethod.get(m)!;
    const p = ep.provider || "unknown";
    if (!byProvider.has(p)) byProvider.set(p, []);
    byProvider.get(p)!.push(ep);
  }
  const sortedMethods = methodsSeen.sort((a, b) => {
    const ia = METHOD_ORDER.indexOf(a), ib = METHOD_ORDER.indexOf(b);
    if (ia !== -1 && ib !== -1) return ia - ib;
    if (ia !== -1) return -1; if (ib !== -1) return 1;
    return a.localeCompare(b);
  });
  const pColor = (p: string) => PROVIDER_COLORS[p.toLowerCase()] ?? "var(--vscode-descriptionForeground)";
  return (
    <div>
      {sortedMethods.map((method) => (
        <MethodGroup key={method} method={method} providerMap={byMethod.get(method)!} pColor={pColor} />
      ))}
    </div>
  );
}

function EndpointsTab({ endpoints }: { endpoints: EndpointRecord[] }) {

  // Provider counts
  const providerCounts = new Map<string, number>();
  for (const ep of endpoints) {
    if (ep.provider && ep.provider !== "unknown") {
      providerCounts.set(ep.provider, (providerCounts.get(ep.provider) ?? 0) + 1);
    }
  }
  const sortedProviders = [...providerCounts.entries()].sort((a, b) => b[1] - a[1]);

  if (endpoints.length === 0) {
    return (
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "32px 16px", gap: "8px", color: "var(--vscode-descriptionForeground)" }}>
        <span className="codicon codicon-search" style={{ fontSize: "24px" }} />
        <span>No API calls detected</span>
        <span style={{ fontSize: "10px", opacity: 0.6 }}>Check your scan glob settings or try re-scanning</span>
      </div>
    );
  }

  return (
    <div>
      {/* Provider summary counts */}
      {sortedProviders.length > 0 && (
        <div style={{ padding: "6px 12px 4px", borderBottom: "1px solid var(--vscode-panel-border)", display: "flex", flexWrap: "wrap", gap: "4px", fontSize: "10px" }}>
          {sortedProviders.map(([provider, count], i) => (
            <span key={provider}>
              <span style={{ color: providerColor(provider) }}>{provider}</span>
              <span style={{ color: "var(--vscode-descriptionForeground)" }}> ×{count}</span>
              {i < sortedProviders.length - 1 && <span style={{ opacity: 0.3, marginLeft: "4px" }}>·</span>}
            </span>
          ))}
          {endpoints.every((ep) => ep.costModel === "free") && (
            <span style={{ color: "var(--vscode-charts-green)", marginLeft: "4px" }}>· all free tier</span>
          )}
        </div>
      )}

      <GroupedEndpointList endpoints={endpoints} />
    </div>
  );
}

export function ResultsPage({
  suggestions,
  summary,
  endpoints,
}: ResultsPageProps) {
  const [findingsTab, setFindingsTab] = useState<"issues" | "endpoints">("issues");
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [minConfidence, setMinConfidence] = useState(0); // 0 = show all

  const presentTypes = Array.from(new Set(suggestions.map((s) => s.type))).sort();
  const visibleSuggestions = (typeFilter === "all" ? suggestions : suggestions.filter((s) => s.type === typeFilter))
    .filter((s) => (typeof s.confidence === "number" ? s.confidence : 1) >= minConfidence);

  const freeCount = endpoints.filter((ep) => ep.costModel === "free").length;
  const inLoopsCount = endpoints.filter((ep) => ep.frequencyClass && ep.frequencyClass.includes("loop")).length;
  const atRiskCount = endpoints.filter(isAtRisk).length;

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
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
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "0" }}>
          {summary.totalEndpoints} endpoints
          <span style={{ margin: "0 5px", opacity: 0.4 }}>|</span>
          {suggestions.length} issues
          <span style={{ margin: "0 5px", opacity: 0.4 }}>|</span>
          <span
            title="Estimated monthly spend across all detected API endpoints. Based on static analysis — actual spend depends on production call volumes."
            style={{ cursor: "help" }}
          >
            Est. {formatCost(summary.totalMonthlyCost)}/mo spend
          </span>
          {summary.highRiskCount > 0 && (
            <>
              <span style={{ margin: "0 5px", opacity: 0.4 }}>|</span>
              <span style={{ color: "var(--vscode-editorError-foreground)" }}>{summary.highRiskCount} high</span>
            </>
          )}
          {freeCount > 0 && (
            <>
              <span style={{ margin: "0 5px", opacity: 0.4 }}>|</span>
              <span style={{ color: "var(--vscode-charts-green)" }}>{freeCount} free</span>
            </>
          )}
          {inLoopsCount > 0 && (
            <>
              <span style={{ margin: "0 5px", opacity: 0.4 }}>|</span>
              <span style={{ color: "var(--vscode-editorWarning-foreground)" }}>{inLoopsCount} in loops</span>
            </>
          )}
        </div>
      </div>

      {/* Subtab bar */}
      <div style={{ display: "flex", flexShrink: 0, borderBottom: "1px solid var(--vscode-panel-border)", background: "var(--vscode-editorGroupHeader-tabsBackground)" }}>
        <button
          className={`eco-tab${findingsTab === "issues" ? " active" : ""}`}
          onClick={() => setFindingsTab("issues")}
        >
          Issues{suggestions.length > 0 && <span style={{ marginLeft: "4px", opacity: 0.6, fontSize: "10px" }}>{suggestions.length}</span>}
        </button>
        <button
          className={`eco-tab${findingsTab === "endpoints" ? " active" : ""}`}
          onClick={() => setFindingsTab("endpoints")}
        >
          Endpoints{endpoints.length > 0 && <span style={{ marginLeft: "4px", opacity: 0.6, fontSize: "10px" }}>{endpoints.length}</span>}
          {atRiskCount > 0 && <span style={{ marginLeft: "3px", color: "var(--vscode-editorError-foreground)", fontSize: "10px" }}>({atRiskCount} at risk)</span>}
        </button>
      </div>

      {/* Tab content */}
      <div className="eco-scroll-invisible" style={{ flex: 1, overflowY: "auto", minHeight: 0 }}>
        <EstimateDisclaimer />
        {findingsTab === "issues" && (
          <>
            {suggestions.length === 0 ? (
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "40px 16px", gap: "8px", color: "var(--vscode-descriptionForeground)" }}>
                <span className="codicon codicon-check" style={{ fontSize: "24px" }} />
                <span>No issues found</span>
              </div>
            ) : (
              <>
                <div style={{ padding: "5px 12px", borderBottom: "1px solid var(--vscode-panel-border)", display: "flex", alignItems: "center", gap: "6px" }}>
                  {presentTypes.length > 1 && (
                    <>
                      <span style={{ fontSize: "10px", color: "var(--vscode-descriptionForeground)", flexShrink: 0 }}>Type</span>
                      <select
                        className="eco-input"
                        style={{ fontSize: "10px", padding: "2px 6px", height: "22px" }}
                        value={typeFilter}
                        onChange={(e) => setTypeFilter(e.target.value)}
                      >
                        <option value="all">All ({suggestions.length})</option>
                        {presentTypes.map((t) => (
                          <option key={t} value={t}>{t} ({suggestions.filter((s) => s.type === t).length})</option>
                        ))}
                      </select>
                    </>
                  )}
                  <select
                    aria-label="Minimum confidence"
                    className="eco-input"
                    style={{ fontSize: "10px", padding: "2px 6px", height: "22px" }}
                    value={minConfidence}
                    onChange={(e) => setMinConfidence(Number(e.target.value))}
                  >
                    <option value={0}>Any confidence</option>
                    <option value={0.4}>≥ 40%</option>
                    <option value={0.6}>≥ 60%</option>
                    <option value={0.8}>≥ 80%</option>
                  </select>
                </div>
                {(() => {
                  const paidIssues = visibleSuggestions.filter((s) => s.pricingClass === "paid");
                  const freeIssues = visibleSuggestions.filter((s) => s.pricingClass === "free");
                  const unknownIssues = visibleSuggestions.filter((s) => !s.pricingClass || s.pricingClass === "unknown");
                  const hasPaid = paidIssues.length > 0;
                  const hasFree = freeIssues.length > 0;
                  return (
                    <>
                      <PricingSection
                        title="Paid API Issues"
                        description="These findings relate to paid external API calls and have direct cost impact."
                        suggestions={paidIssues}
                        endpoints={endpoints}
                        defaultOpen={true}
                      />
                      <PricingSection
                        title="Free API Issues"
                        description="These findings relate to free tier APIs. No direct cost impact but may affect reliability."
                        suggestions={freeIssues}
                        endpoints={endpoints}
                        defaultOpen={!hasPaid}
                      />
                      <PricingSection
                        title="Unknown"
                        description="These findings relate to APIs where pricing could not be determined."
                        suggestions={unknownIssues}
                        endpoints={endpoints}
                        defaultOpen={!hasPaid && !hasFree}
                      />
                    </>
                  );
                })()}
              </>
            )}
          </>
        )}

        {findingsTab === "endpoints" && <EndpointsTab endpoints={endpoints} />}
      </div>
    </div>
  );
}
