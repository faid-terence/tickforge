import type { ThemeSetting } from "../store/settingsSlice";

const KEY = "tickforge-theme";

/** Reads the saved theme. Storage can be unavailable (private mode), so never throw. */
export function loadTheme(): ThemeSetting {
  try {
    const value = localStorage.getItem(KEY);
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    return "system";
  }
}

/** Applies a theme to <html> and remembers it. `system` follows the OS setting. */
export function applyTheme(theme: ThemeSetting): void {
  const root = document.documentElement;
  if (theme === "system") delete root.dataset.theme;
  else root.dataset.theme = theme;
  try {
    if (theme === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, theme);
  } catch {
    // Not persisted; the choice still applies for this visit.
  }
}
