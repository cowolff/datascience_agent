// Shared helpers for the filesystem/navigation tools (plan §3). These run
// entirely on the main thread against the session's already-loaded file
// bytes (tools/shared/files.js) — no worker round-trip — and reuse the
// existing CSV parser (csv.js). Tabular parsing is comma-based (csv.js),
// so it's most accurate for .csv; .tsv is parsed the same way the masking
// preview already does (a documented pre-existing limitation, not new here).

import { parseCSV } from "../../csv.js";

export const TABULAR_EXTS = [".csv", ".tsv"];
export const TEXT_EXTS = [".csv", ".tsv", ".json", ".txt", ".md"];

export function extOf(name) {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i).toLowerCase() : "";
}

export const isTabular = (name) => TABULAR_EXTS.includes(extOf(name));
export const isText = (name) => TEXT_EXTS.includes(extOf(name));

export function decodeText(bytes) {
  return new TextDecoder().decode(bytes);
}

/** @returns {{headers: string[], rows: string[][]}} */
export function parseTabular(bytes) {
  return parseCSV(decodeText(bytes));
}

export function clampInt(value, lo, hi, fallback) {
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.max(lo, Math.min(hi, n));
}

/** Cheap dtype/null summary for one parsed column. "numeric" only when every
 * non-empty value parses as a finite number; everything else is "string".
 * Empty cells count as nulls. */
export function summarizeColumn(name, values) {
  let nulls = 0;
  let nonNull = 0;
  let numeric = 0;
  for (const raw of values) {
    const v = raw == null ? "" : String(raw);
    if (v.trim() === "") {
      nulls++;
      continue;
    }
    nonNull++;
    const num = Number(v);
    if (!Number.isNaN(num) && Number.isFinite(num)) numeric++;
  }
  const dtype = nonNull > 0 && numeric === nonNull ? "numeric" : "string";
  return { name, dtype, nulls };
}

/** Standard "no such loaded file" error, listing what *is* available so the
 * model can correct itself rather than guess again. */
export function notLoaded(filename, loadedFiles) {
  const available = [...loadedFiles.keys()];
  return {
    ok: false,
    error:
      `No loaded file named "${filename}". ` +
      (available.length
        ? `Loaded files: ${available.join(", ")}.`
        : "No datasets are loaded yet — upload or load one first."),
  };
}
