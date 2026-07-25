// render_chart (plan §4) — the model computes an aggregate in run_python/
// run_r, then passes a Vega-Lite spec (with the aggregated rows inline under
// data.values); the browser renders it as an interactive, theme-aware SVG
// chart in the chat, and the model gets back only an opaque `chart-N` id to
// embed in its final answer. Same id-bridge as plots/tables.
//
// This module is the DOM-free half: it validates the spec, enforces the
// aggregates-only data cap, and sanitizes inline data cell values — no Vega,
// no DOM, so it's fully unit-testable. The rendering half (lazy-loading
// Vega) lives in static/js/render/chart.js.

import { defineTool } from "../registry.js";
import { registerRender } from "../shared/render-store.js";

// Decided in plan §4.2: a hard cap that enforces "aggregates only" and
// doubles as a privacy control — it structurally stops raw masked values
// from being smuggled into a spec's inline data (which the registry's text
// sanitize can't see, since a spec isn't a flat string).
const MAX_DATA_POINTS = 500;

/** Collect every inline data-row array anywhere in the spec — top-level
 * `data.values`, layered/faceted/concatenated sub-specs, and named
 * `datasets` — so the cap and sanitize apply to all of them, not just the
 * top level. */
function collectValueArrays(node, out) {
  if (Array.isArray(node)) {
    for (const child of node) collectValueArrays(child, out);
    return;
  }
  if (node && typeof node === "object") {
    if (Array.isArray(node.values)) out.push(node.values);
    for (const key of Object.keys(node)) collectValueArrays(node[key], out);
  }
}

/** Scrub forbidden literals out of inline data *values*, leaving object keys
 * (field/column names the encoding references) intact so the chart doesn't
 * break. Over-scrubbing a value is the documented-safe failure (plan §4.2).*/
function sanitizeValues(values, sanitize) {
  return values.map((row) => {
    if (row && typeof row === "object" && !Array.isArray(row)) {
      const clean = {};
      for (const [k, v] of Object.entries(row)) clean[k] = typeof v === "string" ? sanitize(v) : v;
      return clean;
    }
    return typeof row === "string" ? sanitize(row) : row;
  });
}

export const renderChartTool = defineTool({
  name: "render_chart",
  rendersOutput: true,
  handler: (args, ctx) => {
    let spec = args?.spec;
    if (typeof spec === "string") {
      try {
        spec = JSON.parse(spec);
      } catch {
        return { ok: false, error: "`spec` must be a Vega-Lite spec object (or a JSON string encoding one) — it did not parse as JSON." };
      }
    }
    if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
      return { ok: false, error: "`spec` must be a Vega-Lite spec object with inline `data.values` and an `encoding`." };
    }

    const arrays = [];
    collectValueArrays(spec, arrays);
    const total = arrays.reduce((sum, a) => sum + a.length, 0);

    if (total === 0) {
      return { ok: false, error: "Chart spec has no inline data. Put your aggregated rows in `data.values` — render_chart charts summaries you already computed, it does not read files." };
    }
    if (total > MAX_DATA_POINTS) {
      return {
        ok: false,
        error:
          `Chart spec has ${total} data points; the limit is ${MAX_DATA_POINTS}. ` +
          "Charts must plot aggregates (group means/counts/quantiles), not raw " +
          "rows. Aggregate in run_python first (e.g. groupby().mean()), then " +
          "chart the summary.",
      };
    }

    // Sanitize each inline data array in place (the arrays in `arrays` are
    // the live references inside `spec`).
    for (const arr of arrays) {
      const cleaned = sanitizeValues(arr, ctx.sanitize);
      arr.length = 0;
      arr.push(...cleaned);
    }

    const chartId = registerRender("chart", { spec });
    return { ok: true, chartId, dataPoints: total };
  },
  schema: {
    type: "function",
    function: {
      name: "render_chart",
      description: (
        "Render an interactive, theme-aware chart in the chat from a " +
        "Vega-Lite spec. Workflow: compute an aggregate in run_python/run_r " +
        "first (group means, counts, quantiles, a small scatter), then pass " +
        "a Vega-Lite spec here with those rows inline under `data.values` " +
        "and an `encoding` (this tool does not read files — it charts the " +
        "summary you already computed). Returns a `chartId` (e.g. " +
        "\"chart-2\"); embed it in your final Markdown answer with image " +
        "syntax using that id as the URL, e.g. ![CD4/CD8 by arm](chart-2) — " +
        "that's how the chart appears in your answer and the exported " +
        "report. Do NOT set colours/width/height for light-vs-dark; theming " +
        "is applied automatically. Aggregates only: at most " +
        MAX_DATA_POINTS + " inline data points (aggregate further if you " +
        "hit that). Inline values are scrubbed by masking like printed " +
        "run_python output; prefer charting non-masked/aggregated columns."
      ),
      parameters: {
        type: "object",
        properties: {
          description: {
            type: "string",
            description:
              "A short, plain-language summary of what the chart shows, " +
              "displayed in the tool trace.",
          },
          spec: {
            type: "object",
            description:
              "A Vega-Lite specification object with inline data under " +
              "`data.values` and an `encoding`. May also be passed as a JSON " +
              "string.",
          },
        },
        required: ["description", "spec"],
      },
    },
  },
});
