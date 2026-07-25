// Real R execution (plan §3.2/§7 Phase 6) — the second execution engine
// alongside pyodide-worker.js.
//
// Unlike pyodide-worker.js, this file is NOT itself a raw Worker script
// spun up with `new Worker(...)` and talked to over postMessage. The
// `WebR` class already creates and manages its own dedicated worker
// thread internally the moment it's constructed — that's how it keeps R
// execution off the main thread. Wrapping it in a second, nested custom
// Worker would just add a fragile extra postMessage hop for no benefit,
// so this module runs on the main thread and exposes the same shape
// (`runR`, `onRStatus`) tools.js already uses for Python, so the two
// engines are interchangeable from the dispatch side.
//
// Lazy-loaded per plan §8 ("webR's wasm payload is tens of MB — confirm
// acceptable load time, or lazy-load it only when a user actually opens
// an R cell"): nothing in this module downloads or runs anything until
// the first run_r call reaches runR() below.
//
// TEMPORARY (same as the Pyodide CDN note in pyodide-worker.js): loads
// webR from jsDelivr at runtime rather than the vendored-at-build-time
// asset plan §3.2/§4 calls for — tracked as the same pre-deploy
// asset-pipeline TODO as Pyodide. jsDelivr specifically (not
// webr.r-wasm.org directly) because it serves an explicit
// `Access-Control-Allow-Origin: *`, which a cross-origin dynamic
// `import()` from this module needs. Version pinned for reproducibility.
// NOTE: jsDelivr's `dist/webr.mjs` (webR's npm "import"/"default" export
// condition) is a Node-targeted build with static `import ... from 'module'`
// (Node's builtin) — it fails to resolve in a browser. `dist/webr.js` is
// webR's npm "browser" export condition target and the actual browser ESM
// build (confirmed: it's byte-for-byte what webr.r-wasm.org's own
// `webr.mjs` serves) — use that one instead.
const WEBR_VERSION = "0.6.0";
const WEBR_MODULE_URL = `https://cdn.jsdelivr.net/npm/webr@${WEBR_VERSION}/dist/webr.js`;

const DATA_DIR = "/data";

let webRReadyPromise = null;
let onStatusChange = () => {};

/** Subscribe to R-environment load status: "loading" | "ready" | "error". */
export function onRStatus(callback) {
  onStatusChange = callback;
}

function ensureWebR() {
  if (webRReadyPromise) return webRReadyPromise;
  onStatusChange("loading");
  webRReadyPromise = (async () => {
    const { WebR } = await import(WEBR_MODULE_URL);
    const webR = new WebR();
    await webR.init();
    await webR.FS.mkdir(DATA_DIR);
    return webR;
  })();
  webRReadyPromise.then(
    () => onStatusChange("ready"),
    (err) => onStatusChange("error", String(err))
  );
  return webRReadyPromise;
}

/**
 * Writes every currently-known dataset into R's virtual filesystem before
 * a run_r call executes. Always re-writes all of them (not "only what's
 * new") so this stays correct if a dataset is reloaded with different
 * bytes under the same filename — the same guarantee load_file already
 * gives the Pyodide worker on every call, just applied lazily here since
 * (unlike Python) R may not have been touched yet.
 */
async function seedFiles(loadedFiles) {
  const webR = await ensureWebR();
  for (const [name, bytes] of loadedFiles) {
    await webR.FS.writeFile(`${DATA_DIR}/${name}`, new Uint8Array(bytes));
  }
  return webR;
}

async function imageBitmapToDataUrl(bitmap) {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0);
  const blob = await canvas.convertToBlob({ type: "image/png" });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return `data:image/png;base64,${btoa(binary)}`;
}

/**
 * Stream entries (stdout/stderr) arrive as plain strings. Condition
 * entries (message/warning/error, e.g. from `message()`, `warning()`, or
 * `webr::install()`'s own progress messages) arrive as an RObject proxy
 * for the R condition — an R list with a `message` element — which needs
 * an async `.get("message")` + `.toJs()` round trip to pull out as text;
 * `RObject.toJs()` on the condition object itself throws (conditions also
 * carry an unconvertible `call` element), so unwrap just the field we
 * need rather than the whole object.
 */
async function outputEntryToText(entry) {
  if (typeof entry.data === "string") return entry.data;
  if (entry.data && typeof entry.data.get === "function") {
    try {
      const messageObj = await entry.data.get("message");
      const { values } = await messageObj.toJs();
      const text = (Array.isArray(values) ? values.join("") : String(values)).trimEnd();
      return entry.type ? `${entry.type}: ${text}` : text;
    } catch {
      return entry.type ? `[${entry.type} condition]` : "";
    }
  }
  return JSON.stringify(entry.data);
}

/**
 * Runs R code against the persistent global R environment (webR keeps one
 * live session per worker, so assignments from earlier calls stay visible
 * — the same persistence run_python already offers), capturing
 * stdout/stderr/conditions as text and any plot(s) drawn as PNG data URLs.
 *
 * KNOWN LIMITATION, on the same footing as masking.js's documented gap:
 * sanitizeText() only scrubs the returned *text* — it cannot inspect
 * pixels inside a captured plot image, so a plot that draws a masked
 * value (e.g. a boxplot of a hidden column) is not redacted. The run_r
 * tool description (tools/runtime/r.js) steers the model toward printing
 * summaries rather than plotting raw hidden columns, but that is
 * guidance, not an enforced guarantee — same honesty-over-false-safety
 * call as the derived-statistic gap in masking.js.
 */
export async function runR(code, loadedFiles) {
  const webR = await seedFiles(loadedFiles);
  const shelter = await new webR.Shelter();
  try {
    const capture = await shelter.captureR(code, {
      withAutoprint: true,
      captureStreams: true,
      captureConditions: true,
    });
    const textParts = await Promise.all(capture.output.map(outputEntryToText));
    const text = textParts.filter(Boolean).join("\n");
    const images = await Promise.all(capture.images.map(imageBitmapToDataUrl));
    // An uncaught R error surfaces as a captured condition entry (see
    // outputEntryToText above), not a thrown JS exception — this call
    // resolves normally either way. `ok` gives agent-loop.js's failed-
    // attempt pruning (plan: minimize input tokens) a structured signal
    // instead of having to sniff the joined text for an "error:" line.
    const ok = !capture.output.some((entry) => entry.type === "error");
    return { output: text || "(no output)", images, ok };
  } finally {
    await shelter.purge();
  }
}

/**
 * Introspect the persistent R global environment WITHOUT forcing a webR
 * load: if no run_r call has started webR yet (webRReadyPromise is still
 * null), report that instead of paying the tens-of-MB load just to list an
 * empty environment. When it has started, reuse runR() so introspection
 * runs in the same persistent globalenv the user's run_r calls populate.
 * The `local({...})` wrapper keeps the loop's temporaries out of that
 * globalenv (and out of the listing). Returns names/classes/dims only — no
 * values — mirroring the Python side.
 */
export async function listRVariables(loadedFiles) {
  if (!webRReadyPromise) return { ready: false, variables: [] };
  const code = [
    "local({",
    "  for (nm in ls(envir = globalenv())) {",
    "    obj <- get(nm, envir = globalenv())",
    '    d <- tryCatch(paste(dim(obj), collapse = "x"), error = function(e) "")',
    '    cat(nm, "\\t", paste(class(obj), collapse = ","), "\\t", d, "\\n", sep = "")',
    "  }",
    "})",
  ].join("\n");
  const { output } = await runR(code, loadedFiles);
  const variables = output
    .split("\n")
    .map((line) => line.split("\t"))
    .filter((parts) => parts.length === 3 && parts[0])
    .map(([name, type, shape]) => ({ name, type, shape: shape || null }));
  return { ready: true, variables };
}
