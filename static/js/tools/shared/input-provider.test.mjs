// Unit tests for the requestInput bridge (plans/human-in-the-loop-tools.md
// §2). The safety property that matters most: with no provider installed
// (the state every eval-harness run and every module-load starts in), a
// request always resolves promptly as "not answered" rather than hanging —
// that's what lets an interact tool's `await ctx.requestInput(...)` always
// make progress.

import test from "node:test";
import assert from "node:assert/strict";

import { requestInput, setInputProvider } from "./input-provider.js";

test("the default provider resolves as not-answered, no-human, without hanging", async () => {
  const res = await requestInput({ kind: "text", question: "anything?" });
  assert.deepEqual(res, { answered: false, reason: "no-human", value: null });
});

test("setInputProvider swaps the implementation and forwards the spec", async () => {
  let seenSpec = null;
  setInputProvider(async (spec) => {
    seenSpec = spec;
    return { answered: true, value: "42" };
  });
  try {
    const res = await requestInput({ kind: "text", question: "what is x?", why: "matters" });
    assert.deepEqual(seenSpec, { kind: "text", question: "what is x?", why: "matters" });
    assert.deepEqual(res, { answered: true, value: "42" });
  } finally {
    // Restore the safe default so later tests in the same process (this
    // module is a singleton) aren't affected by this test's override.
    setInputProvider(async () => ({ answered: false, reason: "no-human", value: null }));
  }
});
