// The R execution engine (webR) as a registered tool. The actual webR
// plumbing (lazy load, FS seeding, plot capture) lives in r-runtime.js —
// this module just adapts it into a defineTool() and re-exports the status
// subscription. Migrated from the old monolithic tools.js; sanitize() is no
// longer applied here — the registry scrubs text output centrally now.

import { defineTool } from "../registry.js";
import { runR, onRStatus, listRVariables as listRVariablesImpl } from "../../r-runtime.js";
import { loadedFiles } from "../shared/files.js";

export { onRStatus };

/** list_variables' R backend — binds the shared loadedFiles so the caller
 * (the tool) doesn't have to thread it through. */
export function listRVariables() {
  return listRVariablesImpl(loadedFiles);
}

export const runRTool = defineTool({
  name: "run_r",
  handler: (args) => runR(String(args?.code ?? ""), loadedFiles),
  schema: {
    type: "function",
    function: {
      name: "run_r",
      description: (
        "Execute R code in a persistent in-browser environment (webR). " +
        "Variables from earlier run_r calls remain available in later " +
        "calls within this session. Uploaded files live under /data/ — " +
        "list that directory first (e.g. list.files('/data')) to find " +
        "the actual filename(s) rather than assuming a name or format: " +
        "files may be .csv, .tsv, .json, or .xlsx. Base R reads .csv " +
        "directly; other formats need a package installed first via " +
        "webr::install('pkgname') (e.g. readxl for .xlsx) before " +
        "library() will find them, same as any other package. Returns " +
        "combined stdout/stderr as text plus, for any plot(s) drawn, an " +
        "`imageIds` list (e.g. [\"plot-3\"]); embed one in your final " +
        "Markdown answer with normal image syntax using that id as the " +
        "URL, e.g. ![CD4/CD8 boxplot by arm](plot-3) — that's how a plot " +
        "actually gets shown to the user, not just mentioned in prose. " +
        "Prefer printing numeric summaries over plotting a hidden/masked " +
        "column, since plot pixels are not scrubbed by masking the way " +
        "printed text is."
      ),
      parameters: {
        type: "object",
        properties: {
          description: {
            type: "string",
            description: (
              "A short, plain-language summary of what this call does " +
              "(e.g. \"Fitting a mixed-effects model for the CD4/CD8 " +
              "ratio\"). Shown to the user by default in place of the " +
              "code itself, so write it for a reader who won't see the " +
              "code — not a code comment."
            ),
          },
          code: { type: "string", description: "R source to execute." },
        },
        required: ["description", "code"],
      },
    },
  },
});
