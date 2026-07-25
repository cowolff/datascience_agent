// The Python execution engine (Pyodide) as a registered tool. Owns the
// Pyodide Worker and turns its postMessage RPC into a promise-based
// handler — the in-browser tool dispatch from plan §3.4 (main thread ->
// worker, no network hop, no server involvement). Migrated verbatim from
// the old monolithic tools.js; the only behavior change is that sanitize()
// is no longer applied here — the registry (registry.js) now scrubs every
// tool's text output centrally.

import { defineTool } from "../registry.js";
import { loadedFiles } from "../shared/files.js";

let worker = null;
let nextId = 1;
const pending = new Map();
let onStatusChange = () => {};

/** Subscribe to Python-environment load status: "loading" | "ready" | "error". */
export function onPythonStatus(callback) {
  onStatusChange = callback;
}

function ensureWorker() {
  if (worker) return worker;
  worker = new Worker("/static/js/pyodide-worker.js");
  worker.onmessage = (event) => {
    const { id, event: statusEvent, status, message, error, result } = event.data;

    if (statusEvent === "status") {
      onStatusChange(status, message);
      return;
    }

    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    if (error) {
      entry.reject(new Error(error));
      return;
    }
    entry.resolve(result);
  };
  worker.onerror = (event) => {
    // A worker-level failure (e.g. a syntax error) has no request id to
    // match — reject everything still outstanding rather than hang forever.
    for (const [id, entry] of pending) {
      entry.reject(new Error(`Worker error: ${event.message}`));
      pending.delete(id);
    }
  };
  return worker;
}

function send(name, args) {
  const w = ensureWorker();
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    w.postMessage({ id, name, args });
  });
}

/** Writes file bytes into the Pyodide worker's virtual filesystem at
 * /data/<filename>, and records them in the shared loadedFiles map so the
 * webR runtime can replay them lazily on its first run_r call. */
export function loadFile(filename, arrayBuffer) {
  loadedFiles.set(filename, arrayBuffer);
  return send("load_file", { filename, bytes: arrayBuffer });
}

/** Names/types/shapes of user variables in the persistent Python namespace
 * (no values) — the list_variables tool's Python backend. */
export function listPythonVariables() {
  return send("list_globals", {});
}

export const runPythonTool = defineTool({
  name: "run_python",
  handler: (args) => send("run_python", args),
  schema: {
    type: "function",
    function: {
      name: "run_python",
      description: (
        "Execute Python code in a persistent in-browser environment " +
        "(Pyodide, with pandas, numpy, scipy, statsmodels, pingouin, " +
        "matplotlib, and openpyxl available). Variables and imports from " +
        "earlier run_python calls remain available in later calls within " +
        "this session — you don't need to reload data you already " +
        "loaded. Uploaded files live under /data/ — list that directory " +
        "first (e.g. os.listdir('/data')) to find the actual filename(s) " +
        "rather than assuming a name or format: files may be .csv, .tsv, " +
        ".json, or .xlsx, and pandas reads any of them (pd.read_csv, " +
        "pd.read_excel, ...) once you know which one is actually there. " +
        "Any matplotlib figure left open when the call finishes (e.g. " +
        "after plt.plot(...)/plt.hist(...)) is automatically captured — " +
        "no need to call plt.show() or savefig() yourself. Returns " +
        "combined stdout/stderr as text plus, when a figure was " +
        "captured, an `imageIds` list (e.g. [\"plot-3\"]); embed one in " +
        "your final Markdown answer with normal image syntax using that " +
        "id as the URL, e.g. ![CD4/CD8 boxplot by arm](plot-3) — that's " +
        "how a plot actually gets shown to the user, not just mentioned " +
        "in prose. Prefer printing numeric summaries over plotting a " +
        "hidden/masked column, since plot pixels are not scrubbed by " +
        "masking the way printed text is."
      ),
      parameters: {
        type: "object",
        properties: {
          description: {
            type: "string",
            description: (
              "A short, plain-language summary of what this call does " +
              "(e.g. \"Loading the dataset and checking for missing " +
              "values\"). Shown to the user by default in place of the " +
              "code itself, so write it for a reader who won't see the " +
              "code — not a code comment."
            ),
          },
          code: { type: "string", description: "Python source to execute." },
        },
        required: ["description", "code"],
      },
    },
  },
});
