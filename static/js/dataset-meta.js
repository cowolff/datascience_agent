// Coarse dataset-shape metadata (plan §3.7) — the *only* facts about a
// user's data this app is willing to let reach the backend at all, and
// only as small explicit numeric/enum fields computed here, never derived
// by the backend from content it doesn't have (it never has any). Kept
// in memory only (a plain Map, not OPFS/localStorage) — this doesn't need
// to survive a reload, and not persisting it is one less place a shape
// history could accumulate.
//
// Deliberately excluded, per plan §3.7's explicit non-goals: filenames,
// column names, cell values, and exact byte size (bucketed instead, so it
// can't work as a near-fingerprint of a specific known file). Row/column
// *counts* are sent as exact small integers — on their own they don't
// identify content the way a byte-exact size or a column name could.

const SIZE_BUCKETS = [
  [10_000, "<10KB"],
  [100_000, "10KB-100KB"],
  [1_000_000, "100KB-1MB"],
  [10_000_000, "1MB-10MB"],
];
const SIZE_BUCKET_OVERFLOW = ">10MB";

export function sizeBucket(bytes) {
  for (const [limit, label] of SIZE_BUCKETS) {
    if (bytes < limit) return label;
  }
  return SIZE_BUCKET_OVERFLOW;
}

// Keyed by filename purely for in-browser bookkeeping (so reloading the
// same file updates its entry instead of duplicating it) — the filename
// itself is never part of what getDatasetMeta() returns.
const shapes = new Map();

/** Records one loaded dataset's shape. `rows`/`cols` are omitted (left
 * null) for file types this app can't parse client-side yet (e.g. xlsx) —
 * the file is still usable from Python/R, it just has no shape to report. */
export function recordDatasetShape(filename, { rows = null, cols = null, sizeBytes }) {
  shapes.set(filename, { rows, cols, sizeBucket: sizeBucket(sizeBytes) });
}

export function getDatasetMeta() {
  return { fileCount: shapes.size, files: [...shapes.values()] };
}

/** Client-side only — the recorded shape for one filename, or null. Unlike
 * getDatasetMeta() (which deliberately strips filenames because it feeds the
 * backend usage log, §3.7), this keys by filename for in-browser consumers
 * like the get_file_tree tool, whose result never leaves the browser except
 * as sanitized text folded into a model call (same exposure as the model
 * running os.listdir itself). */
export function getDatasetShape(filename) {
  return shapes.get(filename) || null;
}
