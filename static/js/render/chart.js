// The browser (DOM) half of render_chart — renders a stored Vega-Lite spec
// (tools/shared/render-store.js: { spec }) into a node for the chat.
//
// Vega-embed is lazy-loaded from a pinned CDN the first time a chart is
// actually drawn — the same runtime-CDN pattern as marked/DOMPurify
// (workbench.js) and webR (r-runtime.js), and it joins that same single
// pre-deploy "vendor the assets" TODO (plan §3.1/§4.4) rather than being
// vendored in isolation while everything else still CDN-loads. Rendered as
// SVG so the PDF/ZIP export (report-export.js rasterizes the bubble DOM)
// captures the chart with no separate static-image step for that path.
//
// Version pinned for reproducibility, same as every other CDN dep here.
// NOTE: the actual render path can't be exercised by the Node test suite
// (no browser, no network) — the render_chart *tool* is unit-tested for
// spec validation/cap/sanitize; this view half is verified in-browser.

import { el } from "./dom.js";

const VEGA_EMBED_VERSION = "6.29.0";
const VEGA_EMBED_URL = `https://cdn.jsdelivr.net/npm/vega-embed@${VEGA_EMBED_VERSION}/+esm`;

let embedPromise = null;
function loadVegaEmbed() {
  if (!embedPromise) embedPromise = import(VEGA_EMBED_URL).then((m) => m.default || m);
  return embedPromise;
}

function isDark() {
  return document.documentElement.classList.contains("dark");
}

// Minimal light/dark theming applied on top of whatever the model sent, so
// axes/labels stay legible in both themes without the model having to know
// which one is active. Transparent background so the chart sits on the chat
// bubble. (Palette/marks should follow the dataviz skill when this is
// fleshed out — plan §4.3.)
function themeConfig(dark) {
  const fg = dark ? "#cbd5e1" : "#334155"; // slate-300 / slate-700
  const grid = dark ? "#334155" : "#e2e8f0";
  return {
    background: "transparent",
    axis: { labelColor: fg, titleColor: fg, gridColor: grid, domainColor: grid, tickColor: grid },
    legend: { labelColor: fg, titleColor: fg },
    title: { color: fg },
    view: { stroke: "transparent" },
  };
}

// Composite spec types (facet/concat/repeat/layer) size their sub-views
// individually — a top-level width/autosize doesn't apply the way it does
// for a single-view spec, so leave those alone and let Vega-Lite's own
// defaults handle them.
const COMPOSITE_KEYS = ["facet", "hconcat", "vconcat", "concat", "repeat", "layer"];

function mergeConfig(spec, dark) {
  const theme = themeConfig(dark);
  const isComposite = COMPOSITE_KEYS.some((k) => k in spec);
  return {
    ...spec,
    // The model is told not to set width/height (tool description), so a
    // single-view spec defaults to Vega-Lite's ~200px intrinsic size —
    // dwarfed by the chat bubble and left-aligned inside it. Stretch to the
    // container instead unless the model *did* set an explicit size.
    ...(isComposite
      ? {}
      : {
          width: spec.width ?? "container",
          height: spec.height ?? 300,
          autosize: spec.autosize ?? { type: "fit-x", contains: "padding" },
        }),
    background: "transparent",
    // Model-supplied config wins over the theme defaults where they overlap,
    // but the theme fills in anything the model left unset.
    config: { ...theme, ...(spec.config || {}) },
  };
}

export function renderChart({ spec }) {
  const container = el(
    "div",
    "not-prose my-2 overflow-auto rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 p-2"
  );
  const status = el("div", "text-xs text-slate-400 dark:text-slate-500 px-1 py-2", "Rendering chart…");
  container.appendChild(status);

  (async () => {
    try {
      const vegaEmbed = await loadVegaEmbed();
      const target = el("div", "");
      const result = await vegaEmbed(target, mergeConfig(spec, isDark()), {
        renderer: "svg",
        actions: false,
      });
      status.remove();
      container.appendChild(target);
      // Best-effort: free Vega's runtime once the static SVG is in the DOM.
      if (result && typeof result.finalize === "function") {
        // Keep the view around only if it's needed; the SVG is standalone.
        result.finalize();
      }
    } catch (err) {
      status.textContent = `Chart failed to render: ${err?.message || err}`;
      status.className = "text-xs text-rose-500 dark:text-rose-400 px-1 py-2";
    }
  })();

  return container;
}
