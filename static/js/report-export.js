// Client-side export of a final chat answer: "open as PDF" and "download
// report + data + scripts as one .zip". Everything here runs against
// what's already in the page/OPFS/tools.js's call log — no server
// involvement, matching the rest of this app's "nothing leaves the
// browser unless the user explicitly downloads it" model.
//
// jsPDF is loaded as a classic UMD <script> in workbench.html, not an ES
// import like fflate/marked/DOMPurify — see the comment there for why.
// This module reads it off `window.jspdf` lazily (only once a report is
// actually built), so load order relative to this module doesn't matter.

import { zipSync, strToU8 } from "https://cdn.jsdelivr.net/npm/fflate@0.8.3/esm/browser.js";

const PAGE_WIDTH = 595.28; // pt, A4
const PAGE_HEIGHT = 841.89;
const MARGIN = 48;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;
const FONT_SIZE = 10.5;
const LINE_HEIGHT = 14;
const HEADING_SIZES = { H1: 18, H2: 15, H3: 13, H4: 11.5 };

// ---- inline runs (bold/italic/code, mixed within one paragraph/li) -----

function textRuns(node, fmt = { bold: false, italic: false, code: false }) {
  const runs = [];
  for (const child of node.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) {
      if (child.textContent) runs.push({ text: child.textContent, ...fmt });
    } else if (child.nodeType === Node.ELEMENT_NODE) {
      if (child.tagName === "BR") {
        runs.push({ text: "\n", ...fmt, isBreak: true });
        continue;
      }
      const next = {
        bold: fmt.bold || child.tagName === "STRONG" || child.tagName === "B",
        italic: fmt.italic || child.tagName === "EM" || child.tagName === "I",
        code: fmt.code || child.tagName === "CODE",
      };
      runs.push(...textRuns(child, next));
    }
  }
  return runs;
}

function setRunFont(doc, run) {
  if (run.code) {
    doc.setFont("courier", run.bold ? "bold" : "normal");
  } else {
    const style = run.bold && run.italic ? "bolditalic" : run.bold ? "bold" : run.italic ? "italic" : "normal";
    doc.setFont("helvetica", style);
  }
  doc.setFontSize(FONT_SIZE);
}

// Greedy word-wrap across mixed-formatting runs — switches font per word
// so bold/italic/code can change mid-line, wraps at word boundaries.
function renderRuns(doc, cursor, runs, x0, width) {
  let x = x0;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(FONT_SIZE);
  const spaceWidth = doc.getTextWidth(" ");

  for (const run of runs) {
    if (run.isBreak) {
      x = x0;
      cursor.y += LINE_HEIGHT;
      cursor.ensureSpace(LINE_HEIGHT);
      continue;
    }
    for (const word of run.text.split(/(\s+)/).filter(Boolean)) {
      if (/^\s+$/.test(word)) {
        if (x > x0) x += spaceWidth;
        continue;
      }
      setRunFont(doc, run);
      const w = doc.getTextWidth(word);
      if (x + w > x0 + width && x > x0) {
        x = x0;
        cursor.y += LINE_HEIGHT;
        cursor.ensureSpace(LINE_HEIGHT);
      }
      doc.text(word, x, cursor.y);
      x += w;
    }
  }
  cursor.y += LINE_HEIGHT;
}

// ---- block-level rendering ------------------------------------------

async function waitForImageDecode(img) {
  if (img.complete && img.naturalWidth) return;
  await new Promise((resolve) => {
    img.addEventListener("load", resolve, { once: true });
    img.addEventListener("error", resolve, { once: true });
  });
}

async function renderBlock(doc, cursor, node, x0, width) {
  if (node.nodeType === Node.TEXT_NODE) {
    if (!node.textContent.trim()) return;
    cursor.ensureSpace(LINE_HEIGHT);
    renderRuns(doc, cursor, [{ text: node.textContent, bold: false, italic: false, code: false }], x0, width);
    return;
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return;

  const tag = node.tagName;

  if (tag in HEADING_SIZES) {
    const size = HEADING_SIZES[tag];
    cursor.ensureSpace(size + 10);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(size);
    doc.text(node.textContent, x0, cursor.y + size * 0.75);
    cursor.y += size + 10;
    return;
  }

  if (tag === "P" || tag === "BLOCKQUOTE") {
    const runs = textRuns(node);
    if (runs.length === 0) return;
    cursor.ensureSpace(LINE_HEIGHT);
    const indent = tag === "BLOCKQUOTE" ? 16 : 0;
    renderRuns(doc, cursor, runs, x0 + indent, width - indent);
    cursor.y += 4;
    return;
  }

  if (tag === "UL" || tag === "OL") {
    let n = 1;
    for (const li of node.children) {
      if (li.tagName !== "LI") continue;
      const marker = tag === "OL" ? `${n}.` : "•";
      cursor.ensureSpace(LINE_HEIGHT);
      doc.setFont("helvetica", "normal");
      doc.setFontSize(FONT_SIZE);
      doc.text(marker, x0, cursor.y);
      renderRuns(doc, cursor, textRuns(li), x0 + 16, width - 16);
      n++;
    }
    cursor.y += 4;
    return;
  }

  if (tag === "PRE") {
    const lines = node.textContent.replace(/\n$/, "").split("\n");
    const blockHeight = lines.length * 12 + 10;
    cursor.ensureSpace(blockHeight);
    doc.setFillColor(243, 244, 246);
    doc.rect(x0, cursor.y - 9, width, blockHeight, "F");
    doc.setFont("courier", "normal");
    doc.setFontSize(9);
    let cy = cursor.y + 2;
    for (const line of lines) {
      for (const wrapped of doc.splitTextToSize(line, width - 8)) {
        doc.text(wrapped, x0 + 4, cy);
        cy += 12;
      }
    }
    cursor.y = cy + 8;
    return;
  }

  if (tag === "IMG") {
    await waitForImageDecode(node);
    const naturalW = node.naturalWidth || 400;
    const naturalH = node.naturalHeight || 300;
    const w = Math.min(width, naturalW);
    const h = (naturalH / naturalW) * w;
    cursor.ensureSpace(h + 10);
    doc.addImage(node.src, "PNG", x0, cursor.y, w, h);
    cursor.y += h + 12;
    return;
  }

  // Unknown container (e.g. a wrapping <div>) — recurse block-by-block.
  for (const child of node.childNodes) {
    await renderBlock(doc, cursor, child, x0, width);
  }
}

/**
 * Renders an already-resolved report bubble (plot <img> srcs must already
 * be real data URLs, i.e. called after resolveRenderReferences — see
 * workbench.js's appendFinalText) into a jsPDF document.
 */
export async function buildReportPdf(bubble, { title } = {}) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const cursor = {
    y: MARGIN,
    ensureSpace(height) {
      if (this.y + height > PAGE_HEIGHT - MARGIN) {
        doc.addPage();
        this.y = MARGIN;
      }
    },
  };

  if (title) {
    doc.setFont("helvetica", "bold");
    doc.setFontSize(16);
    doc.text(title, MARGIN, cursor.y + 12);
    cursor.y += 28;
  }

  for (const node of bubble.childNodes) {
    await renderBlock(doc, cursor, node, MARGIN, CONTENT_WIDTH);
  }

  return doc;
}

// ---- zip bundle: report + datasets + every executed script -----------

function scriptFilename(call, index) {
  const ext = call.name === "run_r" ? "r" : "py";
  const slug = (call.description || call.name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40) || "script";
  return `scripts/${String(index + 1).padStart(2, "0")}_${call.name}_${slug}.${ext}`;
}

/**
 * @param {Uint8Array} pdfBytes
 * @param {Array<{name: string, bytes: ArrayBuffer}>} datasets - every
 *   dataset currently in OPFS (workbench.js already knows how to list/
 *   read these — datasets.js)
 * @param {Array<{name: string, description?: string, code?: string}>} scripts
 *   - tools.js's executedCalls log: every run_python/run_r call made this
 *   session, in the order they ran
 * @param {Array<{id: string, spec: object}>} [charts] - render_chart specs
 *   (renderStore), written as reproducible Vega-Lite JSON alongside their
 *   already-rasterized image in the PDF (plan §4.5, "ship both")
 * @returns {Uint8Array} zip file bytes
 */
export function buildReportZip({ pdfBytes, datasets, scripts, charts = [] }) {
  const files = { "report.pdf": pdfBytes };

  for (const { name, bytes } of datasets) {
    files[`data/${name}`] = new Uint8Array(bytes);
  }

  scripts.forEach((call, i) => {
    if (!call.code) return;
    const header = `# ${call.description || call.name}\n\n`;
    files[scriptFilename(call, i)] = strToU8(header + call.code + "\n");
  });

  for (const { id, spec } of charts) {
    files[`charts/${id}.vl.json`] = strToU8(JSON.stringify(spec, null, 2) + "\n");
  }

  return zipSync(files, { level: 6 });
}
