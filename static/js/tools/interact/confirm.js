// confirm (plans/human-in-the-loop-tools.md §4) — the yes/no HITL
// primitive: check before a consequential-but-not-obvious analysis choice
// (e.g. dropping rows). Advisory only — no tool call in this app has an
// irreversible side effect, so this isn't a permission gate, just a way to
// surface a judgment call instead of silently deciding it. DOM-free, same
// pattern as ask-user.js — see that file's header for the shared notes on
// `rendered: true` and why there's no eval mirror.

import { defineTool } from "../registry.js";

export const confirmTool = defineTool({
  name: "confirm",
  handler: async (args, ctx) => {
    const question = String(args?.question ?? "").trim();
    if (!question) return { ok: false, error: "confirm needs a non-empty `question`." };

    const res = await ctx.requestInput({ kind: "confirm", question, why: args?.detail });
    return {
      ok: true,
      rendered: true,
      answered: res.answered,
      confirmed: res.answered ? Boolean(res.value) : null,
      reason: res.answered ? undefined : res.reason,
    };
  },
  schema: {
    type: "function",
    function: {
      name: "confirm",
      description:
        "Ask the user to confirm a consequential analysis choice before " +
        "you make it (e.g. \"exclude the 12 rows with a missing outcome?\") " +
        "— not a safety gate (no tool call here has an irreversible side " +
        "effect), just a check for a choice with no obviously-correct " +
        "default. Pauses for a real yes/no. Use rarely; if there's a " +
        "reasonable default, state it and proceed instead of asking. The " +
        "user can decline (`answered: false`), in which case fall back to " +
        "your best judgment and say so.",
      parameters: {
        type: "object",
        properties: {
          question: { type: "string", description: "The yes/no question." },
          detail: {
            type: "string",
            description: "Extra context shown alongside the question (e.g. row counts affected).",
          },
        },
        required: ["question"],
      },
    },
  },
});
