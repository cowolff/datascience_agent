// The requestInput bridge (plans/human-in-the-loop-tools.md §2). Interact
// tools (tools/interact/) never touch the DOM directly — they call
// ctx.requestInput(spec) and await whatever the browser decides to do with
// it. workbench.js installs the real UI-backed implementation on init
// (rendering a prompt card and resolving when the user answers); until then
// — and in the eval harnesses, which have no human (the browser harness
// explicitly disables this via window.__BENCH_DISABLE_HITL__, see
// eval/browser_harness.py) — this default always resolves immediately as
// "not answered," so the agent's existing fallback path (state an
// assumption and proceed) runs instead of ever hanging.

let provider = async () => ({ answered: false, reason: "no-human", value: null });

export function setInputProvider(fn) {
  provider = fn;
}

export function requestInput(spec) {
  return provider(spec);
}
