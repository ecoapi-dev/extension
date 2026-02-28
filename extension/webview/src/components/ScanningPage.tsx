import { LeafIcon } from "./LeafIcon";

interface ScanningPageProps {
  files: string[];
  currentIndex: number;
  endpointCount: number;
  total: number;
}

export function ScanningPage({ files, currentIndex, endpointCount, total }: ScanningPageProps) {
  const progress = total > 0 ? ((currentIndex + 1) / total) * 100 : 0;
  const currentFile = files[currentIndex] || "";

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
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", width: "100%", maxWidth: "320px" }}>
        <LeafIcon size={36} animated />

        {/* Progress bar */}
        <div
          style={{
            width: "100%",
            height: "1px",
            background: "var(--vscode-panel-border)",
            marginTop: "24px",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              height: "100%",
              background: "var(--vscode-progressBar-background)",
              width: `${progress}%`,
              transition: "width 0.3s ease",
            }}
          />
        </div>

        {/* Current file */}
        <p
          style={{
            marginTop: "10px",
            width: "100%",
            color: "var(--vscode-descriptionForeground)",
            fontSize: "11px",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {currentFile}
        </p>

        {/* Counter */}
        <p style={{ marginTop: "20px", color: "var(--vscode-descriptionForeground)" }}>
          {endpointCount > 0 ? `${endpointCount} endpoints found` : "Scanning…"}
        </p>
      </div>
    </div>
  );
}
