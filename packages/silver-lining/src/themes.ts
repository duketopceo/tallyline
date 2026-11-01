import { hexToOklch } from "./color.ts";
import { type ThemeInput, type ThemeTokens, generateTheme } from "./generator.ts";

/**
 * The single accent input (Azure). The generator clamps it for contrast, so
 * these are targets; every consumer (web, iOS, brand assets, docs) takes the
 * accent from the generated tokens.
 */
export const ACCENT_AZURE = { dark: "#339fee", light: "#005fba" } as const;

/** OKLCH at the cookie's 4-decimal precision, so the custom-theme round trip is exact. */
const azure = (hex: string) => {
  const o = hexToOklch(hex);
  const r = (n: number) => +n.toFixed(4);
  return { l: r(o.l), c: r(o.c), h: r(o.h) };
};

export const THEME_IDS = ["dark", "light", "hc-dark"] as const;
export type ThemeId = (typeof THEME_IDS)[number];

/**
 * Shipped theme definitions. Status colours are fixed per theme (section 5).
 * Bases are neutral (c = 0): surfaces, linings and ink are true greys, with no
 * hue bias in any shipped theme. `base.h` is irrelevant at c = 0.
 */
export const THEME_INPUTS: Record<ThemeId, ThemeInput> = {
  dark: {
    mode: "dark",
    base: { l: 0.16, c: 0, h: 0 },
    accent: azure(ACCENT_AZURE.dark),
    contrast: 30,
    status: { urgent: "#f06a6a", attention: "#f59e0b", healthy: "#10b981", neutral: "#9ca3af" },
  },
  light: {
    mode: "light",
    base: { l: 0.97, c: 0, h: 0 },
    accent: azure(ACCENT_AZURE.light),
    contrast: 30,
    status: { urgent: "#b91c1c", attention: "#92400e", healthy: "#036149", neutral: "#4b5563" },
  },
  "hc-dark": {
    mode: "dark",
    base: { l: 0.13, c: 0, h: 0 },
    accent: { l: 0.76, c: 0.14, h: 240 },
    contrast: 70,
    status: { urgent: "#ff8a8a", attention: "#fbbf24", healthy: "#34d399", neutral: "#cbd5e1" },
  },
};

export const THEME_LABELS: Record<ThemeId, string> = {
  dark: "Dark",
  light: "Light",
  "hc-dark": "High contrast dark",
};

export function buildThemes(): Record<ThemeId, ThemeTokens> {
  return Object.fromEntries(
    THEME_IDS.map((id) => [id, generateTheme(THEME_INPUTS[id])]),
  ) as Record<ThemeId, ThemeTokens>;
}
