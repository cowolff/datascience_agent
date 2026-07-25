// Page glue for templates/datasets.html — the data-governance UI (plan
// §3.3). Edits a mask spec and persists it to OPFS; does not itself talk
// to the model or the backend at all, since that's not this page's job.

import { parseCSV } from "./csv.js";
import { loadMaskSpec, saveMaskSpec, emptySpec, SIDECAR_SUFFIX } from "./masking.js";
import { listOPFSFiles, readOPFSFile } from "./datasets.js";
import "./theme.js"; // keeps <html>'s "dark" class live if the OS theme changes mid-session

const selectEl = document.getElementById("dataset-select");
const shapeEl = document.getElementById("dataset-shape");
const gridEl = document.getElementById("grid-container");
const summaryEl = document.getElementById("mask-summary");
const saveBtnEl = document.getElementById("save-mask-btn");
const saveStatusEl = document.getElementById("save-status");
const unsupportedEl = document.getElementById("unsupported-message");

const TEXT_EXTENSIONS = [".csv", ".tsv", ".json", ".txt"];

let headers = [];
let rows = [];
let spec = emptySpec();
let currentFile = null;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function isTextParseable(name) {
  return TEXT_EXTENSIONS.some((ext) => name.toLowerCase().endsWith(ext));
}

// OPFS throws SecurityError in contexts that don't support persistent
// per-origin storage — most commonly a Firefox Private Browsing window,
// which disables it by design. This page is entirely OPFS-backed, so
// surface that plainly instead of an unhandled rejection and a page that
// silently never populates.
function describeStorageError(err) {
  if (err instanceof DOMException && (err.name === "SecurityError" || err.name === "NotAllowedError")) {
    return "This browser session doesn't allow local file storage (OPFS) — common in Firefox Private Browsing windows, which disable it by design. Try a normal (non-private) window, or a different browser.";
  }
  return `Failed to access local dataset storage: ${err.message || err}`;
}

async function populateSelect() {
  const files = (await listOPFSFiles()).filter((f) => !f.name.endsWith(SIDECAR_SUFFIX));
  selectEl.innerHTML = "";
  if (files.length === 0) {
    selectEl.appendChild(new Option("No datasets uploaded yet — upload one from the Workbench", ""));
    return;
  }
  for (const f of files) selectEl.appendChild(new Option(`${f.name} (${f.size}B)`, f.name));
  await loadDataset(files[0].name);
}

async function loadDataset(name) {
  currentFile = name;
  unsupportedEl.classList.add("hidden");
  gridEl.innerHTML = "";

  if (!name || !isTextParseable(name)) {
    if (name) {
      unsupportedEl.textContent = `Preview/masking for "${name}" isn't supported yet — only CSV/TSV/JSON/TXT can be parsed client-side so far (xlsx is a follow-up). The file is still stored and usable from Python.`;
      unsupportedEl.classList.remove("hidden");
    }
    headers = [];
    rows = [];
    spec = emptySpec();
    shapeEl.textContent = "";
    renderSummary();
    return;
  }

  const bytes = await readOPFSFile(name);
  const text = new TextDecoder().decode(bytes);
  ({ headers, rows } = parseCSV(text));
  spec = await loadMaskSpec(name);
  shapeEl.textContent = `${rows.length} rows × ${headers.length} columns`;
  renderGrid();
  renderSummary();
}

// ---- mask spec mutation --------------------------------------------------

const isColHidden = (header) => spec.hiddenColumns.includes(header);
const isRowHidden = (r) => spec.hiddenRows.includes(r);
const isCellHidden = (r, c) => spec.hiddenCells.some(([hr, hc]) => hr === r && hc === c);

function toggleColumn(header) {
  spec.hiddenColumns = isColHidden(header)
    ? spec.hiddenColumns.filter((h) => h !== header)
    : [...spec.hiddenColumns, header];
  renderGrid();
  renderSummary();
}

function toggleRow(r) {
  spec.hiddenRows = isRowHidden(r) ? spec.hiddenRows.filter((x) => x !== r) : [...spec.hiddenRows, r];
  renderGrid();
  renderSummary();
}

function toggleCell(r, c) {
  spec.hiddenCells = isCellHidden(r, c)
    ? spec.hiddenCells.filter(([hr, hc]) => !(hr === r && hc === c))
    : [...spec.hiddenCells, [r, c]];
  renderGrid();
  renderSummary();
}

// ---- rendering ------------------------------------------------------------

function renderGrid() {
  gridEl.innerHTML = "";
  if (headers.length === 0) return;

  const table = el("table", "w-full text-xs");
  const thead = el("thead");
  const headRow = el("tr", "border-b border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900");
  headRow.appendChild(el("th", "w-8 px-2 py-2"));
  headers.forEach((h) => {
    const hidden = isColHidden(h);
    const th = el(
      "th",
      "text-left font-medium px-3 py-2 cursor-pointer select-none " + (hidden ? "text-slate-300 dark:text-slate-600 line-through" : "text-slate-600 dark:text-slate-300 hover:text-blue-600 dark:hover:text-blue-400")
    );
    th.textContent = h;
    th.title = hidden ? "Column hidden — click to reveal" : "Click to hide this column";
    th.addEventListener("click", () => toggleColumn(h));
    headRow.appendChild(th);
  });
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = el("tbody", "divide-y divide-slate-100 dark:divide-slate-700");
  rows.forEach((row, r) => {
    const rHidden = isRowHidden(r);
    const tr = el("tr", rHidden ? "bg-slate-50 dark:bg-slate-900 opacity-60" : "");

    const checkboxTd = el("td", "px-2 py-1.5");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = rHidden;
    checkbox.title = "Hide this row";
    checkbox.addEventListener("change", () => toggleRow(r));
    checkboxTd.appendChild(checkbox);
    tr.appendChild(checkboxTd);

    row.forEach((value, c) => {
      const governedByRowOrCol = rHidden || isColHidden(headers[c]);
      const hidden = governedByRowOrCol || isCellHidden(r, c);
      const td = el("td", "px-3 py-1.5" + (governedByRowOrCol ? "" : " cursor-pointer"));
      if (hidden) {
        const bar = el("span", "inline-block h-3 w-16 rounded");
        bar.style.backgroundImage =
          "repeating-linear-gradient(45deg, rgba(11,11,11,.12), rgba(11,11,11,.12) 3px, transparent 3px, transparent 7px)";
        td.appendChild(bar);
        td.title = "Hidden from the model";
      } else {
        td.textContent = value;
        td.title = "Click to hide this cell";
      }
      if (!governedByRowOrCol) td.addEventListener("click", () => toggleCell(r, c));
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  gridEl.appendChild(table);
}

function renderSummary() {
  summaryEl.innerHTML = "";
  summaryEl.appendChild(el("h2", "text-xs font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wide mb-3", "Masking summary"));

  const section = (title, entries) => {
    summaryEl.appendChild(el("p", "text-[11px] font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wide mt-3 mb-1", title));
    if (entries.length === 0) {
      summaryEl.appendChild(el("p", "text-xs text-slate-400 dark:text-slate-500", "none"));
      return;
    }
    const list = el("ul", "space-y-1");
    entries.forEach(({ label, onRemove }) => {
      const li = el("li", "flex items-center justify-between text-xs bg-slate-50 dark:bg-slate-900 rounded px-2 py-1");
      li.appendChild(el("span", "truncate", label));
      const btn = el("button", "text-slate-400 dark:text-slate-500 hover:text-rose-600 dark:hover:text-rose-400 shrink-0 ml-2", "×");
      btn.title = "Unmask";
      btn.addEventListener("click", onRemove);
      li.appendChild(btn);
      list.appendChild(li);
    });
    summaryEl.appendChild(list);
  };

  section(
    "Hidden columns",
    spec.hiddenColumns.map((h) => ({ label: h, onRemove: () => toggleColumn(h) }))
  );
  section(
    "Hidden rows",
    spec.hiddenRows.map((r) => ({ label: `row ${r + 1}`, onRemove: () => toggleRow(r) }))
  );
  section(
    "Hidden cells",
    spec.hiddenCells.map(([r, c]) => ({
      label: `${headers[c] ?? `col ${c}`} · row ${r + 1}`,
      onRemove: () => toggleCell(r, c),
    }))
  );
}

// ---- wiring ---------------------------------------------------------------

selectEl.addEventListener("change", () => loadDataset(selectEl.value));

saveBtnEl.addEventListener("click", async () => {
  if (!currentFile) return;
  await saveMaskSpec(currentFile, spec);
  saveStatusEl.textContent = "Saved — reload this dataset in the Workbench for the rules to take effect.";
  setTimeout(() => (saveStatusEl.textContent = ""), 5000);
});

populateSelect().catch((err) => {
  unsupportedEl.textContent = describeStorageError(err);
  unsupportedEl.classList.remove("hidden");
});
