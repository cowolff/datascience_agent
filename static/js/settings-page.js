// Page glue for templates/settings.html — provider settings (plan §3.6).
// Reads/writes settings.js's localStorage-backed store. Every field
// (mode, hosted model, and the full custom-endpoint form: adapter, base
// URL, API key, model) autosaves on change/input — localStorage.setItem is
// synchronous and cheap, so there's no reason to make a user's typed-in
// custom endpoint config a "draft" that a forgotten click on "Save" or a
// stray reload can lose. The "Send test message" button still exercises
// provider.js's actual call paths against the *current form values* (which
// are now always already persisted too), so a user can verify a custom
// endpoint — the most likely thing to have friction (CORS, wrong base URL,
// bad key) — without that verification depending on Save at all. The Save
// button itself stays, now purely as an explicit "yes, this is saved"
// confirmation rather than the only thing that actually saves.

import { getSettings, saveSettings } from "./settings.js";
import { callCustomEndpoint } from "./provider.js";
import { getTheme, setTheme } from "./theme.js";

const themeSystemEl = document.getElementById("theme-system");
const themeLightEl = document.getElementById("theme-light");
const themeDarkEl = document.getElementById("theme-dark");
const themeCards = {
  system: document.getElementById("theme-system-card"),
  light: document.getElementById("theme-light-card"),
  dark: document.getElementById("theme-dark-card"),
};

const modeHostedEl = document.getElementById("mode-hosted");
const modeCustomEl = document.getElementById("mode-custom");
const modeHostedCardEl = document.getElementById("mode-hosted-card");
const modeCustomCardEl = document.getElementById("mode-custom-card");
const hostedSectionEl = document.getElementById("hosted-section");
const customSectionEl = document.getElementById("custom-section");
const hostedModelEl = document.getElementById("hosted-model");
const customAdapterEl = document.getElementById("custom-adapter");
const customBaseUrlEl = document.getElementById("custom-base-url");
const customApiKeyEl = document.getElementById("custom-api-key");
const customModelEl = document.getElementById("custom-model");
const baseUrlHintEl = document.getElementById("base-url-hint");
const testBtnEl = document.getElementById("test-btn");
const saveBtnEl = document.getElementById("save-btn");
const statusEl = document.getElementById("status-message");

const BASE_URL_HINTS = {
  openai: "Examples: https://api.openai.com/v1 · http://localhost:11434/v1 (Ollama) · http://localhost:1234/v1 (LM Studio) · http://localhost:4000 (LiteLLM proxy)",
  anthropic: "Example: https://api.anthropic.com",
};

function currentFormAsSettings() {
  return {
    mode: modeCustomEl.checked ? "custom" : "hosted",
    hostedModel: hostedModelEl.value.trim(),
    customBaseUrl: customBaseUrlEl.value.trim(),
    customApiKey: customApiKeyEl.value,
    customModel: customModelEl.value.trim(),
    customAdapter: customAdapterEl.value,
  };
}

function renderMode() {
  const isCustom = modeCustomEl.checked;
  hostedSectionEl.classList.toggle("hidden", isCustom);
  customSectionEl.classList.toggle("hidden", !isCustom);
  modeHostedCardEl.className =
    "cursor-pointer rounded-xl border-2 px-4 py-3 flex flex-col gap-1 " +
    (isCustom ? "border-slate-200 dark:border-slate-700" : "border-blue-500 bg-blue-50/50 dark:bg-blue-900/20");
  modeCustomCardEl.className =
    "cursor-pointer rounded-xl border-2 px-4 py-3 flex flex-col gap-1 " +
    (isCustom ? "border-blue-500 bg-blue-50/50 dark:bg-blue-900/20" : "border-slate-200 dark:border-slate-700");
  baseUrlHintEl.textContent = BASE_URL_HINTS[customAdapterEl.value] || "";
}

function renderTheme() {
  const current = getTheme();
  const radios = { system: themeSystemEl, light: themeLightEl, dark: themeDarkEl };
  for (const [value, radioEl] of Object.entries(radios)) {
    radioEl.checked = value === current;
    themeCards[value].className =
      "cursor-pointer rounded-xl border-2 px-3 py-2.5 flex items-center gap-2 justify-center " +
      (value === current ? "border-blue-500 bg-blue-50/50 dark:bg-blue-900/20" : "border-slate-200 dark:border-slate-700");
  }
}

function loadForm() {
  const s = getSettings();
  modeHostedEl.checked = s.mode !== "custom";
  modeCustomEl.checked = s.mode === "custom";
  hostedModelEl.value = s.hostedModel;
  customAdapterEl.value = s.customAdapter;
  customBaseUrlEl.value = s.customBaseUrl;
  customApiKeyEl.value = s.customApiKey;
  customModelEl.value = s.customModel;
  renderMode();
  renderTheme();
}

function setStatus(text, kind) {
  const colors = { ok: "text-emerald-600", error: "text-rose-600", info: "text-slate-500" };
  statusEl.textContent = text;
  statusEl.className = `text-xs ${colors[kind] || colors.info}`;
}

// Autosave: every one of these fields persists the *entire* form on every
// change, not just the field that changed — currentFormAsSettings() always
// returns a complete object, so this can never leave one field's saved
// value stale relative to another's.
function autoSave() {
  saveSettings(currentFormAsSettings());
}

modeHostedEl.addEventListener("change", () => {
  renderMode();
  autoSave();
});
modeCustomEl.addEventListener("change", () => {
  renderMode();
  autoSave();
});
customAdapterEl.addEventListener("change", () => {
  renderMode();
  autoSave();
});
for (const el of [hostedModelEl, customBaseUrlEl, customApiKeyEl, customModelEl]) {
  el.addEventListener("input", autoSave);
}

for (const [value, radioEl] of Object.entries({ system: themeSystemEl, light: themeLightEl, dark: themeDarkEl })) {
  radioEl.addEventListener("change", () => {
    setTheme(value);
    renderTheme();
  });
}

saveBtnEl.addEventListener("click", () => {
  autoSave();
  setStatus("Saved.", "ok");
  setTimeout(() => setStatus("", "info"), 3000);
});

testBtnEl.addEventListener("click", async () => {
  const settings = currentFormAsSettings();
  const testMessages = [{ role: "user", content: "Reply with exactly the word: pong" }];

  testBtnEl.disabled = true;
  setStatus("Sending test message…", "info");
  try {
    let data;
    if (settings.mode === "custom") {
      data = await callCustomEndpoint(testMessages, [], settings.customModel || undefined, settings);
    } else {
      const resp = await fetch("/api/llm-call", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: testMessages, model: settings.hostedModel || undefined }),
      });
      data = await resp.json().catch(() => null);
      if (!resp.ok) throw new Error(data?.error || `status ${resp.status}`);
    }
    const reply = data?.choices?.[0]?.message?.content ?? "(no content in response)";
    setStatus(`Success — model replied: "${String(reply).trim().slice(0, 80)}"`, "ok");
  } catch (err) {
    setStatus(`Failed: ${err.message}`, "error");
  } finally {
    testBtnEl.disabled = false;
  }
});

loadForm();
