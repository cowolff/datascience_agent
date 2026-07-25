// Store for client-rendered display artifacts — tables now, charts later
// (plans/tool-expansion-and-visualization.md §4). Same idea as
// plot-store.js: the heavy display payload never goes to the model. A
// render tool stashes its (already-sanitized) data here and hands the model
// only an opaque id (`table-N`, `chart-N`); workbench.js resolves that id
// back to a rendered DOM node — client-side, never round-tripped through
// the model — both in the live tool trace and in the final Markdown answer.
//
// Note the data->view split: this holds *data* (columns/rows, or a chart
// spec), not DOM. The browser-only rendering half lives under
// static/js/render/, which is why the render *tools* stay DOM-free and
// unit-testable in plain Node.

export const renderStore = new Map(); // id -> { type, ...payload }
const counters = new Map();

/** Store a payload under a fresh `${type}-N` id and return that id. */
export function registerRender(type, payload) {
  const n = (counters.get(type) || 0) + 1;
  counters.set(type, n);
  const id = `${type}-${n}`;
  renderStore.set(id, { type, ...payload });
  return id;
}

/** For chat-store.js: snapshot both the entries and the per-type counters,
 * so a restored session keeps assigning fresh ids (`table-4`, not a
 * colliding `table-1`) instead of resetting to 1 on every reload. */
export function snapshotRenderStore() {
  return { entries: [...renderStore.entries()], counters: [...counters.entries()] };
}

export function restoreRenderStore(snapshot) {
  if (!snapshot) return;
  renderStore.clear();
  for (const [id, payload] of snapshot.entries || []) renderStore.set(id, payload);
  counters.clear();
  for (const [type, n] of snapshot.counters || []) counters.set(type, n);
}
