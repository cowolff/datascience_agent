// Real Python execution (plan §3.2) — stands in for the "trivial" Phase 3
// worker, using the exact same {id, name, args} -> {id, result}/{id, error}
// RPC shape so tools.js barely had to change.
//
// TEMPORARY (like the Tailwind CDN note in workbench.html): loads Pyodide
// from jsDelivr's CDN at runtime. Plan §3.2 calls for vendoring these
// wasm/JS assets into the image at build time instead, to keep the deploy
// self-contained — tracked as a pre-deploy TODO alongside the Tailwind CLI
// switch, not done here to keep this phase scoped to "real Python
// execution works," not "asset pipeline is production-ready."
//
// Version pinned (not "latest") for reproducibility — confirmed available
// on jsDelivr, and confirmed (plan §8/Phase 2) to include pandas/numpy in
// its lock file.
importScripts("https://cdn.jsdelivr.net/pyodide/v0.28.0/full/pyodide.js");

const DATA_DIR = "/data";

const pyodideReadyPromise = (async () => {
  const pyodide = await loadPyodide();
  // scipy/statsmodels are, like pandas/numpy, prebuilt in Pyodide's own
  // package repository (confirmed against v0.28.0's pyodide-lock.json), so
  // they load the same fast way rather than via micropip.
  await pyodide.loadPackage(["pandas", "numpy", "scipy", "statsmodels", "matplotlib", "micropip"]);
  // openpyxl and pingouin aren't in Pyodide's own package repository
  // (loadPackage only resolves against that lock file), but both are pure
  // Python, so micropip can pull them from PyPI. Done once here, inside
  // this async boot context, rather than left to agent-authored code —
  // plain exec() in _bench_run below can't run a top-level `await`, so
  // there is no way for a run_python call to install a package itself
  // (see plans/phase9-finding1-openpyxl-async-gap.md for the full
  // investigation). pingouin's own dependencies (scikit-learn, xarray,
  // pandas_flavor, seaborn, tabulate) were checked the same way odfpy
  // should have been last time: scikit-learn and xarray are already in
  // Pyodide's repo, and pandas_flavor/seaborn/tabulate each ship a pure
  // Python wheel on PyPI — micropip resolves all of them automatically.
  // odfpy (ODS support, tried alongside openpyxl previously) was dropped:
  // PyPI has no pure-Python wheel for it, only an sdist, which micropip
  // can't install — confirmed live, it fails the whole install() call
  // (and therefore this entire boot sequence) rather than degrading
  // gracefully.
  await pyodide.runPythonAsync(`
import micropip
await micropip.install(["openpyxl", "pingouin"])
`);

  // A persistent namespace + a stdout/stderr-capturing entry point, defined
  // once. Deliberately persistent across run_python calls within a session
  // (unlike the Phase 1 standalone harness's fresh-subprocess-per-call
  // design) — a Pyodide worker already behaves like a live process, and
  // not re-loading/re-deriving data on every turn is both cheaper and
  // closer to how a real analyst works in a notebook. This is documented
  // in the run_python tool description (tools/runtime/python.js) so the model knows to
  // rely on it, not re-guess it.
  //
  // "Agg" (a headless, non-interactive raster backend) is set before
  // pyplot is ever imported — there's no display in a worker, and this
  // guarantees the backend our own fig.savefig() capture below expects,
  // regardless of whatever backend Pyodide would otherwise have defaulted
  // matplotlib to. Every figure left open when the agent's code finishes
  // is rasterized to a PNG and returned as base64 alongside the text
  // output (mirroring run_r's plot capture in r-runtime.js, which webR
  // gives for free via its own graphics-device capture — matplotlib has
  // no such built-in hook, so this does it by hand), then closed, so a
  // figure never leaks into — or gets returned again by — a later call.
  await pyodide.runPythonAsync(`
import base64, contextlib, io, json, traceback
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

_bench_globals = {}

def _bench_run(code):
    buf = io.StringIO()
    ok = True
    try:
        with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(buf):
            exec(compile(code, "<tool>", "exec"), _bench_globals)
        text = buf.getvalue()
    except Exception:
        text = buf.getvalue() + traceback.format_exc()
        ok = False

    images = []
    try:
        for num in plt.get_fignums():
            img_buf = io.BytesIO()
            plt.figure(num).savefig(img_buf, format="png", bbox_inches="tight")
            images.append(base64.b64encode(img_buf.getvalue()).decode("ascii"))
    finally:
        plt.close("all")

    return json.dumps({"output": text, "images": images, "ok": ok})

def _bench_list_globals():
    # Names + types + shapes of the user-defined variables live in the
    # persistent namespace — the data the list_variables tool reports. No
    # values are included (only structure), and modules/callables are
    # filtered out so the model sees dataframes/arrays it can reuse rather
    # than reload, not import noise.
    import types as _types
    out = []
    for _k, _v in list(_bench_globals.items()):
        if _k.startswith("_"):
            continue
        if isinstance(_v, _types.ModuleType) or callable(_v):
            continue
        entry = {"name": _k, "type": type(_v).__name__}
        _shape = getattr(_v, "shape", None)
        if _shape is not None:
            try:
                entry["shape"] = [int(_d) for _d in _shape]
            except Exception:
                pass
        else:
            try:
                entry["length"] = len(_v)
            except Exception:
                pass
        out.append(entry)
    return json.dumps({"variables": out})
`);

  pyodide.FS.mkdirTree(DATA_DIR);
  return pyodide;
})();

self.postMessage({ event: "status", status: "loading" });
pyodideReadyPromise.then(
  () => self.postMessage({ event: "status", status: "ready" }),
  (err) => self.postMessage({ event: "status", status: "error", message: String(err) })
);

self.onmessage = async (event) => {
  const { id, name, args } = event.data;
  let pyodide;
  try {
    pyodide = await pyodideReadyPromise;
  } catch (err) {
    self.postMessage({ id, error: `Python environment failed to load: ${err}` });
    return;
  }

  try {
    if (name === "run_python") {
      const run = pyodide.globals.get("_bench_run");
      // `ok` (did exec() raise, distinct from an RPC-level `error` above —
      // this is the executed *code* failing, not the worker) is what lets
      // agent-loop.js's failed-attempt pruning (plan: minimize input
      // tokens) tell a traceback apart from a normal successful run.
      const { output, images, ok } = JSON.parse(run(String(args?.code ?? "")));
      const result = { output: output || "(no output)", ok };
      if (images.length > 0) result.images = images.map((b64) => `data:image/png;base64,${b64}`);
      self.postMessage({ id, result });
    } else if (name === "list_globals") {
      const fn = pyodide.globals.get("_bench_list_globals");
      const { variables } = JSON.parse(fn());
      self.postMessage({ id, result: { ok: true, variables } });
    } else if (name === "load_file") {
      const bytes = new Uint8Array(args.bytes);
      const path = `${DATA_DIR}/${args.filename}`;
      pyodide.FS.writeFile(path, bytes);
      self.postMessage({ id, result: { ok: true, path, bytes: bytes.length } });
    } else {
      self.postMessage({ id, error: `Unknown tool '${name}'.` });
    }
  } catch (err) {
    self.postMessage({ id, error: String(err) });
  }
};
