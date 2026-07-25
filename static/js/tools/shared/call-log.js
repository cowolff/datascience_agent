// Every tool call made this session, in order — the source of truth for the
// "download report + data + scripts" export (report-export.js). Recorded
// when a call is *made* (registry.js, before dispatch), not when it
// succeeds, so a failed call still shows up as part of the session's real
// work rather than silently vanishing from the export.
export const executedCalls = [];

export function recordCall(name, args) {
  executedCalls.push({ name, description: args?.description, code: args?.code });
}
