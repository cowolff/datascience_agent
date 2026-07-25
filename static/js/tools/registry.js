// The tool registry (plan §2 of plans/tool-expansion-and-visualization.md).
// One contract — defineTool — per tool; buildRegistry() assembles the two
// things the agent loop actually needs (the schema array offered to the
// model, and the name->handler dispatch it calls) and wraps every handler
// so the shared concerns — masking (sanitize), plot registration, and the
// session call log — happen once, centrally, instead of being re-derived
// per tool the way the old monolithic tools.js did.
//
// This module is deliberately free of any browser/engine dependency (no
// Worker, no CDN import, no DOM), so it's unit-testable in plain Node —
// see registry.test.mjs.

export function defineTool(def) {
  if (!def || typeof def.name !== "string" || !def.name) {
    throw new Error("defineTool: a tool needs a non-empty string `name`");
  }
  if (def.schema?.function?.name !== def.name) {
    throw new Error(
      `defineTool(${def.name}): schema.function.name must equal the tool name`
    );
  }
  if (typeof def.handler !== "function") {
    throw new Error(`defineTool(${def.name}): needs a "handler" function`);
  }
  // rendersOutput: true marks a tool whose heavy payload is UI (charts,
  // tables) rather than model-facing text — the loop strips that payload
  // before it reaches the model, same as `images` are stripped today. No
  // current tool sets it; it's the seam the render tools (§4) plug into.
  return { rendersOutput: false, ...def };
}

/**
 * @param {Array<ReturnType<typeof defineTool>>} tools
 * @param {{ sanitize:(s:string)=>string, registerPlots:(r:any,code?:string)=>any, recordCall:(name:string,args:any)=>void }} ctx
 */
export function buildRegistry(tools, ctx) {
  const byName = new Map();
  const schemas = [];
  for (const tool of tools) {
    if (byName.has(tool.name)) throw new Error(`duplicate tool name: ${tool.name}`);
    byName.set(tool.name, tool);
    schemas.push(tool.schema);
  }

  async function callTool(name, args) {
    // Logged before dispatch so a failing call still appears in the export.
    ctx.recordCall(name, args);

    const tool = byName.get(name);
    if (!tool) throw new Error(`Unknown tool '${name}'.`);

    let result = await tool.handler(args, ctx);

    // Masking choke point (plan §3.3/§5): every text output scrubbed once,
    // here, so a new tool physically can't forget to. Non-text fields
    // (e.g. `images`) are left untouched — sanitize only handles text.
    if (result && typeof result.output === "string") {
      result = { ...result, output: ctx.sanitize(result.output) };
    }

    // The same imageIds/plotStore bridge every plot-producing tool shares.
    return ctx.registerPlots(result, args?.code);
  }

  return { schemas, callTool, byName };
}
