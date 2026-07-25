// Unit tests for the filesystem/navigation tools (plan §3). They run in
// plain Node — the tools are main-thread and DOM-free — against a
// hand-populated loadedFiles map and dataset-meta store.

import test from "node:test";
import assert from "node:assert/strict";

import { loadedFiles } from "../shared/files.js";
import { recordDatasetShape } from "../../dataset-meta.js";
import { getFileTreeTool } from "./list-files.js";
import { describeDatasetTool } from "./describe-dataset.js";
import { previewFileTool } from "./preview-file.js";

const ctx = { sanitize: (s) => s.replaceAll("SECRET", "***") };

function loadCsv(name, text) {
  loadedFiles.set(name, new TextEncoder().encode(text).buffer);
}

const CSV = "id,age,note\n1,30,ok\n2,,has SECRET\n3,45,fine\n";

test.beforeEach(() => loadedFiles.clear());

test("get_file_tree lists loaded files with ext, size, and recorded shape", () => {
  loadCsv("data.csv", CSV);
  recordDatasetShape("data.csv", { rows: 3, cols: 3, sizeBytes: CSV.length });
  loadedFiles.set("book.xlsx", new ArrayBuffer(1234));

  const res = getFileTreeTool.handler({}, ctx);
  assert.equal(res.ok, true);
  assert.equal(res.fileCount, 2);

  const csv = res.files.find((f) => f.name === "data.csv");
  assert.deepEqual({ ext: csv.ext, rows: csv.rows, cols: csv.cols }, { ext: ".csv", rows: 3, cols: 3 });
  const xlsx = res.files.find((f) => f.name === "book.xlsx");
  assert.deepEqual({ ext: xlsx.ext, sizeBytes: xlsx.sizeBytes, rows: xlsx.rows }, { ext: ".xlsx", sizeBytes: 1234, rows: null });
});

test("describe_dataset infers dtypes + null counts, returns no cell values", () => {
  loadCsv("data.csv", CSV);
  const res = describeDatasetTool.handler({ filename: "data.csv" }, ctx);
  assert.equal(res.ok, true);
  assert.deepEqual({ rows: res.rows, cols: res.cols }, { rows: 3, cols: 3 });
  assert.deepEqual(res.columns.map((c) => c.dtype), ["numeric", "numeric", "string"]);
  assert.equal(res.columns[1].nulls, 1); // the empty age cell
  // Structure only — no raw values in the payload.
  assert.ok(!JSON.stringify(res).includes("SECRET"));
});

test("describe_dataset points non-tabular files at run_python", () => {
  loadedFiles.set("book.xlsx", new ArrayBuffer(8));
  const res = describeDatasetTool.handler({ filename: "book.xlsx" }, ctx);
  assert.equal(res.ok, false);
  assert.match(res.note, /run_python/);
});

test("preview_file returns first N rows with cell values sanitized", () => {
  loadCsv("data.csv", CSV);
  const res = previewFileTool.handler({ filename: "data.csv", n: 2 }, ctx);
  assert.equal(res.ok, true);
  assert.deepEqual(res.columns, ["id", "age", "note"]);
  assert.equal(res.rows.length, 2);
  assert.equal(res.rows[1][2], "has ***"); // masking applied to the cell
  assert.equal(res.totalRows, 3);
});

test("preview_file clamps n and previews plain text by lines", () => {
  loadCsv("data.csv", CSV);
  assert.equal(previewFileTool.handler({ filename: "data.csv", n: 999 }, ctx).rows.length, 3);

  loadedFiles.set("notes.txt", new TextEncoder().encode("line1\nSECRET line2\nline3").buffer);
  const txt = previewFileTool.handler({ filename: "notes.txt", n: 2 }, ctx);
  assert.equal(txt.text, "line1\n*** line2");
  assert.equal(txt.totalLines, 3);
});

test("nav tools report a helpful error for an unknown filename", () => {
  loadCsv("data.csv", CSV);
  const res = describeDatasetTool.handler({ filename: "nope.csv" }, ctx);
  assert.equal(res.ok, false);
  assert.match(res.error, /data\.csv/); // lists what's actually loaded
});
