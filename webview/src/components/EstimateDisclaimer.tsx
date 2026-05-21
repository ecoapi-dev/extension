export const ESTIMATE_DISCLAIMER =
  "Static-analysis estimates based on code patterns. The ReCost dashboard shows runtime-measured costs from production.";

export function EstimateDisclaimer() {
  return (
    <div
      style={{
        padding: "8px 12px",
        borderBottom: "1px solid var(--vscode-panel-border)",
        background:
          "color-mix(in srgb, var(--vscode-editorInfo-foreground, var(--vscode-textLink-foreground)) 8%, var(--vscode-editor-background))",
        color: "var(--vscode-descriptionForeground)",
        fontSize: "11px",
        lineHeight: 1.4,
      }}
    >
      {ESTIMATE_DISCLAIMER}
    </div>
  );
}
