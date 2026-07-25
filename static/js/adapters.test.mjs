import { test } from "node:test";
import assert from "node:assert/strict";
import { adapters } from "./adapters.js";

test("openai adapter: url strips trailing slash and appends /chat/completions", () => {
  assert.equal(adapters.openai.url("https://api.openai.com/v1/"), "https://api.openai.com/v1/chat/completions");
  assert.equal(adapters.openai.url("https://api.openai.com/v1"), "https://api.openai.com/v1/chat/completions");
});

test("openai adapter: buildBody passes messages/model through and sets tool_choice only when tools given", () => {
  const messages = [{ role: "user", content: "hi" }];
  const withoutTools = adapters.openai.buildBody(messages, [], "gpt-4o-mini");
  assert.equal(withoutTools.tool_choice, undefined);
  assert.deepEqual(withoutTools.messages, messages);

  const tools = [{ type: "function", function: { name: "run_python", parameters: {} } }];
  const withTools = adapters.openai.buildBody(messages, tools, "gpt-4o-mini");
  assert.equal(withTools.tool_choice, "auto");
  assert.deepEqual(withTools.tools, tools);
});

test("openai adapter: parseResponse is a pass-through (already our internal shape)", () => {
  const data = { choices: [{ message: { role: "assistant", content: "hi" } }] };
  assert.equal(adapters.openai.parseResponse(data), data);
});

test("anthropic adapter: url appends /v1/messages", () => {
  assert.equal(adapters.anthropic.url("https://api.anthropic.com"), "https://api.anthropic.com/v1/messages");
});

test("anthropic adapter: headers include the direct-browser-access opt-in and x-api-key", () => {
  const headers = adapters.anthropic.headers("sk-ant-test");
  assert.equal(headers["x-api-key"], "sk-ant-test");
  assert.equal(headers["anthropic-dangerous-direct-browser-access"], "true");
  assert.ok(headers["anthropic-version"]);
});

test("anthropic adapter: buildBody pulls the system message out to the top level", () => {
  const messages = [
    { role: "system", content: "You are a helpful assistant." },
    { role: "user", content: "hi" },
  ];
  const body = adapters.anthropic.buildBody(messages, [], "claude-sonnet-5");
  assert.equal(body.system, "You are a helpful assistant.");
  assert.deepEqual(body.messages, [{ role: "user", content: "hi" }]);
  assert.ok(body.max_tokens > 0);
});

test("anthropic adapter: buildBody converts our tool schema to input_schema", () => {
  const tools = [
    { type: "function", function: { name: "run_python", description: "runs code", parameters: { type: "object" } } },
  ];
  const body = adapters.anthropic.buildBody([{ role: "user", content: "hi" }], tools, "claude-sonnet-5");
  assert.deepEqual(body.tools, [{ name: "run_python", description: "runs code", input_schema: { type: "object" } }]);
});

test("anthropic adapter: buildBody converts an assistant tool_calls message into a tool_use content block", () => {
  const messages = [
    { role: "user", content: "run some code" },
    {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "call_1", type: "function", function: { name: "run_python", arguments: '{"code":"1+1"}' } }],
    },
  ];
  const body = adapters.anthropic.buildBody(messages, [], "claude-sonnet-5");
  const assistantMsg = body.messages[1];
  assert.equal(assistantMsg.role, "assistant");
  assert.deepEqual(assistantMsg.content, [{ type: "tool_use", id: "call_1", name: "run_python", input: { code: "1+1" } }]);
});

test("anthropic adapter: buildBody converts a tool-role message into a user tool_result block", () => {
  const messages = [{ role: "tool", tool_call_id: "call_1", name: "run_python", content: '{"output":"2"}' }];
  const body = adapters.anthropic.buildBody(messages, [], "claude-sonnet-5");
  assert.deepEqual(body.messages, [
    { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: '{"output":"2"}' }] },
  ]);
});

test("anthropic adapter: buildBody merges consecutive tool-role messages into one user message (Anthropic requires strict role alternation)", () => {
  const messages = [
    { role: "user", content: "run two things" },
    {
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "call_1", type: "function", function: { name: "run_python", arguments: "{}" } },
        { id: "call_2", type: "function", function: { name: "run_r", arguments: "{}" } },
      ],
    },
    { role: "tool", tool_call_id: "call_1", name: "run_python", content: '{"output":"a"}' },
    { role: "tool", tool_call_id: "call_2", name: "run_r", content: '{"output":"b"}' },
  ];
  const body = adapters.anthropic.buildBody(messages, [], "claude-sonnet-5");
  // user, assistant, then exactly ONE merged user message with both tool_results
  assert.equal(body.messages.length, 3);
  const merged = body.messages[2];
  assert.equal(merged.role, "user");
  assert.equal(merged.content.length, 2);
  assert.deepEqual(merged.content[0], { type: "tool_result", tool_use_id: "call_1", content: '{"output":"a"}' });
  assert.deepEqual(merged.content[1], { type: "tool_result", tool_use_id: "call_2", content: '{"output":"b"}' });
});

test("anthropic adapter: parseResponse converts content blocks into our {choices:[{message}]} shape", () => {
  const data = {
    content: [
      { type: "text", text: "The answer is 42." },
      { type: "tool_use", id: "toolu_1", name: "run_python", input: { code: "40+2" } },
    ],
    usage: { input_tokens: 10, output_tokens: 5 },
  };
  const result = adapters.anthropic.parseResponse(data);
  const message = result.choices[0].message;
  assert.equal(message.content, "The answer is 42.");
  assert.deepEqual(message.tool_calls, [
    { id: "toolu_1", type: "function", function: { name: "run_python", arguments: '{"code":"40+2"}' } },
  ]);
  assert.equal(result.usage, data.usage);
});

test("anthropic adapter: parseResponse with no tool_use blocks omits tool_calls entirely", () => {
  const data = { content: [{ type: "text", text: "hi" }] };
  const message = adapters.anthropic.parseResponse(data).choices[0].message;
  assert.equal(message.tool_calls, undefined);
});
