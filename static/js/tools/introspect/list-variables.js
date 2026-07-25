// list_variables (plan §3, resolved-yes in §9) — what's live in the
// persistent Python/R session namespace: variable names, types, and shapes,
// but never values. Unlike the fs/ tools this genuinely needs the engine
// (the namespace lives inside the Pyodide worker / webR session), so it
// delegates to the runtime modules' introspection helpers. Two reasons it
// earns that plumbing (over the model running dir()/ls() itself): the
// payload is structured and value-free by construction (a model-authored
// str(df) could dump cells), and it kills the most common wasted turn —
// reloading a dataset that's already in memory.

import { defineTool } from "../registry.js";
import { listPythonVariables } from "../runtime/python.js";
import { listRVariables } from "../runtime/r.js";

export const listVariablesTool = defineTool({
  name: "list_variables",
  handler: async (args) => {
    const engine = args?.engine === "r" ? "r" : "python";
    if (engine === "r") {
      const { ready, variables } = await listRVariables();
      if (!ready) {
        return {
          ok: true,
          engine,
          variables: [],
          note: "The R (webR) session hasn't started yet, so no R variables exist. Run some run_r code first.",
        };
      }
      return { ok: true, engine, variables };
    }
    const { variables } = await listPythonVariables();
    return { ok: true, engine, variables };
  },
  schema: {
    type: "function",
    function: {
      name: "list_variables",
      description:
        "List the variables currently live in the persistent session " +
        "namespace — their names, types, and shapes (e.g. a DataFrame's " +
        "row/column counts), but no values. Use it to check what you've " +
        "already loaded or computed before reloading a dataset or " +
        "recomputing — variables persist across run_python (and run_r) " +
        "calls within a session. Defaults to the Python namespace.",
      parameters: {
        type: "object",
        properties: {
          engine: {
            type: "string",
            enum: ["python", "r"],
            description: "Which session to inspect (default \"python\").",
          },
        },
        required: [],
      },
    },
  },
});
