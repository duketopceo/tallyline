// Silver Lining theme generator (docs/design/silver-lining.md sections 2, 3, 5).
//
// A theme is derived in OKLCH from three inputs (base, accent, contrast) plus a
// mode and a fixed set of status colours. Every derived colour is clamped so the
// contrast floors and ceilings of section 3 hold for ANY input. The generator
// never trusts its inputs: lightness, chroma, hue and contrast are all clamped.

import {
  type Oklch,
  clamp,
  contrastRatio,
  gamutClamp,
  hexToOklch,
  oklchToHex,
  rgba,
} from "./color.ts";

export type Mode = "dark" | "light";

export interface StatusColors {
  urgent: string;
  attention: string;
  healthy: string;
  neutral: string;
}

export interface ThemeInput {
  mode: Mode;
  base: Oklch;
  accent: Oklch;
  /** 0-100 */
  contrast: number;
  status: StatusColors;
}

/** Contrast floors and ceilings from section 3. */
export const FLOORS = {
  ink: 12,
  muted: 7,
  subtle: 4.5,
  tertiary: 4.5,
  disabled: 3,
  control: 3,
  accent: 4.5,
  onAccent: 4.5,
  status: 4.5,
} as const;
export const DARK_INK_CEILING = 16;
/** Pure black canvas and pure white text are banned (section 2). */
export const MIN_DARK_CANVAS_L = 0.13;
export const MAX_INK_L = 0.96;

export const TOKEN_NAMES = [
  "canvas",
  "surface-1",
  "surface-2",
  "surface-3",
  "surface-4",
  "lining-faint",
  "lining",
  "lining-strong",
  "lining-bright",
  "control",
  "ink",
  "ink-muted",
  "ink-subtle",
  "ink-tertiary",
  "ink-disabled",
  "accent",
  "accent-hover",
  "accent-pressed",
  "accent-soft",
  "on-accent",
  "status-urgent",
  "status-attention",
  "status-healthy",
  "status-neutral",
  "status-urgent-soft",
  "status-attention-soft",
  "status-healthy-soft",
  "status-neutral-soft",
  "glint",
  "glint-silver",
  "overlay",
  "scrim",
] as const;
export type TokenName = (typeof TOKEN_NAMES)[number];
export type ThemeTokens = Record<TokenName, string>;

export const SURFACE_NAMES = ["canvas", "surface-1", "surface-2", "surface-3", "surface-4"] as const;

const EPS = 0.03; // keep generated ratios this far inside the floors (hex rounding)
const MAX_SPREAD = 1.3; // (Y_surface4 + .05) / (Y_canvas + .05) in dark themes

type Dir = 1 | -1; // +1: lighter than the background, -1: darker

/** Lightness at which colour(h, c, L) hits `ratio` against bg, moving away from bg. */
function solveL(h: number, c: number, bg: string, ratio: number, dir: Dir): number {
  let lo = 0;
  let hi = 1;
  // contrast is monotonic in L on each side of the background's own lightness
  const bgL = oklchLightness(bg);
  if (dir === 1) lo = bgL;
  else hi = bgL;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    const r = contrastRatio(oklchToHex({ l: mid, c, h }), bg);
    const enough = r >= ratio;
    if (dir === 1) {
      if (enough) hi = mid;
      else lo = mid;
    } else if (enough) lo = mid;
    else hi = mid;
  }
  return dir === 1 ? hi : lo;
}

const oklchLightness = (hex: string): number => hexToOklch(hex).l;

interface TextSpec {
  h: number;
  c: number;
  dir: Dir;
  surfaces: readonly string[]; // every surface the text can sit on
  worst: string; // surface with the lowest ratio
  floor: number;
  ceil?: number; // maximum ratio on any surface
  target: number; // desired ratio on `worst`
  lMin?: number;
  lMax?: number;
}

/** Solve a text colour and repair it against hex rounding so floor/ceil hold. */
function textColor(spec: TextSpec): string {
  const lMin = spec.lMin ?? 0;
  const lMax = spec.lMax ?? 1;
  let l = clamp(solveL(spec.h, spec.c, spec.worst, spec.target, spec.dir), lMin, lMax);
  let hex = oklchToHex({ l, c: spec.c, h: spec.h });
  for (let i = 0; i < 600; i++) {
    hex = oklchToHex({ l, c: spec.c, h: spec.h });
    const ratios = spec.surfaces.map((s) => contrastRatio(hex, s));
    const min = Math.min(...ratios);
    const max = Math.max(...ratios);
    if (min < spec.floor + EPS) {
      const next = clamp(l + spec.dir * 0.0015, lMin, lMax);
      if (next === l) break;
      l = next;
    } else if (spec.ceil !== undefined && max > spec.ceil - EPS) {
      const next = clamp(l - spec.dir * 0.0015, lMin, lMax);
      if (next === l) break;
      l = next;
    } else break;
  }
  return hex;
}

function surfacesFor(
  mode: Mode,
  base: Oklch,
  contrast01: number,
  status: StatusColors,
): { hexes: string[]; h: number; c: number } {
  const h = Number.isFinite(base.h) ? base.h : 0;
  const c = clamp(base.c, 0, 0.035);
  // dark ladders gain a little chroma per step (the cool silver cast deepens
  // with elevation); light ladders stay nearly neutral
  const build = (ls: number[]) =>
    ls.map((l, i) =>
      oklchToHex({ l, c: mode === "dark" ? Math.min(c * (0.8 + 0.5 * i), 0.06) : c * 0.6, h }),
    );
  // fixed status colours are text too: they must clear 4.5 on the hardest surface
  const statusOk = (top: string): boolean =>
    Object.values(status).every((s) => contrastRatio(s, top) >= FLOORS.status + 0.05);
  if (mode === "light") {
    const baseLight = clamp(base.l, 0.93, 0.97);
    const nominalD = 0.018 + 0.012 * contrast01;
    const lightLs = (canvasL: number, stepD: number) => [
      canvasL,
      Math.min(canvasL + 0.03, 1),
      canvasL - stepD,
      canvasL - 2 * stepD,
      canvasL - 3 * stepD,
    ];
    for (let canvasL = baseLight; canvasL <= 0.97 + 1e-9; canvasL += 0.0025) {
      for (let stepD = nominalD; stepD >= 0.01 - 1e-9; stepD -= 0.0025) {
        const hexes = build(lightLs(canvasL, stepD));
        if (statusOk(hexes[4]!)) return { hexes, h, c };
      }
    }
    return { hexes: build(lightLs(0.97, 0.01)), h, c };
  }
  const baseL = clamp(base.l, MIN_DARK_CANVAS_L, 0.2);
  const nominal = 0.03 + 0.015 * contrast01;
  const reach = oklchToHex({ l: MAX_INK_L, c: Math.min(0.006, c), h });
  for (let canvasL = baseL; canvasL >= MIN_DARK_CANVAS_L - 1e-9; canvasL -= 0.0025) {
    for (let step = nominal; step >= 0.03 - 1e-9; step -= 0.0025) {
      const hexes = build([0, 1, 2, 3, 4].map((i) => canvasL + i * Math.max(step, 0.03)));
      const spread = lum(hexes[4]!) / lum(hexes[0]!);
      // the lightest permitted ink must still clear the floor on the top surface
      if (
        spread <= MAX_SPREAD &&
        contrastRatio(reach, hexes[4]!) >= FLOORS.ink + 0.4 &&
        statusOk(hexes[4]!)
      ) {
        return { hexes, h, c };
      }
    }
  }
  return { hexes: build([0, 1, 2, 3, 4].map((i) => MIN_DARK_CANVAS_L + i * 0.03)), h, c };
}

const lum = (hex: string): number => {
  // (Y + .05) via contrast against pure black: ratio = (Y + .05) / .05
  return contrastRatio(hex, "#000000") * 0.05;
};

export function generateTheme(input: ThemeInput): ThemeTokens {
  const mode = input.mode;
  const dark = mode === "dark";
  const c01 = clamp(input.contrast, 0, 100) / 100;
  const dir: Dir = dark ? 1 : -1;
  const { hexes: surfaces, h, c: baseC } = surfacesFor(mode, input.base, c01, input.status);
  const canvas = surfaces[0]!;
  // darkest surface in light themes, lightest in dark: the hardest to read on
  const worst = surfaces[4]!;
  // text and linings carry the base chroma unchanged: a neutral base (c = 0)
  // yields true greys. (An old 0.006 floor tinted them toward `base.h`.)
  const tint = clamp(baseC * 1.6, 0, 0.03);

  const text = (floor: number, target: number, extra?: Partial<TextSpec>): string =>
    textColor({ h, c: tint, dir, surfaces, worst, floor, target, ...extra });

  const inkSpread = lum(surfaces[4]!) / lum(canvas);
  const inkLo = FLOORS.ink + 0.15;
  const inkHi = dark ? (DARK_INK_CEILING - 0.15) / inkSpread : 15.5;
  const ink = text(FLOORS.ink, inkLo + Math.max(0, inkHi - inkLo) * c01, {
    c: tint * 0.5,
    ...(dark ? { ceil: DARK_INK_CEILING, lMax: MAX_INK_L } : { lMin: 0.15 }),
  });
  const muted = text(FLOORS.muted, 8.6 + 2.4 * c01);
  const subtle = text(FLOORS.subtle, 5.4 + 1.2 * c01);
  const tertiary = text(FLOORS.tertiary, 4.8 + 0.8 * c01);
  const disabled = text(FLOORS.disabled, 3.15 + 0.3 * c01);

  // linings: hairlines are measured against the canvas, except the control
  // edge (inputs, focus ring) which must hold 3:1 on every surface.
  const lineC = clamp(baseC * 1.6, 0, 0.03);
  const solveLine = (target: number): string =>
    oklchToHex({ l: solveL(h, lineC, canvas, target, dir), c: lineC, h });
  const liningFaint = solveLine(1.22 + 0.2 * c01);
  const lining = solveLine(1.85 + 0.5 * c01);
  const liningStrong = textColor({
    h,
    c: lineC,
    dir,
    surfaces,
    worst,
    floor: FLOORS.control,
    target: 3.25 + 0.9 * c01,
  });
  const liningBright = textColor({
    h,
    c: lineC,
    dir,
    surfaces,
    worst,
    floor: FLOORS.muted,
    target: 9.6 + 2 * c01,
  });

  // accent: chromatic, used as link/text, so it clears 4.5 on every surface
  const accIn = gamutClamp({
    l: clamp(input.accent.l, 0.3, 0.9),
    c: clamp(input.accent.c, 0, 0.25),
    h: input.accent.h,
  });
  const accent = textColor({
    h: accIn.h,
    c: accIn.c,
    dir,
    surfaces,
    worst,
    floor: FLOORS.accent,
    target: 4.75,
    lMin: dark ? accIn.l : 0,
    lMax: dark ? 1 : accIn.l,
  });
  const accOk = hexToOklch(accent);
  const accHover = oklchToHex({ ...accOk, l: clamp(accOk.l + (dark ? 0.07 : -0.04), 0.1, 0.95) });
  const accPressed = oklchToHex({ ...accOk, l: clamp(accOk.l + (dark ? -0.05 : -0.08), 0.1, 0.95) });
  const near = (l: number) => oklchToHex({ l, c: Math.min(0.01, baseC), h });
  const onAccent = [near(0.14), near(0.97)].reduce((a, b) =>
    contrastRatio(a, accent) >= contrastRatio(b, accent) ? a : b,
  );

  const st = input.status;
  const wash = 0.14;
  const overlayBase = oklchToHex({ l: dark ? 0.07 : 0.2, c: Math.min(0.01, baseC), h });

  return {
    canvas,
    "surface-1": surfaces[1]!,
    "surface-2": surfaces[2]!,
    "surface-3": surfaces[3]!,
    "surface-4": surfaces[4]!,
    "lining-faint": liningFaint,
    lining,
    "lining-strong": liningStrong,
    "lining-bright": liningBright,
    control: liningStrong,
    ink,
    "ink-muted": muted,
    "ink-subtle": subtle,
    "ink-tertiary": tertiary,
    "ink-disabled": disabled,
    accent,
    "accent-hover": accHover,
    "accent-pressed": accPressed,
    "accent-soft": rgba(accent, wash),
    "on-accent": onAccent,
    "status-urgent": st.urgent,
    "status-attention": st.attention,
    "status-healthy": st.healthy,
    "status-neutral": st.neutral,
    "status-urgent-soft": rgba(st.urgent, wash),
    "status-attention-soft": rgba(st.attention, wash),
    "status-healthy-soft": rgba(st.healthy, wash),
    "status-neutral-soft": rgba(st.neutral, wash),
    glint: accent,
    "glint-silver": liningBright,
    overlay: rgba(overlayBase, dark ? 0.72 : 0.4),
    scrim: rgba(overlayBase, dark ? 0.5 : 0.24),
  };
}

export interface ContrastPair {
  fg: TokenName;
  bg: TokenName;
  ratio: number;
  floor: number;
  ceil?: number;
  ok: boolean;
}

/** Every text-role x surface pair with its floor (and the dark ink ceiling). */
export function contrastPairs(tokens: ThemeTokens, mode: Mode): ContrastPair[] {
  const roles: Array<[TokenName, number]> = [
    ["ink", FLOORS.ink],
    ["ink-muted", FLOORS.muted],
    ["ink-subtle", FLOORS.subtle],
    ["ink-tertiary", FLOORS.tertiary],
    ["ink-disabled", FLOORS.disabled],
    ["lining-strong", FLOORS.control],
    ["control", FLOORS.control],
    ["accent", FLOORS.accent],
    ["status-urgent", FLOORS.status],
    ["status-attention", FLOORS.status],
    ["status-healthy", FLOORS.status],
    ["status-neutral", FLOORS.status],
  ];
  const out: ContrastPair[] = [];
  for (const [fg, floor] of roles) {
    for (const bg of SURFACE_NAMES) {
      const ratio = contrastRatio(tokens[fg], tokens[bg]);
      const ceil = fg === "ink" && mode === "dark" ? DARK_INK_CEILING : undefined;
      out.push({
        fg,
        bg,
        ratio,
        floor,
        ...(ceil !== undefined ? { ceil } : {}),
        ok: ratio >= floor && (ceil === undefined || ratio <= ceil),
      });
    }
  }
  const onAccent = contrastRatio(tokens["on-accent"], tokens.accent);
  out.push({
    fg: "on-accent",
    bg: "accent",
    ratio: onAccent,
    floor: FLOORS.onAccent,
    ok: onAccent >= FLOORS.onAccent,
  });
  return out;
}
