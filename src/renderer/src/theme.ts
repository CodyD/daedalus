import { api } from "./api";

/** Colour theme, modelled on Visual Studio 2019's Light, Dark and High Contrast themes. */
export type ThemeSetting = "light" | "dark" | "high-contrast" | "system";
type Resolved = "light" | "dark" | "high-contrast";

const KEY = "daedalus.theme";
const media = () => window.matchMedia?.("(prefers-color-scheme: dark)");
/** Windows high contrast mode (forced colours) or an explicit "more contrast" request. */
const contrast = () => window.matchMedia?.("(forced-colors: active), (prefers-contrast: more)");

export function loadTheme(): ThemeSetting {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "light" || v === "dark" || v === "high-contrast" || v === "system") return v;
  } catch { /* storage unavailable */ }
  return "system";
}

export function saveTheme(t: ThemeSetting): void {
  try {
    localStorage.setItem(KEY, t);
  } catch { /* storage unavailable */ }
}

export const resolveTheme = (t: ThemeSetting): Resolved =>
  t !== "system" ? t : contrast()?.matches ? "high-contrast" : media()?.matches ? "dark" : "light";

/** Applies the theme to the page and the native window frame; returns a cleanup for the OS-change listeners. */
export function applyTheme(t: ThemeSetting): () => void {
  const set = () => { document.documentElement.dataset.theme = resolveTheme(t); };
  set();
  // The native frame only knows light and dark; high contrast is a dark theme.
  api().setTheme(t === "high-contrast" ? "dark" : t).catch(() => {});
  const ms = [media(), contrast()].filter((m): m is MediaQueryList => !!m);
  if (t !== "system" || !ms.length) return () => {};
  ms.forEach((m) => m.addEventListener("change", set));
  return () => ms.forEach((m) => m.removeEventListener("change", set));
}
