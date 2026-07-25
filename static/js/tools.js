// Back-compat shim. The tool layer moved out of this one monolithic file
// into ./tools/ (a registry + one module per tool — see tools/index.js and
// plans/tool-expansion-and-visualization.md §2). This re-export keeps
// existing importers (agent-loop.js's `callTool`, and any stragglers)
// working through the transition; new code should import from
// ./tools/index.js directly. Remove this file once nothing imports it.
export * from "./tools/index.js";
