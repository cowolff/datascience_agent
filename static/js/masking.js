// The data-governance layer (plan §3.3) — mask spec persistence, and the
// sanitize() choke point every tool result must pass through before it can
// reach the model. This file is small and heavily tested on purpose (see
// masking.test.mjs, run with `node --test static/js/`): it is the entire
// privacy guarantee for what a tool result exposes.

// Exported so every list of "datasets" (workbench sidebar, datasets page,
// anywhere else) filters sidecar files out the same way — this was a real
// bug during Phase 5 testing: the sidecar itself showed up as a loadable
// "dataset" and its own Load button pushed the JSON spec into Python
// instead of the actual file.
export const SIDECAR_SUFFIX = ".maskspec.json";

export function emptySpec() {
  return { hiddenColumns: [], hiddenRows: [], hiddenCells: [] }; // hiddenCells: [[rowIdx, colIdx], ...]
}

export async function loadMaskSpec(filename) {
  try {
    const root = await navigator.storage.getDirectory();
    const handle = await root.getFileHandle(filename + SIDECAR_SUFFIX);
    const file = await handle.getFile();
    const spec = JSON.parse(await file.text());
    return { ...emptySpec(), ...spec };
  } catch {
    return emptySpec();
  }
}

export async function saveMaskSpec(filename, spec) {
  const root = await navigator.storage.getDirectory();
  const handle = await root.getFileHandle(filename + SIDECAR_SUFFIX, { create: true });
  const writable = await handle.createWritable();
  await writable.write(JSON.stringify(spec));
  await writable.close();
}

/**
 * Every literal cell value that must never reach the model. Column-level,
 * row-level, and cell-level masking all collapse to the same underlying
 * fact — a hidden (rowIndex, colIndex) coordinate — so this is the one
 * place that fans out from the spec to actual forbidden values.
 */
export function computeForbiddenValues(headers, rows, spec) {
  const hiddenCols = new Set(spec.hiddenColumns || []);
  const hiddenRows = new Set(spec.hiddenRows || []);
  const hiddenCellKeys = new Set((spec.hiddenCells || []).map(([r, c]) => `${r}:${c}`));
  const forbidden = new Set();

  rows.forEach((row, rowIdx) => {
    row.forEach((value, colIdx) => {
      const header = headers[colIdx];
      const isHidden =
        hiddenCols.has(header) || hiddenRows.has(rowIdx) || hiddenCellKeys.has(`${rowIdx}:${colIdx}`);
      if (isHidden && value !== "" && value != null) {
        forbidden.add(String(value));
      }
    });
  });

  // A hidden column's name is itself identifying metadata (e.g.
  // `print(df.columns)` would otherwise reveal it even with values scrubbed).
  for (const header of hiddenCols) {
    if (header) forbidden.add(String(header));
  }
  return forbidden;
}

const REDACTED = "[masked]";

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The sanitize() choke point (plan §3.3/§5). Naive value-based scrubbing:
 * replace every literal occurrence of a forbidden value with `[masked]`.
 *
 * KNOWN LIMITATION, documented on purpose rather than silently accepted
 * (plan §3.3): this only catches values that appear *literally* in the
 * text. A statistic *derived* from masked data (a mean, a sum, a
 * correlation) does not literally contain the masked value and will NOT
 * be caught — see the "derived statistic" test in masking.test.mjs, which
 * demonstrates the gap rather than hiding it. Structured tool results
 * (plan §3.3's stated long-term preference) are the real fix for that;
 * this is the pragmatic mitigation for today's freeform-stdout tool
 * results.
 *
 * Numeric forbidden values use a digit-boundary match (so masking "1"
 * doesn't redact "100" or "12") — plain values use substring match, since
 * word-boundary semantics don't clearly apply to arbitrary text. Longer
 * values are applied first to avoid a short forbidden value pre-empting
 * part of a longer one that also needs redacting.
 */
export function sanitizeText(text, forbiddenValues) {
  const values = [...forbiddenValues].filter((v) => v.length > 0).sort((a, b) => b.length - a.length);
  let out = text;
  for (const value of values) {
    const isNumeric = /^-?\d+(\.\d+)?$/.test(value);
    const escaped = escapeRegExp(value);
    const pattern = isNumeric ? `(?<!\\d)${escaped}(?!\\d)` : escaped;
    out = out.replace(new RegExp(pattern, "g"), REDACTED);
  }
  return out;
}
