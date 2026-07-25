// Unit tests for column_stats (plan §3). Main-thread and DOM-free, so it
// runs in plain Node against a hand-populated loadedFiles map. (list_variables
// isn't unit-tested end-to-end — its handler drives the Pyodide worker / webR,
// which need a browser; its schema is covered by the registry test.)

import test from "node:test";
import assert from "node:assert/strict";

import { loadedFiles } from "../shared/files.js";
import { columnStatsTool } from "./column-stats.js";

const ctx = { sanitize: (s) => s.replaceAll("SECRET", "***") };

function loadCsv(name, text) {
  loadedFiles.set(name, new TextEncoder().encode(text).buffer);
}

test.beforeEach(() => loadedFiles.clear());

test("numeric column reports mean/std/min/max/quartiles and missing", () => {
  // A blank x in a row that still has a y value, so it isn't dropped as a
  // fully-empty trailing row by the CSV parser — that's the missing cell.
  loadCsv("d.csv", "x,y\n1,a\n2,b\n3,c\n4,d\n,e\n");
  const res = columnStatsTool.handler({ filename: "d.csv", column: "x" }, ctx);
  assert.equal(res.ok, true);
  assert.equal(res.dtype, "numeric");
  assert.equal(res.missing, 1);
  assert.equal(res.mean, 2.5);
  assert.equal(res.min, 1);
  assert.equal(res.max, 4);
  assert.equal(res.median, 2.5);
});

test("categorical column reports unique + top values, sanitized", () => {
  loadCsv("d.csv", "g\nA\nB\nA\nSECRET\nA\nB\n");
  const res = columnStatsTool.handler({ filename: "d.csv", column: "g" }, ctx);
  assert.equal(res.dtype, "categorical");
  assert.equal(res.unique, 3);
  assert.deepEqual(res.top[0], { value: "A", count: 3 }); // most frequent first
  assert.ok(res.top.some((t) => t.value === "***")); // forbidden literal scrubbed
});

test("unknown column lists the real columns; non-tabular points at run_python", () => {
  loadCsv("d.csv", "x\n1\n");
  const bad = columnStatsTool.handler({ filename: "d.csv", column: "nope" }, ctx);
  assert.equal(bad.ok, false);
  assert.match(bad.error, /Columns: x/);

  loadedFiles.set("b.xlsx", new ArrayBuffer(4));
  const xlsx = columnStatsTool.handler({ filename: "b.xlsx", column: "x" }, ctx);
  assert.equal(xlsx.ok, false);
  assert.match(xlsx.note, /run_python/);
});
