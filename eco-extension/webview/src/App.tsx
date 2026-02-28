import { useState, useEffect, useCallback } from "react";
import { LandingPage } from "./components/LandingPage";
import { ScanningPage } from "./components/ScanningPage";
import { ResultsPage } from "./components/ResultsPage";
import { postMessage } from "./vscode";
import type { Suggestion, ScanSummary, HostMessage } from "./types";

type Screen = "landing" | "scanning" | "results";

export default function App() {
  const [screen, setScreen] = useState<Screen>("landing");

  // Scanning state
  const [scanFiles, setScanFiles] = useState<string[]>([]);
  const [scanIndex, setScanIndex] = useState(0);
  const [scanTotal, setScanTotal] = useState(0);
  const [endpointCount, setEndpointCount] = useState(0);

  // Results state
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [summary, setSummary] = useState<ScanSummary>({
    totalEndpoints: 0,
    totalCallsPerDay: 0,
    totalMonthlyCost: 0,
    highRiskCount: 0,
  });

  const handleStartScan = useCallback(() => {
    setScanFiles([]);
    setScanIndex(0);
    setScanTotal(0);
    setEndpointCount(0);
    setScreen("scanning");
    postMessage({ type: "startScan" });
  }, []);

  const handleRescan = useCallback(() => {
    handleStartScan();
  }, [handleStartScan]);

  // Listen for host messages
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const msg = event.data as HostMessage;

      switch (msg.type) {
        case "scanProgress":
          setScanFiles((prev) => {
            if (!prev.includes(msg.file)) {
              return [...prev, msg.file];
            }
            return prev;
          });
          setScanIndex(msg.index);
          setScanTotal(msg.total);
          setEndpointCount(msg.endpointsSoFar);
          break;

        case "scanComplete":
          // Brief pause before showing results for visual transition
          break;

        case "scanResults":
          setSuggestions(msg.suggestions);
          setSummary(msg.summary);
          // Small delay for smooth transition
          setTimeout(() => setScreen("results"), 500);
          break;

        case "error":
          // On error during scan, go back to landing
          if (screen === "scanning") {
            setScreen("landing");
          }
          break;
      }
    };

    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [screen]);

  return (
    <div
      className="w-full h-full flex flex-col overflow-hidden"
      style={{
        backgroundColor: "#0B0F0B",
        fontFamily: "'JetBrains Mono', monospace",
      }}
    >
      {screen === "landing" && <LandingPage onStartScan={handleStartScan} />}
      {screen === "scanning" && (
        <ScanningPage
          files={scanFiles}
          currentIndex={scanIndex}
          endpointCount={endpointCount}
          total={scanTotal}
        />
      )}
      {screen === "results" && (
        <ResultsPage
          onRescan={handleRescan}
          suggestions={suggestions}
          summary={summary}
        />
      )}
    </div>
  );
}
