// ask_choice (plans/human-in-the-loop-tools.md §4) — the disambiguation
// HITL primitive: pick one (or, with allow_multiple, several) of a specific
// set of options, e.g. "which column is the treatment arm?" DOM-free, same
// pattern as ask-user.js — see that file's header for the shared notes on
// `rendered: true` and why there's no eval mirror.

import { defineTool } from "../registry.js";

export const askChoiceTool = defineTool({
  name: "ask_choice",
  handler: async (args, ctx) => {
    const question = String(args?.question ?? "").trim();
    const options = Array.isArray(args?.options) ? args.options.map(String).filter(Boolean) : [];
    if (!question || options.length < 2) {
      return { ok: false, error: "ask_choice needs a `question` and at least two `options`." };
    }
    const allowMultiple = Boolean(args?.allow_multiple);

    const res = await ctx.requestInput({ kind: "choice", question, options, allowMultiple, why: args?.why });
    // Defensive: only ever report options that were actually offered, even
    // if a future/misbehaving provider returned something else.
    const selected = res.answered
      ? (Array.isArray(res.value) ? res.value : [res.value]).filter((v) => options.includes(v))
      : [];
    return {
      ok: true,
      rendered: true,
      answered: res.answered,
      selected,
      reason: res.answered ? undefined : res.reason,
    };
  },
  schema: {
    type: "function",
    function: {
      name: "ask_choice",
      description:
        "Ask the user to pick from a specific set of options when the " +
        "data can't disambiguate on its own (e.g. \"which column is the " +
        "treatment arm — arm, treatment, or group?\"). Pauses for a real " +
        "answer; use rarely, only for a genuinely ambiguous and material " +
        "choice. The user can decline (`answered: false`), in which case " +
        "fall back to your best judgment and say so.",
      parameters: {
        type: "object",
        properties: {
          question: { type: "string", description: "The question, naming what the choice is for." },
          options: {
            type: "array",
            items: { type: "string" },
            description: "The candidate options to choose from (at least two).",
          },
          allow_multiple: {
            type: "boolean",
            description: "Allow selecting more than one option (default false).",
          },
          why: { type: "string", description: "One short sentence on why this matters, shown to the user." },
        },
        required: ["question", "options"],
      },
    },
  },
});
