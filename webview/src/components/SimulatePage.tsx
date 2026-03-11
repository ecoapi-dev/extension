import { useState, useEffect, useCallback, useRef } from "react";
import { postMessage } from "../vscode";
import type {
  EndpointRecord,
  InputMode,
  SimulatorInput,
  SimulatorResult,
  ProviderSimResult,
  EndpointSimResult,
} from "../types";
import { SCALE_PRESETS } from "../types";

type Grouping = "provider" | "endpoint";

function fmt(n: number): string {
  if (n < 0.01) return "<$0.01";
  return `$${n.toFixed(2)}`;
}

function fmtRange(low: number, high: number): string {
  return `${fmt(low)} – ${fmt(high)}`;
}

function fmtNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toFixed(0);
}

function MethodBadge({ method }: { method: string }) {
  const colors: Record<string, string> = {
    GET: "#22c55e",
    POST: "#3b82f6",
    PUT: "#f59e0b",
    PATCH: "#8b5cf6",
    DELETE: "#ef4444",
  };
  const color = colors[method.toUpperCase()] ?? "#6b7280";
  return (
    <span
      style={{
        fontSize: "9px",
        fontWeight: 700,
        color,
        border: `1px solid ${color}`,
        borderRadius: "3px",
        padding: "0 4px",
        flexShrink: 0,
        letterSpacing: "0.04em",
      }}
    >
      {method.toUpperCase()}
    </span>
  );
}

function CostBar({ pct }: { pct: number }) {
  return (
    <div
      style={{
        height: "3px",
        borderRadius: "2px",
        background: "var(--vscode-panel-border)",
        marginTop: "3px",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          height: "100%",
          width: `${Math.min(100, Math.max(0, pct))}%`,
          background: "var(--vscode-textLink-foreground)",
          borderRadius: "2px",
          transition: "width 0.3s ease",
        }}
      />
    </div>
  );
}

function ProviderRow({ provider }: { provider: ProviderSimResult }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div
      style={{
        borderBottom: "1px solid var(--vscode-panel-border)",
        paddingBottom: "6px",
        marginBottom: "4px",
      }}
    >
      <div
        onClick={() => setExpanded((v) => !v)}
        style={{
          display: "flex",
          alignItems: "flex-start",
          cursor: "pointer",
          gap: "6px",
          padding: "4px 0",
        }}
      >
        <span
          className="codicon"
          style={{
            fontSize: "10px",
            color: "var(--vscode-descriptionForeground)",
            marginTop: "2px",
            flexShrink: 0,
          }}
        >
          {expanded ? "▾" : "▸"}
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "baseline",
              gap: "8px",
            }}
          >
            <span
              style={{
                fontSize: "12px",
                fontWeight: 600,
                color: "var(--vscode-foreground)",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {provider.provider}
            </span>
            <span
              style={{
                fontSize: "11px",
                color: "var(--vscode-foreground)",
                fontWeight: 500,
                flexShrink: 0,
              }}
            >
              {fmtRange(provider.monthlyCost.low, provider.monthlyCost.high)}/mo
            </span>
          </div>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              fontSize: "10px",
              color: "var(--vscode-descriptionForeground)",
              marginTop: "1px",
            }}
          >
            <span>{fmtRange(provider.dailyCost.low, provider.dailyCost.high)}/day</span>
            <span>{provider.percentOfTotal.toFixed(1)}% of total</span>
          </div>
          <CostBar pct={provider.percentOfTotal} />
        </div>
      </div>

      {expanded && (
        <div style={{ paddingLeft: "18px" }}>
          {provider.endpoints.map((ep) => (
            <EndpointRow key={ep.endpointId} endpoint={ep} />
          ))}
        </div>
      )}
    </div>
  );
}

function EndpointRow({ endpoint }: { endpoint: EndpointSimResult }) {
  return (
    <div
      style={{
        padding: "4px 0",
        borderBottom: "1px solid var(--vscode-panel-border)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "6px",
          marginBottom: "2px",
        }}
      >
        <MethodBadge method={endpoint.method} />
        <span
          style={{
            fontSize: "11px",
            color: "var(--vscode-foreground)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            flex: 1,
            minWidth: 0,
          }}
          title={endpoint.url}
        >
          {endpoint.url}
        </span>
        <span
          style={{
            fontSize: "10px",
            color: "var(--vscode-foreground)",
            fontWeight: 500,
            flexShrink: 0,
          }}
        >
          {fmtRange(endpoint.monthlyCost.low, endpoint.monthlyCost.high)}/mo
        </span>
      </div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          fontSize: "10px",
          color: "var(--vscode-descriptionForeground)",
        }}
      >
        <span>{fmtNum(endpoint.scaledCallsPerDay)} calls/day</span>
        <span>{fmtRange(endpoint.dailyCost.low, endpoint.dailyCost.high)}/day</span>
      </div>
      <CostBar pct={endpoint.percentOfTotal} />
    </div>
  );
}

interface SimulatePageProps {
  endpoints: EndpointRecord[];
}

export function SimulatePage({ endpoints }: SimulatePageProps) {
  const [mode, setMode] = useState<InputMode>("user-centric");
  const [dau, setDau] = useState<string>("");
  const [callsPerUser, setCallsPerUser] = useState<string>("1");
  const [totalCalls, setTotalCalls] = useState<string>("");
  const [grouping, setGrouping] = useState<Grouping>("provider");
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [showOverrides, setShowOverrides] = useState(false);
  const [result, setResult] = useState<SimulatorResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const buildInput = useCallback((): SimulatorInput => {
    const frequencyOverrides: Record<string, number> = {};
    for (const [id, val] of Object.entries(overrides)) {
      const n = parseFloat(val);
      if (!isNaN(n) && n >= 0) frequencyOverrides[id] = n;
    }
    if (mode === "user-centric") {
      return {
        mode,
        dau: dau ? parseFloat(dau) : undefined,
        callsPerUserPerDay: callsPerUser ? parseFloat(callsPerUser) : 1,
        frequencyOverrides,
      };
    }
    return {
      mode,
      totalCallsPerDay: totalCalls ? parseFloat(totalCalls) : undefined,
      frequencyOverrides,
    };
  }, [mode, dau, callsPerUser, totalCalls, overrides]);

  // Run simulation reactively on input change (debounced)
  useEffect(() => {
    if (endpoints.length === 0) return;
    const input = buildInput();
    const hasValue =
      input.mode === "user-centric"
        ? (input.dau ?? 0) > 0
        : (input.totalCallsPerDay ?? 0) > 0;
    if (!hasValue) {
      setResult(null);
      setError(null);
      return;
    }
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      postMessage({ type: "runSimulation", input });
    }, 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [mode, dau, callsPerUser, totalCalls, overrides, endpoints.length, buildInput]);

  // Listen for simulation results
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const msg = event.data;
      if (msg?.type === "simulationResult") {
        setResult(msg.result as SimulatorResult);
        setError(null);
      } else if (msg?.type === "simulationError") {
        setError(msg.message as string);
        setResult(null);
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, []);

  function switchMode(newMode: InputMode) {
    if (newMode === mode) return;
    if (newMode === "volume-centric") {
      // Convert: total = dau × callsPerUser
      const d = parseFloat(dau);
      const c = parseFloat(callsPerUser) || 1;
      if (!isNaN(d) && d > 0) setTotalCalls(String(Math.round(d * c)));
    } else {
      // Convert back: preserve dau, derive callsPerUser if possible
      const t = parseFloat(totalCalls);
      const d = parseFloat(dau);
      if (!isNaN(t) && !isNaN(d) && d > 0) {
        setCallsPerUser(String(Math.max(1, Math.round(t / d))));
      }
    }
    setMode(newMode);
  }

  function applyPreset(preset: (typeof SCALE_PRESETS)[number]) {
    if (mode === "user-centric") {
      setDau(String(preset.dau));
    } else {
      setTotalCalls(String(preset.volume));
    }
  }

  const inputStyle: React.CSSProperties = {
    background: "var(--vscode-input-background)",
    color: "var(--vscode-input-foreground)",
    border: "1px solid var(--vscode-input-border, var(--vscode-panel-border))",
    borderRadius: "3px",
    padding: "3px 6px",
    fontSize: "12px",
    outline: "none",
    width: "100%",
    boxSizing: "border-box",
  };

  const labelStyle: React.CSSProperties = {
    fontSize: "11px",
    color: "var(--vscode-descriptionForeground)",
    marginBottom: "3px",
    display: "block",
  };

  if (endpoints.length === 0) {
    return (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          flex: 1,
          gap: "12px",
          padding: "24px",
          textAlign: "center",
        }}
      >
        <span
          className="codicon codicon-graph"
          style={{ fontSize: "28px", color: "var(--vscode-descriptionForeground)" }}
        />
        <p style={{ margin: 0, fontSize: "12px", color: "var(--vscode-descriptionForeground)" }}>
          Run a scan first to use the simulator.
        </p>
        <button
          className="eco-btn-primary"
          onClick={() => postMessage({ type: "startScan" })}
          style={{ fontSize: "12px", padding: "5px 14px" }}
        >
          Scan Workspace
        </button>
      </div>
    );
  }

  // Flat endpoint list for endpoint-grouping view
  const flatEndpoints: EndpointSimResult[] = result
    ? result.byProvider.flatMap((p) => p.endpoints).sort((a, b) => b.monthlyCost.mid - a.monthlyCost.mid)
    : [];

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        flex: 1,
        minHeight: 0,
        overflow: "hidden",
      }}
    >
      <div style={{ flex: 1, overflowY: "auto", padding: "10px 12px" }}>

        {/* Mode toggle */}
        <div style={{ display: "flex", gap: "4px", marginBottom: "10px" }}>
          <button
            className={`eco-tab${mode === "user-centric" ? " active" : ""}`}
            onClick={() => switchMode("user-centric")}
            style={{ flex: 1, fontSize: "11px" }}
          >
            Per User
          </button>
          <button
            className={`eco-tab${mode === "volume-centric" ? " active" : ""}`}
            onClick={() => switchMode("volume-centric")}
            style={{ flex: 1, fontSize: "11px" }}
          >
            Total Volume
          </button>
        </div>

        {/* Inputs */}
        {mode === "user-centric" ? (
          <div style={{ display: "flex", gap: "8px", marginBottom: "10px" }}>
            <div style={{ flex: 1 }}>
              <label style={labelStyle}>Daily Active Users</label>
              <input
                type="number"
                min="0"
                placeholder="e.g. 1000"
                value={dau}
                onChange={(e) => setDau(e.target.value)}
                style={inputStyle}
              />
            </div>
            <div style={{ flex: 1 }}>
              <label style={labelStyle}>Calls / user / day</label>
              <input
                type="number"
                min="0"
                step="0.1"
                placeholder="1"
                value={callsPerUser}
                onChange={(e) => setCallsPerUser(e.target.value)}
                style={inputStyle}
              />
            </div>
          </div>
        ) : (
          <div style={{ marginBottom: "10px" }}>
            <label style={labelStyle}>Total API Calls / Day</label>
            <input
              type="number"
              min="0"
              placeholder="e.g. 5000"
              value={totalCalls}
              onChange={(e) => setTotalCalls(e.target.value)}
              style={inputStyle}
            />
          </div>
        )}

        {/* Presets */}
        <div
          style={{
            display: "flex",
            gap: "4px",
            marginBottom: "12px",
            flexWrap: "wrap",
          }}
        >
          {SCALE_PRESETS.map((p) => (
            <button
              key={p.label}
              onClick={() => applyPreset(p)}
              style={{
                fontSize: "10px",
                padding: "2px 8px",
                borderRadius: "10px",
                border: "1px solid var(--vscode-panel-border)",
                background: "var(--vscode-editorGroupHeader-tabsBackground)",
                color: "var(--vscode-foreground)",
                cursor: "pointer",
                flexShrink: 0,
              }}
            >
              {p.label}
            </button>
          ))}
        </div>

        {/* Per-endpoint overrides */}
        <div style={{ marginBottom: "12px" }}>
          <button
            onClick={() => setShowOverrides((v) => !v)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "4px",
              fontSize: "11px",
              color: "var(--vscode-textLink-foreground)",
              background: "none",
              border: "none",
              cursor: "pointer",
              padding: 0,
            }}
          >
            <span>{showOverrides ? "▾" : "▸"}</span>
            Frequency overrides ({endpoints.length} endpoints)
          </button>

          {showOverrides && (
            <div
              style={{
                marginTop: "6px",
                border: "1px solid var(--vscode-panel-border)",
                borderRadius: "4px",
                maxHeight: "140px",
                overflowY: "auto",
              }}
            >
              {endpoints.map((ep) => (
                <div
                  key={ep.id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "6px",
                    padding: "4px 8px",
                    borderBottom: "1px solid var(--vscode-panel-border)",
                  }}
                >
                  <MethodBadge method={ep.method} />
                  <span
                    style={{
                      flex: 1,
                      fontSize: "10px",
                      color: "var(--vscode-foreground)",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                    title={ep.url}
                  >
                    {ep.url}
                  </span>
                  <input
                    type="number"
                    min="0"
                    step="0.1"
                    placeholder="1"
                    value={overrides[ep.id] ?? ""}
                    onChange={(e) =>
                      setOverrides((prev) => ({ ...prev, [ep.id]: e.target.value }))
                    }
                    style={{
                      ...inputStyle,
                      width: "52px",
                      padding: "2px 4px",
                      fontSize: "10px",
                    }}
                  />
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Error */}
        {error && (
          <div
            style={{
              padding: "8px 10px",
              borderRadius: "4px",
              background: "var(--vscode-inputValidation-errorBackground)",
              border: "1px solid var(--vscode-inputValidation-errorBorder)",
              color: "var(--vscode-inputValidation-errorForeground)",
              fontSize: "11px",
              marginBottom: "12px",
            }}
          >
            {error}
          </div>
        )}

        {/* Results */}
        {result && (
          <div>
            {/* Total cost banner */}
            <div
              style={{
                padding: "10px 12px",
                borderRadius: "6px",
                background: "var(--vscode-editorGroupHeader-tabsBackground)",
                border: "1px solid var(--vscode-panel-border)",
                marginBottom: "10px",
              }}
            >
              <div
                style={{
                  fontSize: "11px",
                  color: "var(--vscode-descriptionForeground)",
                  marginBottom: "2px",
                }}
              >
                Estimated Monthly Cost
              </div>
              <div
                style={{
                  fontSize: "18px",
                  fontWeight: 700,
                  color: "var(--vscode-foreground)",
                  marginBottom: "2px",
                }}
              >
                {fmtRange(result.totalMonthlyCost.low, result.totalMonthlyCost.high)}
              </div>
              <div
                style={{
                  fontSize: "11px",
                  color: "var(--vscode-descriptionForeground)",
                }}
              >
                Daily: {fmtRange(result.totalDailyCost.low, result.totalDailyCost.high)}
              </div>
              <div style={{ marginTop: "6px", display: "flex", alignItems: "center", gap: "6px" }}>
                <span
                  style={{
                    fontSize: "9px",
                    padding: "1px 6px",
                    borderRadius: "8px",
                    background: "var(--vscode-badge-background)",
                    color: "var(--vscode-badge-foreground)",
                    fontWeight: 600,
                  }}
                >
                  LOW CONFIDENCE
                </span>
                <span
                  style={{ fontSize: "10px", color: "var(--vscode-descriptionForeground)" }}
                >
                  Static analysis — ±30% range
                </span>
              </div>
            </div>

            {/* Grouping toggle */}
            <div style={{ display: "flex", gap: "4px", marginBottom: "8px" }}>
              <button
                className={`eco-tab${grouping === "provider" ? " active" : ""}`}
                onClick={() => setGrouping("provider")}
                style={{ flex: 1, fontSize: "11px" }}
              >
                By Provider
              </button>
              <button
                className={`eco-tab${grouping === "endpoint" ? " active" : ""}`}
                onClick={() => setGrouping("endpoint")}
                style={{ flex: 1, fontSize: "11px" }}
              >
                By Endpoint
              </button>
            </div>

            {/* Results list */}
            <div>
              {grouping === "provider"
                ? result.byProvider.map((p) => (
                    <ProviderRow key={p.provider} provider={p} />
                  ))
                : flatEndpoints.map((ep) => (
                    <EndpointRow key={ep.endpointId} endpoint={ep} />
                  ))}
            </div>

            {/* Confidence notice */}
            <div
              style={{
                marginTop: "12px",
                padding: "8px 10px",
                borderRadius: "4px",
                border: "1px solid var(--vscode-panel-border)",
                fontSize: "10px",
                color: "var(--vscode-descriptionForeground)",
                lineHeight: "1.4",
              }}
            >
              Estimates are based on average per-request costs from the provider registry.
              Enable payload inspection for higher accuracy.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
