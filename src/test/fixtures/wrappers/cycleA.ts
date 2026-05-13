// Cycle fixture: re-exports `something` from cycleB, which re-exports it back.
// `something` does not actually exist anywhere — the point is the re-export
// lookup loops cycleA → cycleB → cycleA → ... unless cycle protection in
// resolveExportedMatches breaks the chain via the `visited` set.
export { something } from "./cycleB";
