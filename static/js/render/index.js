// Dispatch a stored render artifact (tools/shared/render-store.js) to its
// renderer. One switch point so workbench.js doesn't grow a type check per
// artifact kind. Every renderer returns a node synchronously (charts return
// a container that fills in asynchronously once Vega loads), so callers —
// both the live tool trace and the final-answer resolver — stay synchronous.

import { placeholder } from "./dom.js";
import { renderTable } from "./table.js";
import { renderChart } from "./chart.js";

export function renderArtifact(artifact) {
  if (!artifact) return placeholder("[missing render artifact]");
  if (artifact.type === "table") return renderTable(artifact);
  if (artifact.type === "chart") return renderChart(artifact);
  return placeholder(`[unsupported render type: ${artifact.type}]`);
}
