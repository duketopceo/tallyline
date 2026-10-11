import { APPEARANCE_COOKIE } from "@tallyline/silver-lining";

type Mode = "system" | "dark" | "light";

// Palette quick-switch. Full control (custom themes) lives in Settings >
// Appearance; both write the same cookie, which the root layout reads.
export function applyTheme(mode: Mode) {
  const root = document.documentElement;
  for (const prop of [...root.style]) {
    if (prop.startsWith("--sl-") || prop === "color-scheme") root.style.removeProperty(prop);
  }
  if (mode === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", mode);
  try {
    document.cookie = `${APPEARANCE_COOKIE}=${mode}; path=/; max-age=31536000; samesite=lax`;
  } catch {
    // cookies blocked: applies for this page view only
  }
}
