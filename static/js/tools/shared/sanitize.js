// The masking / sanitize choke point (plan §3.3/§5), extracted from the old
// monolithic tools.js. Every tool result's *text* passes through here
// before it can reach the agent loop — and therefore before it can ever
// reach a model call. Centralized on purpose: the registry (registry.js)
// applies this to every handler's output, so a new tool physically cannot
// forget to scrub.

import { sanitizeText } from "../../masking.js";

// name -> Set<string> of forbidden literal values for that dataset,
// registered by whoever loads a dataset into an engine (workbench.js).
// Merged (union) across all currently-loaded datasets when sanitizing,
// since a run_python call can't be attributed to a single dataset ahead of
// time — over-redaction is the safe failure mode here, not under.
const forbiddenByDataset = new Map();

export function setDatasetMasking(name, forbiddenValues) {
  forbiddenByDataset.set(name, forbiddenValues);
}

function allForbiddenValues() {
  const merged = new Set();
  for (const set of forbiddenByDataset.values()) {
    for (const v of set) merged.add(v);
  }
  return merged;
}

/** Scrub every currently-forbidden literal out of a tool's text output. */
export function sanitize(text) {
  return sanitizeText(text, allForbiddenValues());
}
