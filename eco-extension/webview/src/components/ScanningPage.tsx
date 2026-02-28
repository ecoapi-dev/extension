import { motion } from "motion/react";
import { Check, Loader2, Minus } from "lucide-react";
import { LeafIcon } from "./LeafIcon";

interface ScanningPageProps {
  files: string[];
  currentIndex: number;
  endpointCount: number;
  total: number;
}

export function ScanningPage({ files, currentIndex, endpointCount, total }: ScanningPageProps) {
  const progress = total > 0 ? ((currentIndex + 1) / total) * 100 : 0;
  // Show the last N scanned files to keep the list manageable
  const visibleFiles = files.slice(Math.max(0, currentIndex - 8), currentIndex + 2);
  const visibleStart = Math.max(0, currentIndex - 8);

  return (
    <div className="flex flex-col items-center justify-center min-h-full px-6 py-12">
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        className="flex flex-col items-center w-full max-w-md"
      >
        <motion.div
          animate={{ rotate: [0, 5, -5, 0] }}
          transition={{ duration: 2, repeat: Infinity, ease: "easeInOut" }}
        >
          <LeafIcon size={48} animated />
        </motion.div>

        {/* Progress bar */}
        <div className="w-full mt-8">
          <div className="flex items-center gap-3 mb-2">
            <div
              className="flex-1 h-2 rounded-full overflow-hidden"
              style={{ backgroundColor: "#1C271C" }}
            >
              <motion.div
                className="h-full rounded-full"
                style={{ backgroundColor: "#4EAA57" }}
                animate={{ width: `${progress}%` }}
                transition={{ duration: 0.3 }}
              />
            </div>
            <span style={{ color: "#7EA87E", fontSize: "0.65rem", flexShrink: 0, maxWidth: "140px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {files[currentIndex] || "..."}
            </span>
          </div>
        </div>

        {/* File list */}
        <div
          className="w-full mt-6 rounded-lg p-3 space-y-1"
          style={{ backgroundColor: "#131A13", border: "1px solid #243224" }}
        >
          {visibleFiles.map((file, i) => {
            const actualIndex = visibleStart + i;
            return (
              <motion.div
                key={file + actualIndex}
                initial={{ opacity: 0, x: -10 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: i * 0.03 }}
                className="flex items-center gap-2.5 py-1.5 px-2 rounded"
                style={{
                  backgroundColor: actualIndex === currentIndex ? "#1C271C" : "transparent",
                }}
              >
                {actualIndex < currentIndex ? (
                  <Check size={14} style={{ color: "#4EAA57", flexShrink: 0 }} />
                ) : actualIndex === currentIndex ? (
                  <motion.div animate={{ rotate: 360 }} transition={{ duration: 1, repeat: Infinity, ease: "linear" }}>
                    <Loader2 size={14} style={{ color: "#4EAA57", flexShrink: 0 }} />
                  </motion.div>
                ) : (
                  <Minus size={14} style={{ color: "#243224", flexShrink: 0 }} />
                )}
                <span
                  style={{
                    fontSize: "0.75rem",
                    color: actualIndex <= currentIndex ? "#D6EDD0" : "#3A4D3A",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {file}
                </span>
              </motion.div>
            );
          })}
        </div>

        {/* Counter */}
        <motion.p
          className="mt-6"
          style={{ color: "#7EA87E", fontSize: "0.85rem" }}
          animate={{ opacity: [0.6, 1, 0.6] }}
          transition={{ duration: 2, repeat: Infinity }}
        >
          Found {endpointCount} endpoints so far...
        </motion.p>
      </motion.div>
    </div>
  );
}
