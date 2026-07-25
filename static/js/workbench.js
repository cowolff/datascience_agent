// Page glue for templates/workbench.html — renders chat + tool trace,
// handles file upload/OPFS listing, and wires the composer to the agent
// loop. Deliberately thin: all the actual logic lives in agent-loop.js/
// provider.js/tools.js/datasets.js so this file stays swappable/rewritable
// as the UI grows in later phases.

import { runAgent } from "./agent-loop.js";
import {
  schemas as TOOLS,
  onPythonStatus,
  onRStatus,
  loadFile,
  setDatasetMasking,
  plotStore,
  renderStore,
  executedCalls,
  setInputProvider,
  snapshotRenderStore,
  restoreRenderStore,
  snapshotPlotStore,
  restorePlotStore,
} from "./tools.js";
import { renderArtifact } from "./render/index.js";
import { renderPromptCard, renderResolvedPromptCard } from "./render/prompt.js";
import { saveChatState, loadChatState, clearChatState } from "./chat-store.js";
import { saveToOPFS, listOPFSFiles, readOPFSFile } from "./datasets.js";
import { parseCSV } from "./csv.js";
import { loadMaskSpec, computeForbiddenValues, SIDECAR_SUFFIX } from "./masking.js";
import { getSettings, effectiveModel } from "./settings.js";
import { recordDatasetShape } from "./dataset-meta.js";
import "./theme.js"; // keeps <html>'s "dark" class live if the OS theme changes mid-session
// The model's final answer is Markdown (agent/prompts.py step 8) — render
// it properly rather than as an escaped block of raw text. marked only
// parses Markdown to HTML and explicitly does not sanitize its output
// (its own docs recommend pairing it with a sanitizer), so DOMPurify runs
// on every result before it ever reaches innerHTML — this is untrusted
// text from an LLM response, not something we authored. Versions pinned
// (same reproducibility rationale as the Pyodide/webR CDN loads in
// pyodide-worker.js/r-runtime.js), loaded as ES modules the same way
// r-runtime.js lazy-loads webR from jsDelivr.
import { parse as parseMarkdown } from "https://cdn.jsdelivr.net/npm/marked@13.0.3/lib/marked.esm.js";
import DOMPurify from "https://cdn.jsdelivr.net/npm/dompurify@3.4.12/dist/purify.es.mjs";
import { buildReportPdf, buildReportZip } from "./report-export.js";
// fflate's browser build (no Node builtins) — same pinned-CDN-ESM pattern as
// marked/DOMPurify above. Only unzipSync is needed: a ".zip" upload
// (handleZipUpload below) is decompressed synchronously, in memory, right
// here in the tab, then every supported file inside it goes through the
// same per-file pipeline as a direct upload.
import { unzipSync } from "https://cdn.jsdelivr.net/npm/fflate@0.8.2/esm/browser.js";

const TEXT_EXTENSIONS = [".csv", ".tsv", ".json", ".txt"];
const DATASET_EXTENSIONS = [".csv", ".tsv", ".json", ".xlsx"]; // matches file-input's accept list

// A ZIP is decompressed entirely in this tab (fflate's unzipSync is
// synchronous/in-memory) — these caps just keep a mis-sized or adversarial
// archive from hanging the tab. Not a security boundary: the archive never
// leaves the browser either way, so the only thing at risk is this session.
const ZIP_MAX_FILE_BYTES = 100 * 1024 * 1024; // reject the .zip itself past this
const ZIP_MAX_ENTRIES = 50; // stop extracting after this many supported files
const ZIP_MAX_ENTRY_BYTES = 50 * 1024 * 1024; // skip any single extracted file past this

const messagesEl = document.getElementById("messages");
const formEl = document.getElementById("composer-form");
const inputEl = document.getElementById("composer-input");
const sendBtnEl = document.getElementById("composer-send");
const fileInputEl = document.getElementById("file-input");
const datasetListEl = document.getElementById("dataset-list");
const pythonStatusEl = document.getElementById("python-status");
const rStatusEl = document.getElementById("r-status");
const exportChatBtnEl = document.getElementById("export-chat-btn");
const deleteChatBtnEl = document.getElementById("delete-chat-btn");

const history = [];
// One entry per completed turn, replayable (replayTurn, below) into the
// same DOM a live turn produces — this plus renderStore/plotStore/hitlLog
// is exactly what chat-store.js persists, so a page reload can rebuild the
// visible conversation instead of just losing it.
const transcript = [];
let systemPrompt = "You are a helpful assistant."; // overwritten once /api/config resolves

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// ---- chat rendering (unchanged shape from Phase 3) -------------------

function appendUserMessage(text) {
  const wrap = el("div", "flex justify-end");
  const bubble = el("div", "max-w-lg bg-blue-600 text-white rounded-2xl rounded-br-sm px-4 py-2.5", text);
  wrap.appendChild(bubble);
  messagesEl.appendChild(wrap);
  scrollToBottom();
}

function appendAssistantShell() {
  const wrap = el("div", "flex flex-col gap-2.5 max-w-2xl");
  const label = el("div", "flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400");
  const badge = el("div", "h-5 w-5 rounded-md bg-blue-600 flex items-center justify-center text-white text-[10px] font-semibold", "B");
  label.appendChild(badge);
  label.appendChild(document.createTextNode("Bench"));
  wrap.appendChild(label);
  messagesEl.appendChild(wrap);
  scrollToBottom();
  return wrap;
}

function appendToolTrace(container, name, args) {
  const card = el("div", "rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 overflow-hidden text-xs");
  const header = el("div", "flex items-start gap-2 px-3 py-2 text-slate-600 dark:text-slate-300");
  header.appendChild(el("span", "font-mono px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-700 shrink-0", name));
  // The model is asked (the run_python/run_r tool schemas in tools/runtime/)
  // to supply a plain-language `description` alongside the code — that's
  // what's shown here by
  // default, in full (wraps rather than truncating). The code itself
  // lives behind a closed-by-default <details> toggle instead of being
  // rendered inline.
  const description = typeof args?.description === "string" && args.description.trim()
    ? args.description.trim()
    : "Running code…";
  header.appendChild(el("span", "flex-1 min-w-0", description));
  const status = el("span", "text-slate-400 dark:text-slate-500 shrink-0", "running…");
  header.appendChild(status);
  card.appendChild(header);

  if (typeof args?.code === "string" && args.code) {
    const details = el("details", "border-t border-slate-100 dark:border-slate-700");
    details.appendChild(el("summary", "cursor-pointer px-3 py-1.5 text-[11px] text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-300 select-none", "Show code"));
    details.appendChild(el("pre", "px-3 pb-2 font-mono text-[11px] text-slate-600 dark:text-slate-300 whitespace-pre-wrap", args.code));
    card.appendChild(details);
  }

  container.appendChild(card);
  scrollToBottom();
  return { card, status, code: args?.code };
}

const OUTPUT_LINE_LIMIT = 10;

// Long run_python/run_r output otherwise pushes the rest of the trace (and
// the actual final answer) far down the page — show the first N lines and
// fold the remainder behind a closed-by-default <details> toggle, same
// pattern as the code toggle above.
function appendOutputBody(card, text) {
  const preClass = "border-t border-slate-100 dark:border-slate-700 px-3 py-2 font-mono text-[11px] text-slate-600 dark:text-slate-300 whitespace-pre-wrap";
  const lines = text.split("\n");
  if (lines.length <= OUTPUT_LINE_LIMIT) {
    card.appendChild(el("pre", preClass, text));
    return;
  }
  card.appendChild(el("pre", preClass, lines.slice(0, OUTPUT_LINE_LIMIT).join("\n")));
  const remaining = lines.length - OUTPUT_LINE_LIMIT;
  const details = el("details", "border-t border-slate-100 dark:border-slate-700");
  details.appendChild(el("summary", "cursor-pointer px-3 py-1.5 text-[11px] text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-300 select-none", `Show ${remaining} more line${remaining === 1 ? "" : "s"}`));
  details.appendChild(el("pre", "px-3 pb-2 font-mono text-[11px] text-slate-600 dark:text-slate-300 whitespace-pre-wrap", lines.slice(OUTPUT_LINE_LIMIT).join("\n")));
  card.appendChild(details);
}

// ---- plot modal (click a plot to see it large next to its code) --------
// Built once and reused (rather than per-plot) since only one can be open
// at a time; content is swapped in on each open.

let plotModal = null;

function ensurePlotModal() {
  if (plotModal) return plotModal;

  const overlay = el("div", "fixed inset-0 z-50 hidden items-center justify-center bg-slate-900/60 p-4");
  const panel = el("div", "bg-white dark:bg-slate-800 rounded-xl shadow-2xl w-full max-w-5xl max-h-[90vh] flex overflow-hidden");

  const imageSide = el("div", "flex-1 min-w-0 flex items-center justify-center bg-slate-50 dark:bg-slate-900 p-4 overflow-auto");
  const img = document.createElement("img");
  img.className = "max-w-full max-h-full object-contain";
  imageSide.appendChild(img);

  const codeSide = el("div", "w-full max-w-sm shrink-0 border-l border-slate-200 dark:border-slate-700 flex flex-col");
  const codeHeader = el("div", "flex items-center justify-between px-3 py-2 border-b border-slate-200 dark:border-slate-700 text-xs font-medium text-slate-500 dark:text-slate-400 shrink-0");
  codeHeader.appendChild(el("span", "", "Code"));
  const closeBtn = el("button", "text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-300 text-base leading-none px-1", "✕");
  closeBtn.type = "button";
  closeBtn.title = "Close";
  codeHeader.appendChild(closeBtn);
  const codePre = el("pre", "flex-1 overflow-auto px-3 py-2 font-mono text-[11px] text-slate-600 dark:text-slate-300 whitespace-pre-wrap");
  codeSide.appendChild(codeHeader);
  codeSide.appendChild(codePre);

  panel.appendChild(imageSide);
  panel.appendChild(codeSide);
  overlay.appendChild(panel);
  document.body.appendChild(overlay);

  function close() {
    overlay.classList.add("hidden");
    overlay.classList.remove("flex");
    img.src = "";
  }

  closeBtn.addEventListener("click", close);
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) close();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") close();
  });

  plotModal = { overlay, img, codePre, close };
  return plotModal;
}

function openPlotModal(src, code) {
  const modal = ensurePlotModal();
  modal.img.src = src;
  modal.codePre.textContent = code || "(no code available)";
  modal.overlay.classList.remove("hidden");
  modal.overlay.classList.add("flex");
}

function finishToolTrace({ card, status, code }, ok, resultOrError) {
  status.textContent = ok ? "done" : "failed";
  status.className = ok ? "ml-auto text-emerald-600 dark:text-emerald-400 shrink-0" : "ml-auto text-rose-600 dark:text-rose-400 shrink-0";

  // An interact tool (ask_user/ask_choice/confirm/...) already rendered its
  // own Q&A card live into this card while the call was pending —
  // requestInputImpl appended it the moment ctx.requestInput fired, well
  // before this function ever runs for that call. Nothing more to add.
  if (resultOrError && resultOrError.rendered) {
    scrollToBottom();
    return;
  }

  // A client-render tool (render_table, render_chart) returns an opaque id
  // instead of text/images — resolve it from renderStore and show the
  // rendered artifact directly in the trace, rather than dumping the result
  // JSON as "output". Same store the final answer resolves from below.
  const renderId = typeof resultOrError === "object"
    ? resultOrError.tableId ?? resultOrError.chartId
    : undefined;
  if (renderId && renderStore.has(renderId)) {
    const section = el("div", "border-t border-slate-100 dark:border-slate-700 px-3 py-2");
    section.appendChild(renderArtifact(renderStore.get(renderId)));
    card.appendChild(section);
    scrollToBottom();
    return;
  }

  const text = typeof resultOrError === "object" && resultOrError.output !== undefined
    ? resultOrError.output
    : typeof resultOrError === "object" && resultOrError.error !== undefined
      ? resultOrError.error
      : JSON.stringify(resultOrError);
  appendOutputBody(card, text);

  // run_python/run_r plot output (pyodide-worker.js/r-runtime.js) — images
  // bypass sanitize() entirely (it can only scrub text), which is a
  // documented, real limitation, not an oversight; see the comments on
  // runR() in r-runtime.js and _bench_run in pyodide-worker.js.
  const images = typeof resultOrError === "object" ? resultOrError.images : undefined;
  if (Array.isArray(images) && images.length > 0) {
    const gallery = el("div", "border-t border-slate-100 dark:border-slate-700 px-3 py-2 flex flex-wrap gap-2");
    for (const src of images) {
      const img = document.createElement("img");
      img.src = src;
      img.className = "max-w-xs rounded border border-slate-200 dark:border-slate-700";
      const thumb = document.createElement("button");
      thumb.type = "button";
      thumb.className = "cursor-zoom-in";
      thumb.title = "Click to expand";
      thumb.appendChild(img);
      thumb.addEventListener("click", () => openPlotModal(src, code));
      gallery.appendChild(thumb);
    }
    card.appendChild(gallery);
  }
  scrollToBottom();
}

// The model can't see actual plot bytes (agent-loop.js strips `images`
// before a tool result ever reaches it — real cost/context, not just
// noise) — instead it gets an opaque id (tools.js's plotStore/imageIds)
// and is told (agent/prompts.py step 8) to embed it with plain Markdown
// image syntax, e.g. ![...](plot-3). marked turns that into <img
// src="plot-3">, which DOMPurify passes through untouched (it's just a
// relative reference, no special URI scheme to worry about) — this walks
// the *already-sanitized* result and swaps each recognized id for its
// real data URL, while `bubble` is still detached from the document (so
// the browser never actually attempts to fetch the literal string
// "plot-3" as a URL first). A reference to a nonexistent/hallucinated id
// is left as visible placeholder text rather than a silently broken
// image icon.
function resolveRenderReferences(bubble) {
  for (const img of Array.from(bubble.querySelectorAll("img"))) {
    const id = img.getAttribute("src");

    // plot-N (matplotlib/R images) -> resolve to the real data URL in place.
    const plot = plotStore.get(id);
    if (plot) {
      img.src = plot.src;
      img.className = "max-w-full rounded border border-slate-200 dark:border-slate-700 cursor-zoom-in";
      img.title = "Click to expand";
      img.addEventListener("click", () => openPlotModal(plot.src, plot.code));
      continue;
    }

    // table-N (and future chart-N) -> replace the <img> with a live node.
    const artifact = renderStore.get(id);
    if (artifact) {
      img.replaceWith(renderArtifact(artifact));
      continue;
    }

    // A nonexistent/hallucinated id: visible placeholder, not a broken image.
    img.replaceWith(document.createTextNode(`[not found: ${id}]`));
  }
}

function appendFinalText(container, text) {
  // prose/prose-sm (Tailwind Typography, loaded via the ?plugins=typography
  // Play CDN param in workbench.html) styles headings/lists/code
  // blocks/tables/etc. properly instead of them all rendering as flat,
  // unstyled text under Tailwind's preflight reset.
  const bubble = el("div", "prose prose-sm prose-slate dark:prose-invert max-w-none rounded-xl bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 px-4 py-3");
  if (text) {
    bubble.innerHTML = DOMPurify.sanitize(parseMarkdown(text, { breaks: true, gfm: true }));
    resolveRenderReferences(bubble);
  } else {
    bubble.textContent = "(no response)";
  }
  container.appendChild(bubble);
  scrollToBottom();
  return bubble;
}

const REPORT_TITLE = "Bench — Analysis Report";

// "Open as PDF" / "Download .zip" — only shown under a real final answer
// (handleSubmit), never under an error/aborted/max_turns message, since
// there's nothing coherent to export in those cases. Both build the PDF
// from `bubble` fresh on click rather than once up front: it's cheap,
// and it means the export always reflects whatever's actually on screen
// (plots/tables already resolved to real nodes by resolveRenderReferences).
function appendReportActions(container, bubble) {
  const row = el("div", "flex items-center gap-3 mt-1.5");

  const pdfBtn = el("button", "text-xs text-blue-600 dark:text-blue-400 hover:underline disabled:text-slate-400 dark:disabled:text-slate-500 disabled:no-underline", "Open as PDF");
  pdfBtn.type = "button";
  pdfBtn.addEventListener("click", async () => {
    pdfBtn.disabled = true;
    const original = pdfBtn.textContent;
    pdfBtn.textContent = "Generating PDF…";
    try {
      const doc = await buildReportPdf(bubble, { title: REPORT_TITLE });
      window.open(doc.output("bloburl"), "_blank");
    } catch (err) {
      appendErrorText(container, `Failed to generate PDF: ${err.message}`);
    } finally {
      pdfBtn.disabled = false;
      pdfBtn.textContent = original;
    }
  });

  const zipBtn = el("button", "text-xs text-blue-600 dark:text-blue-400 hover:underline disabled:text-slate-400 dark:disabled:text-slate-500 disabled:no-underline", "Download report + data + scripts (.zip)");
  zipBtn.type = "button";
  zipBtn.addEventListener("click", async () => {
    zipBtn.disabled = true;
    const original = zipBtn.textContent;
    zipBtn.textContent = "Building ZIP…";
    try {
      const doc = await buildReportPdf(bubble, { title: REPORT_TITLE });
      const pdfBytes = new Uint8Array(doc.output("arraybuffer"));
      const datasetFiles = (await listOPFSFiles()).filter((f) => !f.name.endsWith(SIDECAR_SUFFIX));
      const datasets = await Promise.all(
        datasetFiles.map(async (f) => ({ name: f.name, bytes: await readOPFSFile(f.name) }))
      );
      // Ship each render_chart's Vega-Lite spec as reproducible JSON next to
      // its rasterized image in the PDF (plan §4.5).
      const charts = [...renderStore.entries()]
        .filter(([, a]) => a.type === "chart")
        .map(([id, a]) => ({ id, spec: a.spec }));
      const zipBytes = buildReportZip({ pdfBytes, datasets, scripts: executedCalls, charts });
      const url = URL.createObjectURL(new Blob([zipBytes], { type: "application/zip" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = "bench-report.zip";
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      appendErrorText(container, `Failed to build ZIP: ${err.message}`);
    } finally {
      zipBtn.disabled = false;
      zipBtn.textContent = original;
    }
  });

  row.appendChild(pdfBtn);
  row.appendChild(zipBtn);
  container.appendChild(row);
}

function appendErrorText(container, text) {
  const bubble = el("div", "rounded-xl bg-rose-50 dark:bg-rose-900/20 border border-rose-200 dark:border-rose-800 text-rose-700 dark:text-rose-300 px-4 py-3 text-[13.5px]", `Error: ${text}`);
  container.appendChild(bubble);
  scrollToBottom();
}

function appendNoteText(container, text) {
  const bubble = el("div", "rounded-xl bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-500 dark:text-slate-400 px-4 py-3 text-[13.5px]", text);
  container.appendChild(bubble);
  scrollToBottom();
}

/** OPFS (navigator.storage.getDirectory()) throws SecurityError in
 * contexts that don't support persistent per-origin storage — most
 * commonly a Firefox Private Browsing window, which disables it by
 * design, but also possible under strict tracking-protection storage
 * partitioning. Everything dataset-related in this app depends on OPFS
 * (principle 2 — files never leave the browser), so surface this as a
 * clear message instead of letting it fail as a silent unhandled
 * rejection with an empty dataset list. */
function describeStorageError(err) {
  if (err instanceof DOMException && (err.name === "SecurityError" || err.name === "NotAllowedError")) {
    return "This browser session doesn't allow local file storage (OPFS) — common in Firefox Private Browsing windows, which disable it by design. Try a normal (non-private) window, or a different browser.";
  }
  return `Failed to access local dataset storage: ${err.message || err}`;
}

function scrollToBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

// Composer is disabled during chat turns AND during dataset loads — a real
// bug surfaced in testing otherwise: clicking "Load" then immediately
// asking a question could race ahead of the file actually being written
// into the Pyodide worker's filesystem (the "Python: ready" badge only
// means the interpreter booted, not that a specific load_file call has
// finished), hitting a FileNotFoundError. A counter, not a plain boolean,
// so an upload and a chat turn overlapping don't re-enable early.
let busyCount = 0;
function pushBusy() {
  busyCount++;
  inputEl.disabled = true;
  syncSendButtonDisabled();
  syncChatActionButtons(); // deleting mid-turn would rip out DOM/state a live tool call still references
}
function popBusy() {
  busyCount = Math.max(0, busyCount - 1);
  if (busyCount === 0) inputEl.disabled = false;
  syncSendButtonDisabled();
  syncChatActionButtons();
}

// ---- send/stop button ---------------------------------------------------
// While an agent turn is running, the send button becomes a Stop button
// (always clickable, so the user can interrupt) instead of just being
// disabled like it is for an unrelated dataset load.

const SEND_ICON_HTML = '<svg class="h-4 w-4" viewBox="0 0 24 24" fill="currentColor"><path d="M3.4 20.4l17.45-8.31a1 1 0 0 0 0-1.8L3.4 1.98a1 1 0 0 0-1.4 1.06L4.4 12 2 20.96a1 1 0 0 0 1.4 1.06Z"/></svg>';
const STOP_ICON_HTML = '<svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="currentColor"><rect x="5" y="5" width="14" height="14" rx="2"/></svg>';

let sendMode = "send"; // "send" | "stop"

function syncSendButtonDisabled() {
  sendBtnEl.disabled = sendMode === "send" && busyCount > 0;
}

function setSendMode(mode) {
  sendMode = mode;
  const isStop = mode === "stop";
  sendBtnEl.innerHTML = isStop ? STOP_ICON_HTML : SEND_ICON_HTML;
  sendBtnEl.classList.toggle("bg-rose-600", isStop);
  sendBtnEl.classList.toggle("bg-blue-600", !isStop);
  sendBtnEl.title = isStop ? "Stop" : "Send";
  sendBtnEl.setAttribute("aria-label", isStop ? "Stop" : "Send");
  syncSendButtonDisabled();
}

// ---- Python environment status badge ----------------------------------

onPythonStatus((status) => {
  const labels = {
    loading: ["Python: loading pandas/numpy…", "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-900/20 dark:text-amber-300 dark:border-amber-800"],
    ready: ["Python: ready", "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-400 dark:border-emerald-800"],
    error: ["Python: failed to load", "bg-rose-50 text-rose-700 border-rose-200 dark:bg-rose-900/20 dark:text-rose-300 dark:border-rose-800"],
  };
  const [label, classes] = labels[status] || [status, "bg-slate-50 text-slate-600 border-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700"];
  pythonStatusEl.textContent = label;
  pythonStatusEl.className = `text-xs px-2.5 py-1 rounded-full border ${classes}`;
  pythonStatusEl.classList.remove("hidden");
});

// Unlike Python, R (webR) is lazy-loaded (plan §8: its wasm payload is
// tens of MB) — this badge stays hidden until the first run_r call
// actually triggers a load, rather than showing "loading" on every page
// visit whether or not R ever gets used.
onRStatus((status) => {
  const labels = {
    loading: ["R: loading webR…", "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-900/20 dark:text-amber-300 dark:border-amber-800"],
    ready: ["R: ready", "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-400 dark:border-emerald-800"],
    error: ["R: failed to load", "bg-rose-50 text-rose-700 border-rose-200 dark:bg-rose-900/20 dark:text-rose-300 dark:border-rose-800"],
  };
  const [label, classes] = labels[status] || [status, "bg-slate-50 text-slate-600 border-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700"];
  rStatusEl.textContent = label;
  rStatusEl.className = `text-xs px-2.5 py-1 rounded-full border ${classes}`;
  rStatusEl.classList.remove("hidden");
});

// ---- datasets (OPFS + push into the Pyodide worker) --------------------

function renderDatasetList(files) {
  datasetListEl.innerHTML = "";
  for (const f of files) {
    const row = el("li", "flex items-center justify-between gap-2 text-xs px-2 py-1.5 rounded-lg bg-slate-50 dark:bg-slate-700");
    row.appendChild(el("span", "truncate", `${f.name} (${f.size}B)`));
    const loadBtn = el("button", "text-blue-600 dark:text-blue-400 hover:underline shrink-0", "Load");
    loadBtn.addEventListener("click", async () => {
      loadBtn.disabled = true;
      loadBtn.textContent = "Loading…";
      try {
        await loadDatasetIntoPython(f.name);
        loadBtn.textContent = "Loaded";
      } catch (err) {
        loadBtn.textContent = "Load";
        appendErrorText(messagesEl, describeStorageError(err));
      } finally {
        loadBtn.disabled = false;
        setTimeout(() => {
          if (loadBtn.isConnected) loadBtn.textContent = "Load";
        }, 2000);
      }
    });
    row.appendChild(loadBtn);
    datasetListEl.appendChild(row);
  }
}

async function refreshDatasetList() {
  const files = (await listOPFSFiles()).filter((f) => !f.name.endsWith(SIDECAR_SUFFIX));
  renderDatasetList(files);
}

/** Reads the saved masking rules for a dataset and registers the literal
 * values they cover with tools.js, so the sanitize() choke point (plan
 * §3.3) knows what to scrub out of this dataset's future tool results.
 * Text-only for now (matches datasets-page.js's own preview limitation) —
 * an xlsx dataset can still be loaded and used, it just has no masking
 * rules to enforce yet. Also records this dataset's coarse shape (plan
 * §3.7) for the usage-metadata log — row/column counts when parseable,
 * size bucket always — since this is the one place row/column counts are
 * already computed for masking and don't need re-parsing. */
async function registerMasking(name, bytes) {
  if (!TEXT_EXTENSIONS.some((ext) => name.toLowerCase().endsWith(ext))) {
    recordDatasetShape(name, { sizeBytes: bytes.byteLength });
    return;
  }
  const text = new TextDecoder().decode(bytes);
  const { headers, rows } = parseCSV(text);
  recordDatasetShape(name, { rows: rows.length, cols: headers.length, sizeBytes: bytes.byteLength });
  const spec = await loadMaskSpec(name);
  setDatasetMasking(name, computeForbiddenValues(headers, rows, spec));
}

async function loadDatasetIntoPython(name) {
  pushBusy(); // block chat submission until the file is actually written into Python's FS
  try {
    const bytes = await readOPFSFile(name);
    await registerMasking(name, bytes);
    await loadFile(name, bytes);
  } finally {
    popBusy();
  }
}

/** Persists one dataset file (OPFS) and loads it into the live Pyodide
 * worker + masking rules — the same steps a direct upload always did,
 * factored out so a ZIP's extracted entries (handleZipUpload) go through
 * exactly the same pipeline as a plain upload. */
async function processDatasetFile(name, bytes) {
  await saveToOPFS(new File([bytes], name)); // persists in this browser — never sent to the backend
  await registerMasking(name, bytes);
  await loadFile(name, bytes); // also push into the live Pyodide worker
}

function isSupportedDatasetFile(name) {
  const lower = name.toLowerCase();
  return DATASET_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/** "Automatically explored" ZIP upload: decompress client-side and run
 * every supported file inside it through processDatasetFile, as if each had
 * been uploaded on its own. Skips directories, macOS metadata
 * (__MACOSX/, .DS_Store), and anything not in DATASET_EXTENSIONS. */
async function handleZipUpload(file) {
  if (file.size > ZIP_MAX_FILE_BYTES) {
    appendErrorText(
      messagesEl,
      `"${file.name}" is too large to explore (${Math.round(file.size / 1024 / 1024)}MB) — the limit is ${ZIP_MAX_FILE_BYTES / 1024 / 1024}MB.`
    );
    return;
  }

  const zipBytes = new Uint8Array(await file.arrayBuffer());
  let entries;
  try {
    entries = unzipSync(zipBytes);
  } catch (err) {
    appendErrorText(messagesEl, `Couldn't read "${file.name}" as a ZIP archive: ${err.message || err}`);
    return;
  }

  const candidates = Object.keys(entries)
    .filter((path) => !path.endsWith("/") && !path.startsWith("__MACOSX/"))
    .map((path) => ({ path, name: path.split("/").pop() }))
    .filter(({ name }) => name && name !== ".DS_Store" && isSupportedDatasetFile(name));

  const loaded = [];
  const skipped = [];
  for (const { path, name } of candidates) {
    if (loaded.length >= ZIP_MAX_ENTRIES || entries[path].length > ZIP_MAX_ENTRY_BYTES) {
      skipped.push(name);
      continue;
    }
    await processDatasetFile(name, entries[path]);
    loaded.push(name);
  }

  if (loaded.length) {
    appendNoteText(messagesEl, `Extracted ${loaded.length} dataset file${loaded.length === 1 ? "" : "s"} from "${file.name}": ${loaded.join(", ")}.`);
  }
  if (skipped.length) {
    appendNoteText(messagesEl, `Skipped ${skipped.length} file${skipped.length === 1 ? "" : "s"} from "${file.name}" (too many entries, or a single file too large): ${skipped.join(", ")}.`);
  }
  if (!candidates.length) {
    appendNoteText(messagesEl, `"${file.name}" didn't contain any supported dataset files (${DATASET_EXTENSIONS.join(", ")}).`);
  }
}

async function handleFileInputChange() {
  const file = fileInputEl.files[0];
  if (!file) return;
  pushBusy();
  try {
    if (file.name.toLowerCase().endsWith(".zip")) {
      await handleZipUpload(file);
    } else {
      await processDatasetFile(file.name, await file.arrayBuffer());
    }
    await refreshDatasetList();
  } catch (err) {
    appendErrorText(messagesEl, describeStorageError(err));
  } finally {
    popBusy();
  }
  fileInputEl.value = "";
}

// ---- composer / agent loop ---------------------------------------------

let activeAbortController = null;

// The tool-trace card for whichever tool call is currently in flight, if
// any (plans/human-in-the-loop-tools.md §3). Set at tool_call_start,
// cleared at tool_call_result/tool_call_error below. Safe as a single
// reference rather than a stack: agent-loop.js awaits each tool call before
// starting the next, so at most one call — and therefore at most one
// pending HITL request — is ever in flight at a time. This is where
// requestInputImpl (below) appends the live prompt card while a call is
// still pending, i.e. before finishToolTrace ever runs for it.
let activeToolCard = null;

// Renders a turn's tail — the final answer / max-turns notice / stop notice
// / mid-turn error — shared between a live turn (handleSubmit) and replaying
// a saved one (replayTurn) so the two paths can't visually drift apart.
function renderTurnOutcome(assistantContainer, { stoppedReason, finalText, errorMessage }) {
  let bubble = null;
  if (stoppedReason === "final_message") {
    bubble = appendFinalText(assistantContainer, finalText);
    if (finalText) appendReportActions(assistantContainer, bubble);
  } else if (stoppedReason === "max_turns") {
    appendErrorText(assistantContainer, "Gave up after too many turns without a final answer.");
  } else if (stoppedReason === "aborted") {
    appendNoteText(assistantContainer, "Stopped.");
  }
  if (errorMessage) appendErrorText(assistantContainer, errorMessage);
  return bubble;
}

async function handleSubmit(event) {
  event.preventDefault();

  // The send button doubles as Stop while a turn is running (setSendMode) —
  // a submit while one's already active means the click was on Stop, not a
  // new question.
  if (activeAbortController) {
    activeAbortController.abort();
    return;
  }

  const text = inputEl.value.trim();
  if (!text) return;

  inputEl.value = "";
  autoResizeComposer(); // multi-line input collapses back to one row after send
  pushBusy();
  activeAbortController = new AbortController();
  setSendMode("stop");

  appendUserMessage(text);
  const assistantContainer = appendAssistantShell();
  const toolTraceStack = [];
  // Parallel stack to toolTraceStack: the not-yet-settled turnRecord entry
  // each pending trace belongs to, so its result/error can be filled in once
  // the call resolves. One turnRecord persisted per completed turn is what
  // lets replayTurn (below) rebuild this exact DOM after a reload.
  const toolCallStack = [];
  const turnRecord = { userText: text, toolCalls: [], stoppedReason: null, finalText: null, errorMessage: null };

  const { finalText, stoppedReason } = await runAgent({
    systemPrompt,
    history,
    userText: text,
    tools: TOOLS,
    model: effectiveModel(),
    signal: activeAbortController.signal,
    onEvent(evt) {
      if (evt.type === "tool_call_start") {
        const trace = appendToolTrace(assistantContainer, evt.name, evt.args);
        toolTraceStack.push(trace);
        activeToolCard = trace.card;
        const record = { name: evt.name, args: evt.args, ok: null, result: null };
        turnRecord.toolCalls.push(record);
        toolCallStack.push(record);
      } else if (evt.type === "tool_call_result") {
        activeToolCard = null;
        finishToolTrace(toolTraceStack.pop(), true, evt.result);
        const record = toolCallStack.pop();
        record.ok = true;
        record.result = evt.result;
      } else if (evt.type === "tool_call_error") {
        activeToolCard = null;
        finishToolTrace(toolTraceStack.pop(), false, { error: evt.error });
        const record = toolCallStack.pop();
        record.ok = false;
        record.result = { error: evt.error };
      } else if (evt.type === "error") {
        appendErrorText(assistantContainer, evt.message);
        turnRecord.errorMessage = evt.message;
      }
    },
  });

  turnRecord.stoppedReason = stoppedReason;
  turnRecord.finalText = finalText;
  renderTurnOutcome(assistantContainer, { stoppedReason, finalText, errorMessage: null });
  if (stoppedReason === "final_message") {
    history.push({ role: "user", content: text });
    history.push({ role: "assistant", content: finalText });
    syncChatActionButtons();
  }
  transcript.push(turnRecord);
  scheduleSave();

  activeAbortController = null;
  setSendMode("send");
  popBusy();
  inputEl.focus();
}

formEl.addEventListener("submit", handleSubmit);
fileInputEl.addEventListener("change", handleFileInputChange);

// ---- composer: multi-line input (Shift+Enter for a newline) ------------
// The composer is a <textarea> so it can actually hold a line break — a
// plain <input type="text"> can't render one at all. Enter alone submits
// (matching the old single-line input's native behavior); Shift+Enter
// inserts a newline instead. `isComposing` guards IME composition (e.g.
// Japanese/Chinese input): the Enter that confirms a candidate must not
// also submit the form.

const COMPOSER_MAX_HEIGHT_PX = 160; // matches the template's max-h-40

function autoResizeComposer() {
  inputEl.style.height = "auto";
  inputEl.style.height = `${Math.min(inputEl.scrollHeight, COMPOSER_MAX_HEIGHT_PX)}px`;
}

inputEl.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    formEl.requestSubmit();
  }
});
inputEl.addEventListener("input", autoResizeComposer);

// ---- human-in-the-loop (ask_user/ask_choice/confirm/...) ---------------
// plans/human-in-the-loop-tools.md §2/§3. The agent loop already does
// `await callTool(...)` — an interact tool's handler just calls
// ctx.requestInput(spec) and awaits it, so "pause the loop" falls out for
// free; this is the browser-side implementation of that promise: render a
// live prompt card into the currently-running tool's trace card
// (activeToolCard), and resolve when the user answers, declines, the turn
// is aborted, or a generous timeout elapses so an abandoned tab doesn't
// park the agent forever.

const HITL_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes (plan §13 — generous default)

// Every resolved HITL exchange, in order — folded into the chat JSON
// export (exportChat, below) since it's part of the reasoning even though
// it happens mid-turn rather than as its own `history` entry (plan §8).
const hitlLog = [];

function requestInputImpl(spec) {
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;

    function settle(result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      activeAbortController?.signal.removeEventListener("abort", onAbort);
      // title/why carried along too (not just kind/question) so a restored
      // session's replayTurn can render the same card copy the user actually
      // saw, not a generic fallback.
      hitlLog.push({ kind: spec.kind, question: spec.question, title: spec.title, why: spec.why, ...result });
      resolve(result);
    }
    function onAbort() {
      settle({ answered: false, reason: "aborted", value: null });
    }

    activeAbortController?.signal.addEventListener("abort", onAbort);
    timer = setTimeout(() => settle({ answered: false, reason: "timeout", value: null }), HITL_TIMEOUT_MS);

    const node = renderPromptCard(
      spec,
      (value) => settle({ answered: true, value, reason: undefined }),
      () => settle({ answered: false, reason: "declined", value: null })
    );
    // Falls back to the message stream if a request somehow fires with no
    // active tool card (shouldn't happen — requestInput is only ever
    // called from inside a running tool handler — but never silently drop
    // the question rather than degrade visibly).
    const target = activeToolCard || messagesEl;
    target.appendChild(node);
    scrollToBottom();
  });
}

// window.__BENCH_DISABLE_HITL__ is the eval browser harness's escape hatch
// (eval/browser_harness.py sets it via an init script before the page
// loads): a headless Playwright run has no human to click a button, so
// installing the real UI provider there would leave a pending request
// waiting the full HITL_TIMEOUT_MS on every case that triggers one. Left
// unset (the normal path for a real user), the default no-op provider in
// tools/shared/input-provider.js is replaced by the real one below.
if (!window.__BENCH_DISABLE_HITL__) {
  setInputProvider(requestInputImpl);
}

// ---- export chat as JSON ------------------------------------------------
// The whole thing is a local download — the conversation is already in the
// browser, so this stays inside principle 2 (nothing leaves). Exports the
// user/assistant turns (`history`); plot/table/chart ids stay as their
// `plot-N`/`table-N` references in the assistant text (the rendered images
// are not embedded — this is a text transcript, not the .zip report).

function downloadJson(filename, obj) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function exportChat() {
  if (history.length === 0) return;
  const payload = {
    app: "Bench",
    exportedAt: new Date().toISOString(),
    model: effectiveModel(),
    messages: history.map((m) => ({ role: m.role, content: m.content })),
  };
  // Human-in-the-loop exchanges happen mid-turn, not as a `history` entry —
  // include them separately so the export still reflects the full
  // reasoning (plan §8), rather than silently dropping them.
  if (hitlLog.length > 0) payload.humanInTheLoop = hitlLog;
  downloadJson("bench-chat.json", payload);
}

function syncChatActionButtons() {
  const hasChat = history.length > 0 || transcript.length > 0;
  exportChatBtnEl.disabled = !hasChat;
  // Also gated on busyCount (pushBusy/popBusy) — deleting mid-turn would
  // clear state (renderStore/plotStore/DOM) a still-running tool call or
  // its in-flight rendering may still reference.
  deleteChatBtnEl.disabled = !hasChat || busyCount > 0;
}

exportChatBtnEl.addEventListener("click", exportChat);

/** "Delete chat" — wipes every bit of client-side chat state (in-memory
 * and the IndexedDB record from chat-store.js) and the visible transcript,
 * so the workbench looks exactly like a first visit. Datasets/masking
 * rules (OPFS) and provider settings (localStorage) are untouched — this
 * only clears the conversation. */
async function deleteChat() {
  if (!window.confirm("Delete this conversation? This clears it from this browser and can't be undone.")) {
    return;
  }

  history.length = 0;
  transcript.length = 0;
  hitlLog.length = 0;
  executedCalls.length = 0;
  restoreRenderStore({ entries: [], counters: [] });
  restorePlotStore({ entries: [], nextPlotId: 1 });
  messagesEl.innerHTML = "";

  syncChatActionButtons();
  try {
    await clearChatState();
  } catch (err) {
    console.error("Failed to clear saved chat state", err);
  }
}

deleteChatBtnEl.addEventListener("click", () => {
  deleteChat().catch((err) => appendErrorText(messagesEl, `Failed to delete chat: ${err.message || err}`));
});

// ---- chat persistence (IndexedDB, plan principle 2 — never leaves the
// browser) ----------------------------------------------------------------
// Everything needed to rebuild the visible conversation after a reload:
// `history` (model context), `transcript` (one replayable record per turn),
// `hitlLog`/`executedCalls`, and the renderStore/plotStore payloads the
// transcript's tool-call results reference by id.

let saveInFlight = null;
let saveAgainAfter = false;

function scheduleSave() {
  // Turns complete one at a time, but guard against overlapping writes
  // anyway (e.g. a save still flushing when the next turn finishes) by
  // queuing at most one follow-up save rather than firing concurrent
  // IndexedDB transactions against the same record.
  if (saveInFlight) {
    saveAgainAfter = true;
    return;
  }
  saveInFlight = saveChatState({
    history,
    transcript,
    hitlLog,
    executedCalls,
    renderStore: snapshotRenderStore(),
    plotStore: snapshotPlotStore(),
  })
    .catch((err) => console.error("Failed to save chat state", err))
    .finally(() => {
      saveInFlight = null;
      if (saveAgainAfter) {
        saveAgainAfter = false;
        scheduleSave();
      }
    });
}

/** Rebuilds one turn's DOM from a saved turnRecord (handleSubmit builds the
 * live equivalent event-by-event; this replays the same calls from data
 * instead). `hitlQueue` is shared across the whole restore so interact-tool
 * calls across turns are matched to their hitlLog entries in the same
 * chronological order they were originally answered in. */
function replayTurn(turnRecord, hitlQueue) {
  appendUserMessage(turnRecord.userText);
  const assistantContainer = appendAssistantShell();

  for (const call of turnRecord.toolCalls) {
    const trace = appendToolTrace(assistantContainer, call.name, call.args);
    if (call.result && call.result.rendered) {
      const entry = hitlQueue.shift();
      if (entry) trace.card.appendChild(renderResolvedPromptCard(entry));
    }
    finishToolTrace(trace, call.ok, call.result);
  }

  renderTurnOutcome(assistantContainer, {
    stoppedReason: turnRecord.stoppedReason,
    finalText: turnRecord.finalText,
    errorMessage: turnRecord.errorMessage,
  });
}

async function restoreChatState() {
  let saved;
  try {
    saved = await loadChatState();
  } catch (err) {
    console.error("Failed to load saved chat state", err);
    return;
  }
  if (!saved || !Array.isArray(saved.transcript) || saved.transcript.length === 0) return;

  restoreRenderStore(saved.renderStore);
  restorePlotStore(saved.plotStore);
  if (Array.isArray(saved.history)) history.push(...saved.history);
  if (Array.isArray(saved.hitlLog)) hitlLog.push(...saved.hitlLog);
  if (Array.isArray(saved.executedCalls)) executedCalls.push(...saved.executedCalls);

  appendNoteText(messagesEl, "Restored your previous conversation from this browser.");
  const hitlQueue = [...hitlLog];
  for (const turnRecord of saved.transcript) {
    replayTurn(turnRecord, hitlQueue);
    transcript.push(turnRecord);
  }
  syncChatActionButtons();
}

// ---- provider badge (plan §3.6/§7 Phase 7) -----------------------------

function renderProviderBadge() {
  const settings = getSettings();
  const label = document.getElementById("provider-badge-label");
  if (settings.mode === "custom") {
    const model = settings.customModel || "(no model set)";
    label.textContent = `${model} · custom endpoint`;
  } else {
    const model = settings.hostedModel || "Mistral";
    label.textContent = `${model} · hosted proxy`;
  }
}

// ---- init ---------------------------------------------------------------

fetch("/api/config")
  .then((r) => r.json())
  .then((cfg) => { systemPrompt = cfg.systemPrompt; })
  .catch(() => appendErrorText(messagesEl, "Failed to load system prompt from /api/config."));

refreshDatasetList().catch((err) => appendErrorText(messagesEl, describeStorageError(err)));
renderProviderBadge();
restoreChatState();
