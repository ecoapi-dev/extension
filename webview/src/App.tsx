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
  const [scanError, setScanError] = useState("");

  // Results state
  const [endpoints, setEndpoints] = useState<EndpointRecord[]>([]);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [summary, setSummary] = useState<ScanSummary>({
    totalEndpoints: 0,
    totalCallsPerDay: 0,
    totalMonthlyCost: 0,
    highRiskCount: 0,
  });
  const [aiReviewRunning, setAiReviewRunning] = useState(false);
  const [aiReviewStage, setAiReviewStage] = useState<string>("");
  const [aiReviewError, setAiReviewError] = useState<string>("");
  const [aiReviewStats, setAiReviewStats] = useState<{ added: number; filtered: number } | null>(null);

  const handleStartScan = useCallback(() => {
    setScanFiles([]);
    setScanIndex(0);
    setScanTotal(0);
    setEndpointCount(0);
    setScanError("");
    setAiReviewRunning(false);
    setAiReviewStage("");
    setAiReviewError("");
    setAiReviewStats(null);
    setScreen("scanning");
    postMessage({ type: "startScan" });
  }, []);

  const handleRunAiReview = useCallback(() => {
    setAiReviewRunning(true);
    setAiReviewStage("Starting AI review...");
    setAiReviewError("");
    setAiReviewStats(null);
    postMessage({ type: "runAiReview" });
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
          setScanError("");
          setTimeout(() => setScreen("results"), 300);
          break;

        case "aiReviewProgress":
          setAiReviewRunning(true);
          setAiReviewStage(msg.stage);
          break;

        case "aiReviewComplete":
          setAiReviewRunning(false);
          setAiReviewStage("");
          setAiReviewStats({ added: msg.added, filtered: msg.filtered });
          break;

        case "aiReviewError":
          setAiReviewRunning(false);
          setAiReviewStage("");
          setAiReviewError(msg.message);
          break;

        case "error":
          if (screen === "scanning") {
            setScanError(msg.message);
          }
          break;
      }
    };

    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [screen, handleStartScan]);

  return (
    <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", overflow: "hidden" }}>
      {screen === "landing" && <LandingPage onStartScan={handleStartScan} />}
      {screen === "scanning" && (
        <ScanningPage
          files={scanFiles}
          currentIndex={scanIndex}
          endpointCount={endpointCount}
          total={scanTotal}
          error={scanError}
        />
      )}
      {screen === "results" && (
        <ResultsPage
          endpoints={endpoints}
          suggestions={suggestions}
          summary={summary}
          onRunAiReview={handleRunAiReview}
          aiReviewRunning={aiReviewRunning}
          aiReviewStage={aiReviewStage}
          aiReviewError={aiReviewError}
          aiReviewStats={aiReviewStats}
        />
      )}
    </div>
  );
}
