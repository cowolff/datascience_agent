// render_table (plan §4.6) — the first client-render tool. The model, after
// computing a *summary* in run_python/run_r, calls this with the summarized
// columns + rows; the browser renders a sortable, scrollable, theme-aware
// table inline (nicer than a Markdown table for anything wide or long), and
// the model gets back only an opaque `table-N` id to embed in its final
// answer. Reuses the plot-N pattern exactly (see shared/render-store.js).
//
// DOM-free on purpose: the actual rendering lives in static/js/render/
// table.js (the browser half), so this stays unit-testable in plain Node.
// No eval mirror in agent/tools.py — the standalone harness can't render
// HTML, and no eval case exercises it (plan §2.3).

import { defineTool } from "../registry.js";
import { registerRender } from "../shared/render-store.js";

// Display artifact, not a data channel — keep it to summaries. A caller
// hitting either limit is dumping raw rows and should aggregate/.head()
// first (the error message says so), same philosophy as the chart-data cap
// in plan §4.2.
const MAX_ROWS = 200;
const MAX_CELLS = 2000;

function cellText(value, sanitize) {
  if (value === null || value === undefined) return "";
  // Masking choke point (plan §3.3): the registry's sanitize wrapper only
  // touches a result's `output` string, and this tool returns none — so
  // scrub each cell here, via the same ctx.sanitize, before it's stored and
  // rendered. Belt-and-suspenders: model-authored cells shouldn't contain
  // forbidden literals, but a display artifact still passes through masking.
  return sanitize(String(value));
}

export const renderTableTool = defineTool({
  name: "render_table",
  rendersOutput: true,
  handler: (args, ctx) => {
    const columns = Array.isArray(args?.columns) ? args.columns : null;
    const rows = Array.isArray(args?.rows) ? args.rows : null;
    if (!columns || !rows) {
      return {
        ok: false,
        error:
          "render_table needs `columns` (array of header strings) and " +
          "`rows` (array of arrays, one inner array per row in column order).",
      };
    }
    if (rows.length > MAX_ROWS || rows.length * columns.length > MAX_CELLS) {
      return {
        ok: false,
        error:
          `Table too large (${rows.length} rows × ${columns.length} cols). ` +
          "render_table is for compact, already-summarized results — " +
          "aggregate (groupby/crosstab) or .head() in run_python first, then " +
          `render the summary. Limits: ${MAX_ROWS} rows, ${MAX_CELLS} cells.`,
      };
    }

    const cleanColumns = columns.map((c) => cellText(c, ctx.sanitize));
    const cleanRows = rows.map((r) =>
      (Array.isArray(r) ? r : [r]).map((c) => cellText(c, ctx.sanitize))
    );
    const tableId = registerRender("table", { columns: cleanColumns, rows: cleanRows });
    return { ok: true, tableId, rowCount: cleanRows.length, columnCount: cleanColumns.length };
  },
  schema: {
    type: "function",
    function: {
      name: "render_table",
      description: (
        "Render a compact, already-summarized table as an interactive " +
        "(sortable, scrollable) element in the chat — nicer than a Markdown " +
        "table for anything wider or longer than a few rows. Compute the " +
        "summary in run_python/run_r first (e.g. groupby().mean(), a " +
        "crosstab, or df.head()), then pass it here as `columns` (header " +
        "labels) and `rows` (one array of cell values per row, in the same " +
        "order as columns). Returns a `tableId` (e.g. \"table-2\"); embed it " +
        "in your final Markdown answer with image syntax using that id as " +
        "the URL, e.g. ![Median CD4 by arm](table-2) — that's how the table " +
        "is shown in your answer and included in the exported report, not " +
        "just described in prose. This is for summaries, not raw dumps: at " +
        `most ${MAX_ROWS} rows / ${MAX_CELLS} cells (aggregate first if ` +
        "larger). Cell values are scrubbed by masking the same way printed " +
        "run_python output is."
      ),
      parameters: {
        type: "object",
        properties: {
          description: {
            type: "string",
            description:
              "A short, plain-language summary of what the table shows " +
              "(e.g. \"Median CD4/CD8 ratio by treatment arm\"). Shown in " +
              "the tool trace.",
          },
          columns: {
            type: "array",
            items: { type: "string" },
            description: "Column header labels, in order.",
          },
          rows: {
            type: "array",
            items: { type: "array" },
            description:
              "Rows, each an array of cell values in the same order as " +
              "`columns`.",
          },
        },
        required: ["description", "columns", "rows"],
      },
    },
  },
});
