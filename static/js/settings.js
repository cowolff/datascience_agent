// Provider settings (plan §3.6) — persisted in this browser's localStorage,
// never sent to our backend. Two modes:
//   - "hosted": routes through our /api/llm-call proxy, using our server's
//     own API key (app.py's MISTRAL_KEY) — the only mode before Phase 7.
//   - "custom": the browser calls a user-supplied endpoint directly via
//     fetch(), bypassing our backend entirely. Covers both third-party
//     hosted APIs (OpenAI, Anthropic, ...) and local model servers (Ollama,
//     LM Studio, vLLM, ...) listening on localhost/LAN.
// localStorage (not IndexedDB/sessionStorage) was chosen for the custom-mode
// credential: it's the simplest storage that satisfies the one hard
// requirement (never transmitted to our backend, since nothing here ever
// touches a fetch("/api/...") call) and persists across tabs, which matches
// how a user would expect a "set once" provider config to behave. A user
// who wants it gone on tab close can clear it manually from Settings.

const STORAGE_KEY = "bench.providerSettings.v1";

function defaults() {
  return {
    mode: "hosted", // "hosted" | "custom"
    hostedModel: "", // blank => server's own default (app.py DEFAULT_MODEL)
    customBaseUrl: "",
    customApiKey: "",
    customModel: "",
    customAdapter: "openai", // "openai" | "anthropic" — plan §3.6's two adapter families
  };
}

export function getSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaults();
    return { ...defaults(), ...JSON.parse(raw) };
  } catch {
    return defaults();
  }
}

export function saveSettings(partial) {
  const next = { ...getSettings(), ...partial };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  return next;
}

/** The model string to actually send, given the current mode — resolved
 * once here so callers (workbench.js, provider.js) don't each have to know
 * which of hostedModel/customModel applies. */
export function effectiveModel(settings = getSettings()) {
  return settings.mode === "custom" ? settings.customModel || undefined : settings.hostedModel || undefined;
}
