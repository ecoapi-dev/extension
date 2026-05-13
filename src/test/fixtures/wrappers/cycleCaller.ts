// Forces the resolver to look up `something` through cycleA's re-export chain.
// cycleA re-exports from cycleB, cycleB re-exports from cycleA → infinite loop
// without cycle protection in resolveExportedMatches.
import { something } from "./cycleA";

export function useIt() {
  return something();
}
