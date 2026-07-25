// Unit tests for the render_chart tool (plan §4). DOM-free, so only its data
// handling is exercised here — JSON parsing, the aggregates-only cap, inline
// value sanitizing, and the id it returns. The Vega rendering half
// (render/chart.js) is browser/CDN-only and not covered by the Node suite.

import test from "node:test";
import assert from "node:assert/strict";

import { renderChartTool } from "./render-chart.js";
import { renderStore } from "../shared/render-store.js";

const ctx = { sanitize: (s) => s.replaceAll("SECRET", "***") };

function spec(values) {
  return { mark: "bar", data: { values }, encoding: { x: { field: "arm" }, y: { field: "n" } } };
}

test("render_chart stores a valid spec and returns a chartId + point count", () => {
  const res = renderChartTool.handler(
    { spec: spec([{ arm: "A", n: 3 }, { arm: "B", n: 5 }]) },
    ctx
  );
  assert.equal(res.ok, true);
  assert.equal(res.dataPoints, 2);
  assert.equal(renderStore.get(res.chartId).type, "chart");
});

test("render_chart accepts a spec passed as a JSON string", () => {
  const res = renderChartTool.handler({ spec: JSON.stringify(spec([{ arm: "A", n: 1 }])) }, ctx);
  assert.equal(res.ok, true);
  assert.equal(res.dataPoints, 1);
});

test("render_chart sanitizes inline data values but not field keys", () => {
  const res = renderChartTool.handler({ spec: spec([{ arm: "SECRET", n: 9 }]) }, ctx);
  assert.equal(res.ok, true);
  const stored = renderStore.get(res.chartId).spec;
  assert.equal(stored.data.values[0].arm, "***"); // value scrubbed
  assert.ok("arm" in stored.data.values[0]); // key (field ref) intact
});

test("render_chart enforces the 500-point aggregates-only cap", () => {
  const values = Array.from({ length: 501 }, (_, i) => ({ arm: `x${i}`, n: i }));
  const res = renderChartTool.handler({ spec: spec(values) }, ctx);
  assert.equal(res.ok, false);
  assert.match(res.error, /aggregate/i);
  assert.match(res.error, /501/);
});

test("render_chart counts inline data across layered sub-specs", () => {
  const layered = { layer: [{ data: { values: [{ a: 1 }, { a: 2 }] } }, { data: { values: [{ a: 3 }] } }] };
  const res = renderChartTool.handler({ spec: layered }, ctx);
  assert.equal(res.dataPoints, 3);
});

test("render_chart rejects a spec with no inline data or an unparseable one", () => {
  assert.equal(renderChartTool.handler({ spec: { mark: "bar" } }, ctx).ok, false);
  assert.equal(renderChartTool.handler({ spec: "{not json" }, ctx).ok, false);
});

test("render_chart is marked rendersOutput", () => {
  assert.equal(renderChartTool.rendersOutput, true);
});
