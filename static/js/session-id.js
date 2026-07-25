// Anonymous session id (plan §3.7) — lets the stdout metadata log group
// calls from the same browser tab (e.g. "this session made 6 calls, 2
// failed") without identifying anyone. sessionStorage, not localStorage:
// stable for the tab's lifetime so a multi-turn conversation shares one
// id, but gone the moment the tab closes — nothing persists across visits.
// Sent only to our own /api/llm-call (hosted mode); never involved in
// custom-endpoint mode, since that path never reaches our backend at all.

const KEY = "bench.sessionId.v1";

export function getSessionId() {
  let id = sessionStorage.getItem(KEY);
  if (!id) {
    id = crypto.randomUUID();
    sessionStorage.setItem(KEY, id);
  }
  return id;
}
