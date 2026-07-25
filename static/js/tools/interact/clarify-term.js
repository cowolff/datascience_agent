// clarify_term (plans/human-in-the-loop-tools.md §4) — a specialized
// ask_user for the single most common HITL need: "what does this specific
// term/column/code mean?" A tuned schema/label steers the model toward
// asking sharp, specific questions rather than vague ones, and the card
// renders with a "Define: <term>" heading instead of a generic "Question."

import { defineTool } from "../registry.js";

export const clarifyTermTool = defineTool({
  name: "clarify_term",
  handler: async (args, ctx) => {
    const term = String(args?.term ?? "").trim();
    if (!term) return { ok: false, error: "clarify_term needs a non-empty `term`." };

    const res = await ctx.requestInput({
      kind: "text",
      title: `Define: "${term}"`,
      question: args?.why ? `${args.why} What does "${term}" mean in this dataset?` : `What does "${term}" mean in this dataset?`,
      why: args?.why,
    });
    return {
      ok: true,
      rendered: true,
      answered: res.answered,
      definition: res.answered ? String(res.value ?? "") : null,
      reason: res.answered ? undefined : res.reason,
    };
  },
  schema: {
    type: "function",
    function: {
      name: "clarify_term",
      description:
        "Ask the user what a specific domain term, column name, or code " +
        "means when it's genuinely ambiguous and the answer changes your " +
        "result (e.g. whether \"CD-ratio\" is CD4/CD8 or CD8/CD4). A " +
        "specialized ask_user for this exact case — prefer it over ask_user " +
        "when the question is specifically \"what does X mean.\" Use " +
        "rarely; if there's a standard/obvious reading, state it and " +
        "proceed instead.",
      parameters: {
        type: "object",
        properties: {
          term: { type: "string", description: "The exact term/column/code to clarify." },
          why: { type: "string", description: "Why the meaning matters for your result." },
        },
        required: ["term"],
      },
    },
  },
});
