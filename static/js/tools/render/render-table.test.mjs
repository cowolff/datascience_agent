// Unit tests for the render_table tool (plan §4.6). Runs in plain Node —
// the tool is deliberately DOM-free (the rendering half lives in
// static/js/render/table.js), so only its data handling is exercised here:
// masking of cells, the summary-size caps, and the id/counts it returns.

import test from "node:test";
import assert from "node:assert/strict";

import { renderTableTool } from "./render-table.js";
import { renderStore } from "../shared/render-store.js";

const ctx = { sanitize: (s) => s.replaceAll("SECRET", "***") };

test("render_table sanitizes cells, stores the artifact, returns id + counts", () => {
  const res = renderTableTool.handler(
    { columns: ["arm", "note"], rows: [["A", "has SECRET"], ["B", "ok"]] },
    ctx
  );
  assert.equal(res.ok, true);
  assert.equal(res.rowCount, 2);
  assert.equal(res.columnCount, 2);

  const stored = renderStore.get(res.tableId);
  assert.equal(stored.type, "table");
  assert.deepEqual(stored.columns, ["arm", "note"]);
  assert.deepEqual(stored.rows[0], ["A", "has ***"]); // masking applied to cells
});

test("render_table is marked rendersOutput and coerces non-array rows/nulls", () => {
  assert.equal(renderTableTool.rendersOutput, true);
  const res = renderTableTool.handler({ columns: ["c"], rows: [null, "x", [42]] }, ctx);
  assert.equal(res.ok, true);
  const stored = renderStore.get(res.tableId);
  assert.deepEqual(stored.rows, [[""], ["x"], ["42"]]);
});

test("render_table rejects missing columns or rows with a helpful error", () => {
  assert.equal(renderTableTool.handler({ columns: ["a"] }, ctx).ok, false);
  assert.equal(renderTableTool.handler({ rows: [[1]] }, ctx).ok, false);
});

test("render_table rejects oversized tables and points at aggregation", () => {
  const rows = Array.from({ length: 201 }, () => ["x"]);
  const res = renderTableTool.handler({ columns: ["c"], rows }, ctx);
  assert.equal(res.ok, false);
  assert.match(res.error, /aggregate/i);
});
