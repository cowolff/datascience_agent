// confirm_exclusion (plans/human-in-the-loop-tools.md §4) — a specialized
// confirm for the "drop these rows?" decision, surfacing the row count
// alongside the description so the user sees the actual stakes.

import { defineTool } from "../registry.js";

export const confirmExclusionTool = defineTool({
  name: "confirm_exclusion",
  handler: async (args, ctx) => {
    const description = String(args?.description ?? "").trim();
    if (!description) return { ok: false, error: "confirm_exclusion needs a non-empty `description`." };
    const nRows = Number.isFinite(args?.n_rows) ? args.n_rows : null;

    const question = nRows !== null
      ? `${description} (excludes ${nRows} row${nRows === 1 ? "" : "s"})`
      : description;
    const res = await ctx.requestInput({ kind: "confirm", title: "Confirm exclusion", question });
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
      name: "confirm_exclusion",
      description:
        "Ask the user to confirm dropping a specific set of rows before you " +
        "exclude them (e.g. rows missing the outcome). A specialized " +
        "confirm for this exact case, surfacing the row count. Use rarely " +
        "— if the exclusion is a standard, well-justified one, state it " +
        "and proceed instead of asking.",
      parameters: {
        type: "object",
        properties: {
          description: {
            type: "string",
            description: "What's being excluded and why (e.g. \"drop rows with a missing outcome\").",
          },
          n_rows: { type: "integer", description: "How many rows this excludes." },
        },
        required: ["description"],
      },
    },
  },
});
