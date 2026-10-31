// Client-side appearance writer. The palette "Theme:" commands, the sidebar
// toggle and Settings > Appearance all go through applyAppearance, so there is
// one cookie format (the package serializer) and one DOM update path.
import {
  APPEARANCE_COOKIE,
  type Appearance,
  type CustomTheme,
  generateCustom,
  parseAppearance,
  serializeAppearance,
  themeToStyle,
} from "@tallyline/silver-lining";
import { themeColorsFor } from "./appearance";

const ONE_YEAR = 60 * 60 * 24 * 365;
const CUSTOM_KEY = "sl-custom-theme";

/** The appearance currently stored in this browser's cookie (default: system). */
export function readAppearance(): Appearance {
  try {
    const m = document.cookie.match(new RegExp(`(?:^|; )${APPEARANCE_COOKIE}=([^;]*)`));
    return parseAppearance(m ? decodeURIComponent(m[1]!) : undefined);
  } catch {
    return parseAppearance(undefined);
  }
}

/** The last custom theme this device used, kept across mode switches. */
export function readStoredCustom(): CustomTheme | null {
  try {
    const raw = localStorage.getItem(CUSTOM_KEY);
    const a = parseAppearance(raw);
    return a.theme === "custom" ? a.custom : null;
  } catch {
    return null;
  }
}

function storeCustom(custom: CustomTheme) {
  try {
    localStorage.setItem(CUSTOM_KEY, serializeAppearance({ theme: "custom", custom }));
  } catch {
    // storage blocked: the custom theme is simply not remembered
  }
}

function setThemeColorMeta(appearance: Appearance) {
  const head = document.head;
  head.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.remove());
  for (const { color, media } of themeColorsFor(appearance)) {
    const meta = document.createElement("meta");
    meta.name = "theme-color";
    meta.content = color;
    if (media) meta.media = media;
    head.appendChild(meta);
  }
}

/** Apply an appearance to <html> now (no reload, no flash) and remember it. */
export function applyAppearance(appearance: Appearance) {
  const previous = readAppearance();
  // switching away from a custom theme must not lose its definition
  if (previous.theme === "custom" && appearance.theme !== "custom") storeCustom(previous.custom);
  if (appearance.theme === "custom") storeCustom(appearance.custom);

  const root = document.documentElement;
  for (const prop of [...root.style]) {
    if (prop.startsWith("--sl-") || prop === "color-scheme") root.style.removeProperty(prop);
  }
  if (appearance.theme === "system") {
    root.removeAttribute("data-theme");
  } else if (appearance.theme === "custom") {
    const { mode, tokens: t } = generateCustom(appearance.custom);
    root.setAttribute("data-theme", "custom");
    for (const [k, v] of Object.entries(themeToStyle(t, mode))) {
      root.style.setProperty(k === "colorScheme" ? "color-scheme" : k, v);
    }
  } else {
    root.setAttribute("data-theme", appearance.theme);
  }
  setThemeColorMeta(appearance);
  try {
    document.cookie = `${APPEARANCE_COOKIE}=${encodeURIComponent(
      serializeAppearance(appearance),
    )}; path=/; max-age=${ONE_YEAR}; samesite=lax`;
  } catch {
    // cookies blocked: the theme still applies for this page view
  }
  document.dispatchEvent(new CustomEvent("sl-appearance", { detail: appearance }));
}
