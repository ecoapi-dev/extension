import { LeafIcon } from "./LeafIcon";
import { postMessage } from "../vscode";

interface LandingPageProps {
  onStartScan: () => void;
}

export function LandingPage({ onStartScan }: LandingPageProps) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "flex-start",
        height: "100%",
        padding: "56px 24px 24px",
      }}
    >
      <LeafIcon size={40} />

      <h1
        style={{
          marginTop: "16px",
          letterSpacing: "0.25em",
          fontSize: "1.4em",
          fontWeight: 700,
          color: "var(--vscode-foreground)",
        }}
      >
        ECO
      </h1>

      <p
        style={{
          marginTop: "8px",
          color: "var(--vscode-descriptionForeground)",
          textAlign: "center",
          lineHeight: 1.5,
        }}
      >
        API usage analyzer for your codebase.
      </p>

      <div style={{ marginTop: "24px", display: "flex", width: "100%", maxWidth: "340px", gap: "8px" }}>
        <button
          className="eco-btn-primary"
          onClick={onStartScan}
          style={{ flex: 1, justifyContent: "center", height: "34px", padding: "0 12px", whiteSpace: "nowrap" }}
        >
          Scan Workspace
        </button>
        <button
          className="eco-btn-primary"
          onClick={() => postMessage({ type: "openDashboard" })}
          style={{ flex: 1, justifyContent: "center", height: "34px", padding: "0 12px", whiteSpace: "nowrap" }}
        >
          Open Dashboard
        </button>
      </div>
    </div>
  );
}
