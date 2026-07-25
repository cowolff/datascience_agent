// Unit tests for the tool registry (plan §7). Covers the defineTool
// contract and — the point of centralizing it — that buildRegistry wraps
// every handler with the shared masking / plot / call-log concerns, so a
// tool can't opt out of them by forgetting. Also smoke-imports the real
// tools/index.js to prove the whole layer loads and wires up in plain Node
// (no browser, no Worker, no CDN import at module load).

import test from "node:test";
import assert from "node:assert/strict";

import { defineTool, buildRegistry } from "./registry.js";

function fakeCtx(overrides = {}) {
  const calls = [];
  return {
    calls,
    sanitize: (s) => s,
    registerPlots: (r) => r,
    recordCall: (name, args) => calls.push({ name, args }),
    ...overrides,
  };
}

test("defineTool requires name, matching schema, and handler", () => {
  assert.throws(() => defineTool({}), /needs a non-empty string `name`/);
  assert.throws(
    () => defineTool({ name: "x", schema: { function: { name: "y" } }, handler: () => {} }),
    /must equal the tool name/
  );
  assert.throws(
    () => defineTool({ name: "x", schema: { function: { name: "x" } } }),
    /needs a "handler" function/
  );
  const t = defineTool({ name: "x", schema: { function: { name: "x" } }, handler: () => {} });
  assert.equal(t.rendersOutput, false); // default applied
});

test("buildRegistry collects schemas and rejects duplicate names", () => {
  const a = defineTool({ name: "a", schema: { function: { name: "a" } }, handler: () => ({}) });
  const b = defineTool({ name: "b", schema: { function: { name: "b" } }, handler: () => ({}) });
  const { schemas } = buildRegistry([a, b], fakeCtx());
  assert.deepEqual(schemas.map((s) => s.function.name), ["a", "b"]);

  assert.throws(() => buildRegistry([a, a], fakeCtx()), /duplicate tool name: a/);
});

test("callTool records the call, dispatches, and sanitizes text output", async () => {
  const ctx = fakeCtx({ sanitize: (s) => s.replaceAll("SECRET", "***") });
  const echo = defineTool({
    name: "echo",
    schema: { function: { name: "echo" } },
    handler: (args) => ({ output: `saw ${args.value}` }),
  });
  const { callTool } = buildRegistry([echo], ctx);

  const result = await callTool("echo", { value: "a SECRET thing" });
  assert.equal(result.output, "saw a *** thing"); // sanitize wrapper ran
  assert.deepEqual(ctx.calls, [{ name: "echo", args: { value: "a SECRET thing" } }]); // logged
});

test("callTool leaves non-text results untouched and runs registerPlots", async () => {
  let plotArgs = null;
  const ctx = fakeCtx({
    registerPlots: (r, code) => {
      plotArgs = { r, code };
      return { ...r, imageIds: ["plot-1"] };
    },
  });
  const plot = defineTool({
    name: "plot",
    schema: { function: { name: "plot" } },
    handler: () => ({ images: ["data:image/png;base64,AAA"] }),
  });
  const { callTool } = buildRegistry([plot], ctx);

  const result = await callTool("plot", { code: "plt.plot(...)" });
  assert.deepEqual(result.imageIds, ["plot-1"]);
  assert.equal(plotArgs.code, "plt.plot(...)"); // code threaded through to the plot bridge
});

test("callTool throws on an unknown tool but still logs the attempt", async () => {
  const ctx = fakeCtx();
  const { callTool } = buildRegistry([], ctx);
  await assert.rejects(() => callTool("nope", {}), /Unknown tool 'nope'/);
  assert.deepEqual(ctx.calls, [{ name: "nope", args: {} }]);
});

test("the real tool layer loads in Node and exposes well-formed schemas", async () => {
  const { schemas, callTool } = await import("./index.js");
  assert.equal(typeof callTool, "function");
  const names = schemas.map((s) => s.function.name).sort();
  assert.deepEqual(names, [
    "ask_choice",
    "ask_user",
    "choose_column",
    "clarify_term",
    "column_stats",
    "confirm",
    "confirm_exclusion",
    "describe_dataset",
    "get_file_tree",
    "list_variables",
    "preview_file",
    "render_chart",
    "render_table",
    "run_python",
    "run_r",
  ]);
  for (const s of schemas) {
    assert.equal(s.type, "function");
    assert.equal(typeof s.function.description, "string");
    assert.equal(s.function.parameters.type, "object");
    assert.ok(Array.isArray(s.function.parameters.required));
  }
});
