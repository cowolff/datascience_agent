// Public surface of the tool layer (plan §2.2). Everything outside
// static/js/tools/ imports from here (or, during the transition, the
// back-compat ../tools.js shim which just re-exports this) — never from an
// individual tool module.
//
// `schemas` (the tool definitions offered to the model) and `callTool` (the
// dispatch the agent loop calls) both come out of one buildRegistry() call,
// so registering a new tool is: write its module, add it to the array
// below. Nothing else — masking, plot registration, and the call log are
// applied by the registry, and both prompts.js's old hand-kept `TOOLS`
// array and tools.js's old hand-written `callTool` switch are gone.
//
// Note the split preserved from the old prompts.js: the system *prompt* is
// GEPA-owned and served from agent/prompts.py, but tool *schemas* describe
// this specific client's capabilities and so live with the tool code here.

import { buildRegistry } from "./registry.js";
import { ctx } from "./context.js";
import { runPythonTool, loadFile, onPythonStatus } from "./runtime/python.js";
import { runRTool, onRStatus } from "./runtime/r.js";
import { getFileTreeTool } from "./fs/list-files.js";
import { describeDatasetTool } from "./fs/describe-dataset.js";
import { previewFileTool } from "./fs/preview-file.js";
import { listVariablesTool } from "./introspect/list-variables.js";
import { columnStatsTool } from "./introspect/column-stats.js";
import { renderTableTool } from "./render/render-table.js";
import { renderChartTool } from "./render/render-chart.js";
import { askUserTool } from "./interact/ask-user.js";
import { askChoiceTool } from "./interact/ask-choice.js";
import { confirmTool } from "./interact/confirm.js";
import { clarifyTermTool } from "./interact/clarify-term.js";
import { chooseColumnTool } from "./interact/choose-column.js";
import { confirmExclusionTool } from "./interact/confirm-exclusion.js";

const registry = buildRegistry(
  [
    runPythonTool,
    runRTool,
    getFileTreeTool,
    describeDatasetTool,
    previewFileTool,
    listVariablesTool,
    columnStatsTool,
    renderTableTool,
    renderChartTool,
    askUserTool,
    askChoiceTool,
    confirmTool,
    clarifyTermTool,
    chooseColumnTool,
    confirmExclusionTool,
  ],
  ctx
);

export const schemas = registry.schemas;
export const callTool = registry.callTool;

// Re-exported so page glue (workbench.js) has one import site for the whole
// tool layer.
export { loadFile, onPythonStatus, onRStatus };
export { setDatasetMasking } from "./shared/sanitize.js";
export { plotStore, snapshotPlotStore, restorePlotStore } from "./shared/plot-store.js";
export { renderStore, snapshotRenderStore, restoreRenderStore } from "./shared/render-store.js";
export { executedCalls } from "./shared/call-log.js";
export { setInputProvider } from "./shared/input-provider.js";
