// get_file_tree (plan §3) — a structured listing of the files the code can
// actually use (everything loaded into the engines' /data, mirrored in
// tools/shared/files.js), plus each tabular file's row/column counts already
// computed at load time (dataset-meta.js). Saves the model an exploratory
// run_python("os.listdir('/data')") turn, and returns a shape it can trust
// rather than free-form directory text. Main-thread, no worker hop.

import { defineTool } from "../registry.js";
import { loadedFiles } from "../shared/files.js";
import { getDatasetShape } from "../../dataset-meta.js";
import { extOf } from "./util.js";

export const getFileTreeTool = defineTool({
  name: "get_file_tree",
  handler: () => {
    const files = [...loadedFiles.entries()].map(([name, bytes]) => {
      const shape = getDatasetShape(name);
      return {
        name,
        ext: extOf(name),
        sizeBytes: bytes.byteLength,
        rows: shape?.rows ?? null,
        cols: shape?.cols ?? null,
      };
    });
    return { ok: true, root: "/data", fileCount: files.length, files };
  },
  schema: {
    type: "function",
    function: {
      name: "get_file_tree",
      description:
        "List the datasets currently available to run_python/run_r under " +
        "/data, with each file's extension, byte size, and (for tabular " +
        "files) row and column counts. Call this to discover the actual " +
        "filename(s) and shape before writing code, instead of guessing a " +
        "name or running os.listdir yourself. Returns structured data, not " +
        "directory text. A file with rows/cols = null is loaded but not a " +
        "type parsed client-side (e.g. .xlsx) — read it with run_python.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
});
