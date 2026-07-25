// describe_dataset (plan §3) — a compact schema for one tabular file:
// row/column counts plus, per column, an inferred dtype and null count. No
// cell values are returned (only structure + counts), so there's nothing to
// sanitize here — and column names reaching the model is the same exposure
// as the model running df.info() itself, which it would otherwise do.
// Main-thread, comma-parsed (csv.js); .xlsx and other binary formats are
// pointed back at run_python.

import { defineTool } from "../registry.js";
import { loadedFiles } from "../shared/files.js";
import { isTabular, parseTabular, summarizeColumn, notLoaded } from "./util.js";

export const describeDatasetTool = defineTool({
  name: "describe_dataset",
  handler: (args) => {
    const filename = String(args?.filename ?? "");
    const bytes = loadedFiles.get(filename);
    if (!bytes) return notLoaded(filename, loadedFiles);
    if (!isTabular(filename)) {
      return {
        ok: false,
        note:
          `describe_dataset parses tabular text (.csv/.tsv) client-side; ` +
          `"${filename}" isn't one of those. Read it with run_python ` +
          `instead (e.g. pd.read_excel("/data/${filename}").info()).`,
      };
    }
    const { headers, rows } = parseTabular(bytes);
    const columns = headers.map((h, ci) => summarizeColumn(h, rows.map((r) => r[ci])));
    return { ok: true, filename, rows: rows.length, cols: headers.length, columns };
  },
  schema: {
    type: "function",
    function: {
      name: "describe_dataset",
      description:
        "Return the schema of a loaded tabular file (.csv/.tsv): its row and " +
        "column counts, and for each column an inferred dtype (numeric or " +
        "string) and how many values are missing. No cell values are " +
        "returned. Use it to orient before analysis instead of a " +
        "run_python df.info()/df.dtypes turn. For .xlsx or other non-text " +
        "formats, use run_python.",
      parameters: {
        type: "object",
        properties: {
          filename: {
            type: "string",
            description: "Filename as listed by get_file_tree (e.g. \"data.csv\").",
          },
        },
        required: ["filename"],
      },
    },
  },
});
