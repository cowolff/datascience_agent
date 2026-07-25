// The provider call — hosted proxy or direct-to-endpoint (plan §3.6, Phase
// 7). This is the entire interface agent-loop.js needs: an async function
// taking (messages, tools, model) and returning a chat-completions-shaped
// {choices: [{message}]} response, regardless of which mode/provider
// actually served it — everything mode-specific stays in this file and
// adapters.js.

import { getSettings } from "./settings.js";
import { adapters } from "./adapters.js";
import { getSessionId } from "./session-id.js";
import { getDatasetMeta } from "./dataset-meta.js";

export async function callModel(messages, tools, model, signal) {
  const settings = getSettings();
  if (settings.mode === "custom") {
    return callCustomEndpoint(messages, tools, model, settings, signal);
  }
  return callHostedProxy(messages, tools, model, signal);
}

async function callHostedProxy(messages, tools, model, signal) {
  // Usage metadata (plan §3.7, hosted mode only): a session id and coarse
  // dataset shape, both computed client-side and sent as small explicit
  // fields — never derived by the server from the message body, which is
  // the actual conversation content. Custom-endpoint mode never sends
  // either, since that path doesn't call this function at all.
  const resp = await fetch("/api/llm-call", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messages,
      tools,
      model,
      sessionId: getSessionId(),
      datasetMeta: getDatasetMeta(),
    }),
    signal,
  });

  const data = await resp.json().catch(() => null);
  if (!resp.ok) {
    const message = data?.error || `LLM call failed with status ${resp.status}.`;
    throw new Error(message);
  }
  return data;
}

/**
 * Custom-endpoint mode (plan §3.6): the browser calls the user's endpoint
 * directly — our backend is never involved, so nothing about this call
 * (messages, the user's API key, dataset shape) reaches our server. Used
 * for both third-party hosted APIs and local model servers.
 */
export async function callCustomEndpoint(messages, tools, model, settings, signal) {
  if (!settings.customBaseUrl) {
    throw new Error("Custom endpoint mode is selected but no base URL is configured — set one in Settings.");
  }
  const adapter = adapters[settings.customAdapter] || adapters.openai;
  const url = adapter.url(settings.customBaseUrl);
  const body = adapter.buildBody(messages, tools, model);

  let resp;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: adapter.headers(settings.customApiKey),
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (err.name === "AbortError") throw err;
    // A fetch()-level failure this early (before any HTTP status exists)
    // is almost always CORS, not a real outage — local model servers in
    // particular need to be told to allow browser-origin requests (e.g.
    // OLLAMA_ORIGINS for Ollama). Plan §3.6 calls this out explicitly as
    // the expected first thing to break for local-mode users, so name it
    // rather than surfacing a generic "failed to fetch".
    throw new Error(
      `Could not reach ${url} directly from the browser (${err.message}). This is ` +
        "usually CORS: the endpoint must be configured to allow browser-origin " +
        "requests. For a local server (Ollama, LM Studio, vLLM, ...), check its " +
        "CORS/allowed-origins setting; for a hosted API, confirm the base URL."
    );
  }

  const data = await resp.json().catch(() => null);
  if (!resp.ok) {
    const message = data?.error?.message || data?.error || `Custom endpoint call failed with status ${resp.status}.`;
    throw new Error(message);
  }
  return adapter.parseResponse(data);
}
