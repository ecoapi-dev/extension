import { LeafIcon } from "./LeafIcon";

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
        justifyContent: "center",
        height: "100%",
        padding: "24px",
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

      <button
        className="eco-btn-primary"
        onClick={onStartScan}
        style={{ marginTop: "24px" }}
      >
        <span className="codicon codicon-refresh" />
        Scan Workspace
      </button>
    </div>
  );
}
