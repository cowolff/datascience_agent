// column_stats (plan §3) — a summary of one column of a loaded tabular
// file: count/missing plus, for numeric columns, mean/std/min/max/quantiles,
// and for categorical columns, the most frequent values. Main-thread and
// comma-parsed like the fs/ tools (no worker hop). Category *labels* are real
// data, so they're scrubbed through the masking choke point (ctx.sanitize)
// before return, exactly like preview_file and printed run_python output.

import { defineTool } from "../registry.js";
import { loadedFiles } from "../shared/files.js";
import { isTabular, parseTabular, notLoaded } from "../fs/util.js";

const TOP_CATEGORIES = 5;

function quantile(sorted, q) {
  if (sorted.length === 0) return null;
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  const next = sorted[base + 1];
  return next === undefined ? sorted[base] : sorted[base] + rest * (next - sorted[base]);
}

function numericSummary(nums) {
  const sorted = [...nums].sort((a, b) => a - b);
  const n = sorted.length;
  const mean = sorted.reduce((s, x) => s + x, 0) / n;
  const variance = n > 1 ? sorted.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1) : null;
  return {
    dtype: "numeric",
    mean,
    std: variance === null ? null : Math.sqrt(variance),
    min: sorted[0],
    max: sorted[n - 1],
    q25: quantile(sorted, 0.25),
    median: quantile(sorted, 0.5),
    q75: quantile(sorted, 0.75),
  };
}

function categoricalSummary(values, sanitize) {
  const counts = new Map();
  for (const v of values) counts.set(v, (counts.get(v) || 0) + 1);
  const top = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP_CATEGORIES)
    .map(([value, count]) => ({ value: sanitize(value), count }));
  return { dtype: "categorical", unique: counts.size, top };
}

export const columnStatsTool = defineTool({
  name: "column_stats",
  handler: (args, ctx) => {
    const filename = String(args?.filename ?? "");
    const column = String(args?.column ?? "");
    const bytes = loadedFiles.get(filename);
    if (!bytes) return notLoaded(filename, loadedFiles);
    if (!isTabular(filename)) {
      return {
        ok: false,
        note:
          `column_stats parses tabular text (.csv/.tsv) client-side; ` +
          `"${filename}" isn't one of those. Use run_python ` +
          `(e.g. df["${column}"].describe()) instead.`,
      };
    }

    const { headers, rows } = parseTabular(bytes);
    const ci = headers.indexOf(column);
    if (ci < 0) {
      return { ok: false, error: `No column "${column}" in ${filename}. Columns: ${headers.join(", ")}.` };
    }

    const raw = rows.map((r) => (r[ci] == null ? "" : String(r[ci])));
    const present = raw.filter((v) => v.trim() !== "");
    const missing = raw.length - present.length;

    const nums = [];
    let allNumeric = present.length > 0;
    for (const v of present) {
      const num = Number(v);
      if (!Number.isNaN(num) && Number.isFinite(num)) nums.push(num);
      else allNumeric = false;
    }

    const summary = allNumeric
      ? numericSummary(nums)
      : categoricalSummary(present, ctx.sanitize);

    return { ok: true, filename, column, count: raw.length, missing, ...summary };
  },
  schema: {
    type: "function",
    function: {
      name: "column_stats",
      description:
        "Summarize one column of a loaded tabular file (.csv/.tsv). For a " +
        "numeric column: count, missing, mean, std, min, max, and " +
        "quartiles. For a categorical column: count, missing, number of " +
        "distinct values, and the most frequent values. Category labels are " +
        "scrubbed by masking like printed run_python output. For .xlsx or " +
        "other non-text formats, use run_python.",
      parameters: {
        type: "object",
        properties: {
          filename: { type: "string", description: "Filename as listed by get_file_tree." },
          column: { type: "string", description: "Exact column name (see describe_dataset)." },
        },
        required: ["filename", "column"],
      },
    },
  },
});
