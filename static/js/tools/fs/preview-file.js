// preview_file (plan §3) — the first few rows (tabular) or lines (plain
// text) of a loaded file, so the model can see the actual data layout
// before writing code. Unlike describe_dataset this returns real cell
// values, so every value is scrubbed through the masking choke point
// (ctx.sanitize) before it's returned — exactly like run_python stdout is.
// Main-thread, text-only (matches the masking UI's own preview limitation);
// binary formats are pointed at run_python.

import { defineTool } from "../registry.js";
import { loadedFiles } from "../shared/files.js";
import { isTabular, isText, parseTabular, decodeText, clampInt, notLoaded } from "./util.js";

const DEFAULT_ROWS = 10;
const MAX_ROWS = 50;

export const previewFileTool = defineTool({
  name: "preview_file",
  handler: (args, ctx) => {
    const filename = String(args?.filename ?? "");
    const n = clampInt(args?.n, 1, MAX_ROWS, DEFAULT_ROWS);
    const bytes = loadedFiles.get(filename);
    if (!bytes) return notLoaded(filename, loadedFiles);

    if (isTabular(filename)) {
      const { headers, rows } = parseTabular(bytes);
      const preview = rows
        .slice(0, n)
        .map((r) => r.map((c) => ctx.sanitize(String(c ?? ""))));
      return { ok: true, filename, columns: headers, rows: preview, totalRows: rows.length };
    }
    if (isText(filename)) {
      const lines = decodeText(bytes).split("\n");
      return {
        ok: true,
        filename,
        text: ctx.sanitize(lines.slice(0, n).join("\n")),
        totalLines: lines.length,
      };
    }
    return {
      ok: false,
      note:
        `"${filename}" isn't a client-side-previewable text file. Read it ` +
        `with run_python instead (e.g. pd.read_excel or open()).`,
    };
  },
  schema: {
    type: "function",
    function: {
      name: "preview_file",
      description:
        "Show the first N rows (tabular .csv/.tsv) or lines (.txt/.json/.md) " +
        "of a loaded file, so you can see the real column layout and value " +
        "formats before writing code. Cell values are scrubbed by masking " +
        "the same way printed run_python output is. For .xlsx or other " +
        "binary formats, use run_python. Defaults to 10 rows/lines (max 50).",
      parameters: {
        type: "object",
        properties: {
          filename: {
            type: "string",
            description: "Filename as listed by get_file_tree.",
          },
          n: {
            type: "integer",
            description: "How many rows/lines to show (1–50, default 10).",
          },
        },
        required: ["filename"],
      },
    },
  },
});
