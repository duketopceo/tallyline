// User appearance: a shipped theme, "system", or a custom theme generated from
// the user's own base / accent / contrast. Serialised into one small cookie so
// the server can render the right theme on first paint (no flash, no reload).

import { type Oklch, clamp } from "./color.ts";
import { type ThemeInput, type ThemeTokens, generateTheme } from "./generator.ts";
import { type ThemeId, THEME_IDS, THEME_INPUTS } from "./themes.ts";

export const APPEARANCE_COOKIE = "sl-appearance";

export interface CustomTheme {
  base: Oklch;
  accent: Oklch;
  contrast: number;
}

export type Appearance =
  | { theme: ThemeId | "system" }
  | { theme: "custom"; custom: CustomTheme };

// First visits follow the OS (prefers-color-scheme); an explicit choice is
// persisted in the cookie and wins from then on.
export const DEFAULT_APPEARANCE: Appearance = { theme: "system" };

export const DEFAULT_CUSTOM: CustomTheme = {
  base: THEME_INPUTS.dark.base,
  accent: THEME_INPUTS.dark.accent,
  contrast: THEME_INPUTS.dark.contrast,
};

export function normalizeCustom(c: CustomTheme): CustomTheme {
  const num = (v: number, lo: number, hi: number, d: number) =>
    clamp(Number.isFinite(v) ? v : d, lo, hi);
  return {
    base: {
      l: num(c.base.l, 0, 1, 0.16),
      c: num(c.base.c, 0, 0.4, 0),
      h: num(c.base.h, 0, 360, 0),
    },
    accent: {
      l: num(c.accent.l, 0, 1, 0.68),
      c: num(c.accent.c, 0, 0.4, 0.15),
      h: num(c.accent.h, 0, 360, 245),
    },
    contrast: num(c.contrast, 0, 100, 30),
  };
}

/** Custom themes are dark when the chosen canvas is dark, light otherwise. */
export function customInput(custom: CustomTheme): ThemeInput {
  const c = normalizeCustom(custom);
  const mode = c.base.l < 0.5 ? "dark" : "light";
  return {
    mode,
    base: c.base,
    accent: c.accent,
    contrast: c.contrast,
    status: THEME_INPUTS[mode === "dark" ? (c.contrast >= 60 ? "hc-dark" : "dark") : "light"].status,
  };
}

export function generateCustom(custom: CustomTheme): { mode: "dark" | "light"; tokens: ThemeTokens } {
  const input = customInput(custom);
  return { mode: input.mode, tokens: generateTheme(input) };
}

export function serializeAppearance(a: Appearance): string {
  if (a.theme !== "custom") return a.theme;
  const c = normalizeCustom(a.custom);
  const f = (n: number) => +n.toFixed(4);
  return [
    "custom",
    f(c.base.l),
    f(c.base.c),
    f(c.base.h),
    f(c.accent.l),
    f(c.accent.c),
    f(c.accent.h),
    f(c.contrast),
  ].join("~");
}

export function parseAppearance(raw: string | undefined | null): Appearance {
  if (!raw) return DEFAULT_APPEARANCE;
  if (raw === "system") return { theme: "system" };
  if ((THEME_IDS as readonly string[]).includes(raw)) return { theme: raw as ThemeId };
  const parts = raw.split("~");
  if (parts[0] === "custom" && parts.length === 8) {
    const n = parts.slice(1).map(Number);
    if (n.every(Number.isFinite)) {
      const [bl, bc, bh, al, ac, ah, ct] = n as [number, number, number, number, number, number, number];
      return {
        theme: "custom",
        custom: normalizeCustom({
          base: { l: bl, c: bc, h: bh },
          accent: { l: al, c: ac, h: ah },
          contrast: ct,
        }),
      };
    }
  }
  return DEFAULT_APPEARANCE;
}
