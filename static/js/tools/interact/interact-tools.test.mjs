// Unit tests for the human-in-the-loop tools (plans/human-in-the-loop-tools.md
// §4). All DOM-free — each test supplies a mock `ctx.requestInput` so
// nothing here depends on a browser; the real UI (render/prompt.js) is
// verified in-browser only, same as the render_chart/table split.

import test from "node:test";
import assert from "node:assert/strict";

import { askUserTool } from "./ask-user.js";
import { askChoiceTool } from "./ask-choice.js";
import { confirmTool } from "./confirm.js";
import { clarifyTermTool } from "./clarify-term.js";
import { chooseColumnTool } from "./choose-column.js";
import { confirmExclusionTool } from "./confirm-exclusion.js";

function ctxThatAnswers(value) {
  return { requestInput: async (spec) => ({ answered: true, value, _spec: spec }) };
}
function ctxThatDeclines(reason = "declined") {
  return { requestInput: async () => ({ answered: false, reason, value: null }) };
}

// ---- ask_user ------------------------------------------------------------

test("ask_user returns the answer text when answered", async () => {
  const res = await askUserTool.handler({ question: "What does X mean?" }, ctxThatAnswers("it means Y"));
  assert.deepEqual(res, { ok: true, rendered: true, answered: true, answer: "it means Y", reason: undefined });
});

test("ask_user reports answered:false and a reason when declined", async () => {
  const res = await askUserTool.handler({ question: "What does X mean?" }, ctxThatDeclines("timeout"));
  assert.equal(res.answered, false);
  assert.equal(res.answer, null);
  assert.equal(res.reason, "timeout");
  assert.equal(res.rendered, true); // still rendered — a decline is a real resolved UI, not an error
});

test("ask_user rejects a missing question before ever calling requestInput", async () => {
  let called = false;
  const res = await askUserTool.handler({}, { requestInput: async () => { called = true; } });
  assert.equal(res.ok, false);
  assert.equal(called, false);
});

// ---- ask_choice -----------------------------------------------------------

test("ask_choice returns the selected option(s), filtered to what was offered", async () => {
  const res = await askChoiceTool.handler(
    { question: "Which column?", options: ["arm", "group"] },
    ctxThatAnswers(["arm"])
  );
  assert.deepEqual(res.selected, ["arm"]);
  assert.equal(res.answered, true);
});

test("ask_choice drops any answer values not among the offered options", async () => {
  const res = await askChoiceTool.handler(
    { question: "Which?", options: ["a", "b"] },
    ctxThatAnswers(["a", "not-an-option"])
  );
  assert.deepEqual(res.selected, ["a"]);
});

test("ask_choice requires at least two options", async () => {
  const res = await askChoiceTool.handler({ question: "Which?", options: ["only-one"] }, ctxThatAnswers([]));
  assert.equal(res.ok, false);
});

test("ask_choice passes allow_multiple through to the request spec", async () => {
  let seenSpec = null;
  const ctx = { requestInput: async (spec) => { seenSpec = spec; return { answered: true, value: ["a"] }; } };
  await askChoiceTool.handler({ question: "Q", options: ["a", "b"], allow_multiple: true }, ctx);
  assert.equal(seenSpec.allowMultiple, true);
});

// ---- confirm ---------------------------------------------------------------

test("confirm returns a boolean confirmed when answered", async () => {
  const yes = await confirmTool.handler({ question: "Drop these rows?" }, ctxThatAnswers(true));
  assert.equal(yes.confirmed, true);
  const no = await confirmTool.handler({ question: "Drop these rows?" }, ctxThatAnswers(false));
  assert.equal(no.confirmed, false);
});

test("confirm reports confirmed:null (not false) when declined", async () => {
  const res = await confirmTool.handler({ question: "Drop these rows?" }, ctxThatDeclines());
  assert.equal(res.confirmed, null);
  assert.equal(res.answered, false);
});

// ---- presets ----------------------------------------------------------------

test("clarify_term returns a definition and asks a term-specific question", async () => {
  let seenSpec = null;
  const ctx = { requestInput: async (spec) => { seenSpec = spec; return { answered: true, value: "CD4/CD8" }; } };
  const res = await clarifyTermTool.handler({ term: "CD-ratio" }, ctx);
  assert.equal(res.definition, "CD4/CD8");
  assert.match(seenSpec.question, /CD-ratio/);
  assert.match(seenSpec.title, /CD-ratio/);
});

test("clarify_term rejects a missing term", async () => {
  const res = await clarifyTermTool.handler({}, ctxThatAnswers("x"));
  assert.equal(res.ok, false);
});

test("choose_column returns the chosen column, validated against candidates", async () => {
  const res = await chooseColumnTool.handler(
    { purpose: "treatment arm", candidates: ["arm", "group"] },
    ctxThatAnswers(["group"])
  );
  assert.equal(res.column, "group");
});

test("choose_column requires at least two candidates", async () => {
  const res = await chooseColumnTool.handler({ purpose: "arm", candidates: ["only"] }, ctxThatAnswers([]));
  assert.equal(res.ok, false);
});

test("confirm_exclusion surfaces the row count in the question and returns confirmed", async () => {
  let seenSpec = null;
  const ctx = { requestInput: async (spec) => { seenSpec = spec; return { answered: true, value: true }; } };
  const res = await confirmExclusionTool.handler({ description: "drop missing outcomes", n_rows: 12 }, ctx);
  assert.equal(res.confirmed, true);
  assert.match(seenSpec.question, /12 rows/);
});

test("confirm_exclusion works without n_rows and rejects a missing description", async () => {
  const res = await confirmExclusionTool.handler({ description: "drop some rows" }, ctxThatAnswers(true));
  assert.equal(res.confirmed, true);
  const bad = await confirmExclusionTool.handler({}, ctxThatAnswers(true));
  assert.equal(bad.ok, false);
});

// ---- shared: every interact tool is marked rendered on a resolved request ---

test("every interact tool's successful result carries rendered:true (for finishToolTrace)", async () => {
  const results = await Promise.all([
    askUserTool.handler({ question: "q" }, ctxThatAnswers("a")),
    askChoiceTool.handler({ question: "q", options: ["a", "b"] }, ctxThatAnswers(["a"])),
    confirmTool.handler({ question: "q" }, ctxThatAnswers(true)),
    clarifyTermTool.handler({ term: "t" }, ctxThatAnswers("d")),
    chooseColumnTool.handler({ purpose: "p", candidates: ["a", "b"] }, ctxThatAnswers(["a"])),
    confirmExclusionTool.handler({ description: "d" }, ctxThatAnswers(true)),
  ]);
  for (const r of results) assert.equal(r.rendered, true);
});
