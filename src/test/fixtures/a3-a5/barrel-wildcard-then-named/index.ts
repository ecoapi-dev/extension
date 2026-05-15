// Wildcard first — wildcard-source does NOT export `ask`.
export * from "./wildcard-source";
// Named re-export second — named-source DOES export `ask`.
export { ask } from "./named-source";
