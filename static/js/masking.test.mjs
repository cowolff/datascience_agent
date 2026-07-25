// Run with: node --test static/js/
//
// These are the tests the plan (§5, §7 Phase 5) means by "tests proving
// masked cells never leave the client" — the sanitize() choke point is the
// entire privacy guarantee, so it gets tested harder than anything else in
// this codebase, including a test that documents its known limitation
// rather than pretending it doesn't exist.

import { test } from "node:test";
import assert from "node:assert/strict";
import { computeForbiddenValues, sanitizeText } from "./masking.js";

test("computeForbiddenValues collects a hidden column's values and its header name", () => {
  const headers = ["name", "age"];
  const rows = [
    ["Alice", "30"],
    ["Bob", "40"],
  ];
  const spec = { hiddenColumns: ["name"], hiddenRows: [], hiddenCells: [] };
  const forbidden = computeForbiddenValues(headers, rows, spec);
  assert.ok(forbidden.has("Alice"));
  assert.ok(forbidden.has("Bob"));
  assert.ok(forbidden.has("name"));
  assert.ok(!forbidden.has("30"));
  assert.ok(!forbidden.has("40"));
});

test("computeForbiddenValues collects only a hidden row's values", () => {
  const headers = ["name", "age"];
  const rows = [
    ["Alice", "30"],
    ["Bob", "40"],
  ];
  const spec = { hiddenColumns: [], hiddenRows: [1], hiddenCells: [] };
  const forbidden = computeForbiddenValues(headers, rows, spec);
  assert.ok(forbidden.has("Bob"));
  assert.ok(forbidden.has("40"));
  assert.ok(!forbidden.has("Alice"));
  assert.ok(!forbidden.has("30"));
});

test("computeForbiddenValues collects a single hidden cell without touching its row/column", () => {
  const headers = ["name", "age"];
  const rows = [
    ["Alice", "30"],
    ["Bob", "40"],
  ];
  const spec = { hiddenColumns: [], hiddenRows: [], hiddenCells: [[0, 1]] };
  const forbidden = computeForbiddenValues(headers, rows, spec);
  assert.ok(forbidden.has("30"));
  assert.ok(!forbidden.has("Alice"));
  assert.ok(!forbidden.has("Bob"));
  assert.ok(!forbidden.has("40"));
});

test("sanitizeText redacts every literal occurrence of a masked value", () => {
  const forbidden = new Set(["Alice", "30"]);
  const text = "name age\nAlice 30\nsummary: Alice averaged 30 across the year";
  const out = sanitizeText(text, forbidden);
  assert.ok(!out.includes("Alice"));
  assert.ok(!/\b30\b/.test(out));
  assert.match(out, /\[masked\]/);
});

test("sanitizeText does not over-redact a number that merely contains a masked number as a substring", () => {
  const forbidden = new Set(["1"]);
  const text = "the count was 100 and then 12 and then exactly 1";
  const out = sanitizeText(text, forbidden);
  assert.ok(out.includes("100"), "100 must survive — it is not the value 1");
  assert.ok(out.includes("12"), "12 must survive — it is not the value 1");
  assert.ok(!/\b1\b/.test(out), "the standalone value 1 must be redacted");
});

test("sanitizeText is a no-op with an empty forbidden set", () => {
  const text = "nothing to hide here";
  assert.equal(sanitizeText(text, new Set()), text);
});

test("sanitizeText handles overlapping-length values without corrupting the longer one", () => {
  const forbidden = new Set(["12", "123"]);
  const out = sanitizeText("values: 123 and 12", forbidden);
  assert.equal(out, "values: [masked] and [masked]");
});

test("KNOWN LIMITATION: a statistic derived from masked values is not caught", () => {
  // This documents the gap called out in masking.js's own docstring — the
  // assertion shows the leak on purpose, so a future structured-results
  // fix (plan §3.3) is a deliberate, visible change to this test, not a
  // silent regression no one notices either way.
  const forbidden = new Set(["30", "40"]);
  const text = `mean age: ${(30 + 40) / 2}`; // "35" — derived, not literal
  const out = sanitizeText(text, forbidden);
  assert.ok(out.includes("35"), "derived stats are NOT masked today — a known, accepted gap");
});
