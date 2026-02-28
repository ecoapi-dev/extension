import { motion } from "motion/react";
import { Search } from "lucide-react";
import { LeafIcon } from "./LeafIcon";

interface LandingPageProps {
  onStartScan: () => void;
}

export function LandingPage({ onStartScan }: LandingPageProps) {
  const features = ["N+1 risks", "Redundant calls", "Cache candidates", "Rate limit risks"];

  return (
    <div className="flex flex-col items-center justify-center min-h-full px-6 py-12">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6 }}
        className="flex flex-col items-center max-w-md"
      >
        <motion.div
          animate={{ y: [0, -6, 0] }}
          transition={{ duration: 3, repeat: Infinity, ease: "easeInOut" }}
        >
          <LeafIcon size={80} />
        </motion.div>

        <h1
          className="mt-4 tracking-[0.3em]"
          style={{ color: "#D6EDD0", fontSize: "2rem", fontWeight: 700 }}
        >
          ECO
        </h1>

        <p
          className="mt-4 text-center"
          style={{ color: "#7EA87E", fontSize: "0.875rem", lineHeight: 1.7 }}
        >
          API usage analyzer for your codebase. Find waste, cut costs, write cleaner code.
        </p>

        <motion.button
          whileHover={{ scale: 1.03 }}
          whileTap={{ scale: 0.97 }}
          onClick={onStartScan}
          className="mt-8 px-8 py-3 rounded-lg flex items-center gap-2.5 cursor-pointer"
          style={{
            backgroundColor: "#4EAA57",
            color: "#0B0F0B",
            fontSize: "0.9rem",
            fontWeight: 600,
            border: "none",
          }}
        >
          <Search size={18} />
          Start Scanning
        </motion.button>

        <div className="mt-8 flex flex-wrap justify-center gap-2">
          {features.map((feature) => (
            <span
              key={feature}
              className="px-3 py-1 rounded-full"
              style={{
                backgroundColor: "#1C271C",
                color: "#7EA87E",
                fontSize: "0.75rem",
                border: "1px solid #243224",
              }}
            >
              {feature}
            </span>
          ))}
        </div>
      </motion.div>
    </div>
  );
}
