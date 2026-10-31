import { type Appearance, generateCustom, tokens } from "@tallyline/silver-lining";

export interface ThemeColorEntry {
  color: string;
  media?: string;
}

/**
 * Browser chrome / status-bar colour for an appearance. "system" emits a
 * media-conditioned light and dark pair so the chrome follows the OS; an
 * explicit choice emits one unconditional colour that follows the choice
 * rather than the OS. All values are generated canvas tokens.
 */
export function themeColorsFor(appearance: Appearance): ThemeColorEntry[] {
  if (appearance.theme === "system") {
    return [
      { color: tokens.light.canvas, media: "(prefers-color-scheme: light)" },
      { color: tokens.dark.canvas, media: "(prefers-color-scheme: dark)" },
    ];
  }
  if (appearance.theme === "custom") {
    return [{ color: generateCustom(appearance.custom).tokens.canvas }];
  }
  return [{ color: tokens[appearance.theme].canvas }];
}

/** Which scheme an appearance resolves to, given the OS preference for "system". */
export function resolvedMode(appearance: Appearance, osPrefersLight: boolean): "dark" | "light" {
  if (appearance.theme === "system") return osPrefersLight ? "light" : "dark";
  if (appearance.theme === "custom") return generateCustom(appearance.custom).mode;
  return appearance.theme === "light" ? "light" : "dark";
}
