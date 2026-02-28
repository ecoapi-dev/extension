import { useState, useEffect, useCallback } from "react";
import { LandingPage } from "./components/LandingPage";
import { ScanningPage } from "./components/ScanningPage";
import { ResultsPage } from "./components/ResultsPage";
import { postMessage } from "./vscode";
import type { Suggestion, ScanSummary, EndpointRecord, HostMessage } from "./types";

type Screen = "landing" | "scanning" | "results";

export default function App() {
  const [screen, setScreen] = useState<Screen>("landing");

  // Scanning state
  const [scanFiles, setScanFiles] = useState<string[]>([]);
  const [scanIndex, setScanIndex] = useState(0);
  const [scanTotal, setScanTotal] = useState(0);
  const [endpointCount, setEndpointCount] = useState(0);

  // Results state
  const [endpoints, setEndpoints] = useState<EndpointRecord[]>([]);
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

        case "triggerScan":
          handleStartScan();
          break;

        case "scanComplete":
          break;

        case "scanResults":
          setEndpoints(msg.endpoints);
          setSuggestions(msg.suggestions);
          setSummary(msg.summary);
          setTimeout(() => setScreen("results"), 300);
          break;

        case "error":
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
    <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", overflow: "hidden" }}>
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
          endpoints={endpoints}
          suggestions={suggestions}
          summary={summary}
        />
      )}
    </div>
  );
}
