// Provider wire-format adapters (plan §3.6). Two families, confirmed
// sufficient in Phase 1/2 against the real Mistral API:
//   - "openai": Mistral, OpenAI itself, and any "OpenAI-compatible" server
//     (Ollama's /v1 compat endpoint, LM Studio, vLLM, text-generation-webui).
//     Our internal message/tool representation (used throughout
//     agent-loop.js) already *is* this shape, so this adapter is close to a
//     pass-through.
//   - "anthropic": top-level `system`, content-block messages, `tool_use`/
//     `tool_result` blocks instead of a flat `tool_calls` array. The one
//     family genuinely different enough to need real translation both ways.
//
// Each adapter exposes: url(baseUrl), headers(apiKey), buildBody(messages,
// tools, model), parseResponse(data) -> our internal {choices:[{message}]}
// shape. provider.js is the only caller.

function stripTrailingSlash(url) {
  return url.replace(/\/+$/, "");
}

const openaiAdapter = {
  url(baseUrl) {
    return `${stripTrailingSlash(baseUrl)}/chat/completions`;
  },
  headers(apiKey) {
    return {
      "Content-Type": "application/json",
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    };
  },
  buildBody(messages, tools, model) {
    const body = { model, messages };
    if (tools?.length) {
      body.tools = tools;
      body.tool_choice = "auto";
    }
    return body;
  },
  // Already our internal shape (plan §3.6's whole point in picking this as
  // the majority-case adapter) — nothing to translate.
  parseResponse(data) {
    return data;
  },
};

const ANTHROPIC_VERSION = "2023-06-01";
// Anthropic's API refuses direct browser calls (no Access-Control-Allow-*
// handling for a bare API-key request) unless this header opts in — the
// documented way SDKs expose as `dangerouslyAllowBrowser`. Custom-endpoint
// mode *is* exactly that: the user's own key, sent straight from their own
// browser, at their own request — so it's the right call here, not a
// generic safety compromise.
const ANTHROPIC_BROWSER_HEADER = "anthropic-dangerous-direct-browser-access";
const ANTHROPIC_MAX_TOKENS = 4096;

function toAnthropicTools(tools) {
  return (tools || []).map((t) => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters,
  }));
}

/**
 * Translates our internal OpenAI-shaped message list into Anthropic's
 * {system, messages} shape. The one non-obvious step: our agent loop pushes
 * one `role: "tool"` message per tool call when a single assistant turn
 * makes several — naively mapping each to its own `{role:"user", ...}`
 * message would produce consecutive user-role messages, which Anthropic's
 * API rejects (it requires strict user/assistant alternation). Fixed by
 * merging consecutive same-role messages' content blocks afterward.
 */
function toAnthropicMessages(messages) {
  let system = "";
  const out = [];

  for (const m of messages) {
    if (m.role === "system") {
      system += (system ? "\n\n" : "") + m.content;
    } else if (m.role === "user") {
      out.push({ role: "user", content: m.content ?? "" });
    } else if (m.role === "assistant") {
      const blocks = [];
      if (m.content) blocks.push({ type: "text", text: m.content });
      for (const call of m.tool_calls || []) {
        let input = {};
        try {
          input = JSON.parse(call.function?.arguments || "{}");
        } catch {
          // malformed arguments from the model itself — send an empty
          // input rather than failing the whole translation
        }
        blocks.push({ type: "tool_use", id: call.id, name: call.function?.name, input });
      }
      out.push({ role: "assistant", content: blocks.length ? blocks : m.content || "" });
    } else if (m.role === "tool") {
      out.push({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: m.tool_call_id, content: m.content }],
      });
    }
  }

  const merged = [];
  for (const m of out) {
    const prev = merged[merged.length - 1];
    if (prev && prev.role === m.role) {
      const prevBlocks = Array.isArray(prev.content) ? prev.content : [{ type: "text", text: prev.content }];
      const curBlocks = Array.isArray(m.content) ? m.content : [{ type: "text", text: m.content }];
      prev.content = [...prevBlocks, ...curBlocks];
    } else {
      merged.push({ ...m });
    }
  }
  return { system, messages: merged };
}

const anthropicAdapter = {
  url(baseUrl) {
    return `${stripTrailingSlash(baseUrl)}/v1/messages`;
  },
  headers(apiKey) {
    return {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
      [ANTHROPIC_BROWSER_HEADER]: "true",
    };
  },
  buildBody(messages, tools, model) {
    const { system, messages: anthMessages } = toAnthropicMessages(messages);
    const body = { model, max_tokens: ANTHROPIC_MAX_TOKENS, messages: anthMessages };
    if (system) body.system = system;
    if (tools?.length) body.tools = toAnthropicTools(tools);
    return body;
  },
  /** Anthropic's {content: [...]} response -> our internal
   * {choices: [{message}]} shape agent-loop.js already expects. */
  parseResponse(data) {
    const textParts = [];
    const toolCalls = [];
    for (const block of data.content || []) {
      if (block.type === "text") {
        textParts.push(block.text);
      } else if (block.type === "tool_use") {
        toolCalls.push({
          id: block.id,
          type: "function",
          function: { name: block.name, arguments: JSON.stringify(block.input || {}) },
        });
      }
    }
    const message = { role: "assistant", content: textParts.join("\n") || null };
    if (toolCalls.length) message.tool_calls = toolCalls;
    return { choices: [{ message }], usage: data.usage };
  },
};

export const adapters = { openai: openaiAdapter, anthropic: anthropicAdapter };
