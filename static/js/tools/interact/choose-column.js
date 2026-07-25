// choose_column (plans/human-in-the-loop-tools.md §4) — a specialized
// ask_choice for disambiguating which column fills a given role (subject
// id, treatment arm, ...), tying directly to the system prompt's
// entity-reconstruction guidance (agent/prompts.py step 1).

import { defineTool } from "../registry.js";

export const chooseColumnTool = defineTool({
  name: "choose_column",
  handler: async (args, ctx) => {
    const purpose = String(args?.purpose ?? "").trim();
    const candidates = Array.isArray(args?.candidates) ? args.candidates.map(String).filter(Boolean) : [];
    if (!purpose || candidates.length < 2) {
      return { ok: false, error: "choose_column needs a `purpose` and at least two `candidates`." };
    }

    const res = await ctx.requestInput({
      kind: "choice",
      title: `Which column is the ${purpose}?`,
      question: `Select the column that represents "${purpose}".`,
      options: candidates,
    });
    const chosen = res.answered
      ? (Array.isArray(res.value) ? res.value : [res.value]).find((v) => candidates.includes(v)) ?? null
      : null;
    return {
      ok: true,
      rendered: true,
      answered: res.answered,
      column: chosen,
      reason: res.answered ? undefined : res.reason,
    };
  },
  schema: {
    type: "function",
    function: {
      name: "choose_column",
      description:
        "Ask the user which column represents a given role (e.g. subject " +
        "id, treatment arm) when several candidate column names could " +
        "plausibly be it. A specialized ask_choice for this exact case — " +
        "prefer it over ask_choice when disambiguating a column. Use " +
        "rarely; if one candidate is the obvious fit, use it and say so " +
        "instead of asking.",
      parameters: {
        type: "object",
        properties: {
          purpose: {
            type: "string",
            description: "What role the column should fill (e.g. \"treatment arm\").",
          },
          candidates: {
            type: "array",
            items: { type: "string" },
            description: "The candidate column names (at least two).",
          },
        },
        required: ["purpose", "candidates"],
      },
    },
  },
});
