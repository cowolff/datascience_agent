// The browser (DOM) half of render_table — turns a stored table artifact
// (tools/shared/render-store.js: { columns, rows }) into a node for the
// chat. Kept out of the tool module so the tool stays DOM-free/testable;
// this is view-only. Theme-aware via Tailwind classes, scrollable, and
// click-to-sort on any header (numeric-aware).
//
// `not-prose` so it isn't restyled by the Tailwind Typography `.prose`
// wrapper on the final-answer bubble. Known limitation, on the same footing
// as the plan's charts-in-PDF note (§4.5): the `max-h` scroll container
// means the PDF/ZIP export (report-export.js rasterizes the bubble) captures
// only the visible portion of a long table — acceptable for now since
// render_table is capped at summary-sized tables; a full-height export
// variant can come with the chart export work.

import { el } from "./dom.js";

function compareCells(a, b) {
  const na = parseFloat(a);
  const nb = parseFloat(b);
  const bothNumeric =
    !Number.isNaN(na) && !Number.isNaN(nb) && a.trim() !== "" && b.trim() !== "";
  if (bothNumeric) return na - nb;
  return a.localeCompare(b);
}

export function renderTable({ columns, rows }) {
  const wrap = el(
    "div",
    "not-prose my-2 overflow-auto max-h-96 rounded-lg border border-slate-200 dark:border-slate-700"
  );
  const table = el("table", "min-w-full text-xs border-collapse");
  const thead = el("thead", "");
  const headRow = el("tr", "");
  const tbody = el("tbody", "");

  let sort = { col: null, dir: 1 };
  const arrows = [];

  function renderBody() {
    tbody.innerHTML = "";
    let ordered = rows;
    if (sort.col !== null) {
      ordered = [...rows].sort(
        (r1, r2) => sort.dir * compareCells(r1[sort.col] ?? "", r2[sort.col] ?? "")
      );
    }
    ordered.forEach((row, i) => {
      const tr = el("tr", i % 2 ? "bg-slate-50/60 dark:bg-slate-800/40" : "");
      columns.forEach((_, ci) => {
        tr.appendChild(
          el(
            "td",
            "px-2.5 py-1.5 border-b border-slate-100 dark:border-slate-700/60 whitespace-nowrap text-slate-700 dark:text-slate-200",
            row[ci] ?? ""
          )
        );
      });
      tbody.appendChild(tr);
    });
  }

  columns.forEach((label, ci) => {
    const th = el(
      "th",
      "sticky top-0 px-2.5 py-1.5 bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-200 font-medium border-b border-slate-200 dark:border-slate-600 cursor-pointer select-none whitespace-nowrap text-left"
    );
    th.appendChild(el("span", "", label));
    const arrow = el("span", "ml-1 text-slate-400 dark:text-slate-500", "");
    arrows.push(arrow);
    th.appendChild(arrow);
    th.addEventListener("click", () => {
      sort = sort.col === ci ? { col: ci, dir: -sort.dir } : { col: ci, dir: 1 };
      arrows.forEach((a) => (a.textContent = ""));
      arrow.textContent = sort.dir === 1 ? " ▲" : " ▼";
      renderBody();
    });
    headRow.appendChild(th);
  });

  thead.appendChild(headRow);
  table.appendChild(thead);
  table.appendChild(tbody);
  wrap.appendChild(table);
  renderBody();
  return wrap;
}
