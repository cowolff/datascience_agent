// ask_user (plans/human-in-the-loop-tools.md §4) — the free-text HITL
// primitive: pause and ask the user to clarify something the data can't
// resolve, rather than guessing. DOM-free: it calls ctx.requestInput and
// shapes the result; the actual prompt card lives in render/prompt.js,
// rendered live by workbench.js's requestInput provider while this call is
// still pending (see registry.js/context.js for how ctx is wired, and
// tools/shared/input-provider.js for the bridge).
//
// `rendered: true` on the result tells finishToolTrace (workbench.js) that
// the Q&A UI was already rendered live into the tool-trace card while this
// call was pending — it must not also dump the raw result JSON below it.
//
// No eval mirror in agent/tools.py: the standalone harness has no UI to
// ask a human through, so this tool isn't offered there at all (the
// sibling tool-expansion plan's §2.3 "only mirror what's exercised" rule).
// The browser eval harness disables HITL outright (see
// eval/browser_harness.py) so a headless run can't hang waiting on one.

import { defineTool } from "../registry.js";

export const askUserTool = defineTool({
  name: "ask_user",
  handler: async (args, ctx) => {
    const question = String(args?.question ?? "").trim();
    if (!question) return { ok: false, error: "ask_user needs a non-empty `question`." };

    const res = await ctx.requestInput({ kind: "text", question, why: args?.why });
    return {
      ok: true,
      rendered: true,
      answered: res.answered,
      answer: res.answered ? String(res.value ?? "") : null,
      reason: res.answered ? undefined : res.reason,
    };
  },
  schema: {
    type: "function",
    function: {
      name: "ask_user",
      description:
        "Ask the user a free-text clarifying question when something " +
        "genuinely ambiguous would change your result and the data itself " +
        "can't resolve it (e.g. what a column or code means, which of two " +
        "readings of a term is intended). This pauses for a real answer — " +
        "use it rarely, only when the point is both ambiguous and " +
        "material; otherwise state your assumption in your answer and " +
        "proceed as usual. The user can also decline to answer, in which " +
        "case `answered` is false and you should fall back to your best " +
        "judgment and say so.",
      parameters: {
        type: "object",
        properties: {
          question: { type: "string", description: "The specific question to ask." },
          why: {
            type: "string",
            description:
              "One short sentence on why this matters for your result — " +
              "shown to the user alongside the question.",
          },
        },
        required: ["question"],
      },
    },
  },
});
