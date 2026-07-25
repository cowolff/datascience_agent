// Unit coverage for agent-loop.js's superseded-attempt pruning: once a
// later tool call makes an earlier one moot, the earlier one's assistant
// tool_call + tool-result message are spliced out of `messages` so they
// stop costing input tokens on every later model call in the same turn.
// Two cases share the same removal mechanism (pruneSupersededAttempt):
//   - run_python/run_r: a failed attempt superseded by a later *successful*
//     retry ("write code, see a traceback, fix it, rerun").
//   - list_variables/describe_dataset/get_file_tree/column_stats: a stale
//     snapshot of live state superseded by *any* later call for the same
//     target (SUPERSEDE_ON_REPEAT_KEYS decides what counts as "the same
//     target" per tool).
//
// Only pruneSupersededAttempt() and the SUPERSEDE_ON_REPEAT_KEYS key
// functions are exercised here, not the full runAgent() loop around them —
// runAgent hard-imports callModel/provider.js and callTool/tools.js, and
// mocking those needs node:test's module mocking, which isn't available on
// the Node 20 this project's CI pins (see .github/workflows/ci.yml). Both
// exports here are plain data in, plain data/mutated-array out — fully
// testable without either import.

import { test } from "node:test";
import assert from "node:assert/strict";
import { pruneSupersededAttempt, SUPERSEDE_ON_REPEAT_KEYS } from "./agent-loop.js";

test("removes both messages when the assistant message had only the failed call", () => {
  const call = { id: "call-1", function: { name: "run_python", arguments: "{}" } };
  const assistantMessage = { role: "assistant", content: null, tool_calls: [call] };
  const toolMessage = { role: "tool", tool_call_id: "call-1", name: "run_python", content: "{\"output\":\"Traceback...\",\"ok\":false}" };
  const messages = [
    { role: "system", content: "sys" },
    { role: "user", content: "do it" },
    assistantMessage,
    toolMessage,
  ];

  pruneSupersededAttempt(messages, { assistantMessage, call, toolMessage });

  assert.equal(messages.length, 2);
  assert.deepEqual(messages, [
    { role: "system", content: "sys" },
    { role: "user", content: "do it" },
  ]);
});

test("only removes the failed call when the assistant message bundled other tool_calls", () => {
  const failedCall = { id: "call-1", function: { name: "run_python", arguments: "{}" } };
  const otherCall = { id: "call-2", function: { name: "run_python", arguments: "{}" } };
  const assistantMessage = { role: "assistant", content: null, tool_calls: [failedCall, otherCall] };
  const failedToolMessage = { role: "tool", tool_call_id: "call-1", name: "run_python", content: "{\"ok\":false}" };
  const otherToolMessage = { role: "tool", tool_call_id: "call-2", name: "run_python", content: "{\"ok\":true}" };
  const messages = [assistantMessage, failedToolMessage, otherToolMessage];

  pruneSupersededAttempt(messages, { assistantMessage, call: failedCall, toolMessage: failedToolMessage });

  assert.equal(messages.length, 2);
  assert.equal(messages[0], assistantMessage);
  assert.deepEqual(assistantMessage.tool_calls, [otherCall]);
  assert.equal(messages[1], otherToolMessage);
});

test("keeps the assistant message, just drops tool_calls, when it also carried real content", () => {
  const call = { id: "call-1", function: { name: "run_r", arguments: "{}" } };
  const assistantMessage = { role: "assistant", content: "Let me try that.", tool_calls: [call] };
  const toolMessage = { role: "tool", tool_call_id: "call-1", name: "run_r", content: "{\"ok\":false}" };
  const messages = [assistantMessage, toolMessage];

  pruneSupersededAttempt(messages, { assistantMessage, call, toolMessage });

  assert.equal(messages.length, 1);
  assert.equal(messages[0], assistantMessage);
  assert.equal(assistantMessage.content, "Let me try that.");
  assert.equal("tool_calls" in assistantMessage, false);
});

test("pruning two failed attempts sharing one assistant message removes it entirely", () => {
  const call1 = { id: "call-1", function: { name: "run_python", arguments: "{}" } };
  const call2 = { id: "call-2", function: { name: "run_python", arguments: "{}" } };
  const assistantMessage = { role: "assistant", content: null, tool_calls: [call1, call2] };
  const toolMessage1 = { role: "tool", tool_call_id: "call-1", name: "run_python", content: "{\"ok\":false}" };
  const toolMessage2 = { role: "tool", tool_call_id: "call-2", name: "run_python", content: "{\"ok\":false}" };
  const messages = [assistantMessage, toolMessage1, toolMessage2];

  pruneSupersededAttempt(messages, { assistantMessage, call: call1, toolMessage: toolMessage1 });
  pruneSupersededAttempt(messages, { assistantMessage, call: call2, toolMessage: toolMessage2 });

  assert.equal(messages.length, 0);
});

test("SUPERSEDE_ON_REPEAT_KEYS: get_file_tree always keys to the same target", () => {
  assert.equal(SUPERSEDE_ON_REPEAT_KEYS.get_file_tree({}), "");
  assert.equal(SUPERSEDE_ON_REPEAT_KEYS.get_file_tree({ anything: "ignored" }), "");
});

test("SUPERSEDE_ON_REPEAT_KEYS: describe_dataset keys by filename, so different files don't collide", () => {
  assert.equal(SUPERSEDE_ON_REPEAT_KEYS.describe_dataset({ filename: "a.csv" }), "a.csv");
  assert.notEqual(
    SUPERSEDE_ON_REPEAT_KEYS.describe_dataset({ filename: "a.csv" }),
    SUPERSEDE_ON_REPEAT_KEYS.describe_dataset({ filename: "b.csv" })
  );
});

test("SUPERSEDE_ON_REPEAT_KEYS: list_variables defaults to python and keys r separately", () => {
  assert.equal(SUPERSEDE_ON_REPEAT_KEYS.list_variables({}), "python");
  assert.equal(SUPERSEDE_ON_REPEAT_KEYS.list_variables({ engine: "python" }), "python");
  assert.equal(SUPERSEDE_ON_REPEAT_KEYS.list_variables({ engine: "r" }), "r");
  assert.notEqual(
    SUPERSEDE_ON_REPEAT_KEYS.list_variables({ engine: "python" }),
    SUPERSEDE_ON_REPEAT_KEYS.list_variables({ engine: "r" })
  );
});

test("SUPERSEDE_ON_REPEAT_KEYS: column_stats keys by filename+column, not just filename", () => {
  const key = SUPERSEDE_ON_REPEAT_KEYS.column_stats({ filename: "a.csv", column: "age" });
  assert.notEqual(key, SUPERSEDE_ON_REPEAT_KEYS.column_stats({ filename: "a.csv", column: "weight" }));
  assert.notEqual(key, SUPERSEDE_ON_REPEAT_KEYS.column_stats({ filename: "b.csv", column: "age" }));
  assert.equal(key, SUPERSEDE_ON_REPEAT_KEYS.column_stats({ filename: "a.csv", column: "age" }));
});
