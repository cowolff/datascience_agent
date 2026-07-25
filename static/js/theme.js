// Dark mode (plan-adjacent, follows the same "browser-local, never sent to
// the backend" pattern as settings.js). Preference is one of "system"
// (default) | "light" | "dark", stored in localStorage; "system" means no
// key is stored at all, so a user who never touches this just tracks their
// OS setting forever. Applying the "dark" class on <html> (Tailwind's
// `darkMode: 'class'` strategy, configured in each template's <head>) is
// also duplicated as an inline snippet there — this module can't run before
// first paint since it's loaded as a deferred ES module, so without that
// duplicate a dark-OS user would see a light flash on every load.

const STORAGE_KEY = "bench.theme.v1";
const media = window.matchMedia("(prefers-color-scheme: dark)");

export function getTheme() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === "light" || raw === "dark") return raw;
  } catch {}
  return "system";
}

function isDark(theme) {
  return theme === "dark" || (theme === "system" && media.matches);
}

export function applyTheme(theme = getTheme()) {
  document.documentElement.classList.toggle("dark", isDark(theme));
}

export function setTheme(theme) {
  try {
    if (theme === "system") localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, theme);
  } catch {}
  applyTheme(theme);
}

// Live-update while "system" is selected, so a user flipping their OS theme
// sees it reflected without reloading the page.
media.addEventListener("change", () => {
  if (getTheme() === "system") applyTheme("system");
});

applyTheme();
