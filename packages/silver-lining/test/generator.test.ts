import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { clamp, contrastRatio, deltaE, hexToOklch } from "../src/color.ts";
import {
  DARK_INK_CEILING,
  MAX_INK_L,
  MIN_DARK_CANVAS_L,
  SURFACE_NAMES,
  contrastPairs,
  generateTheme,
} from "../src/generator.ts";
import { THEME_IDS, THEME_INPUTS, buildThemes } from "../src/themes.ts";
import type { Mode } from "../src/generator.ts";

const wild = fc.oneof(
  fc.double({ min: -2, max: 3, noNaN: false }),
  fc.constantFrom(0, 1, 0.5, Infinity, -Infinity, NaN),
);
const oklch = fc.record({
  l: fc.double({ min: 0, max: 1, noNaN: true }),
  c: fc.double({ min: 0, max: 0.4, noNaN: true }),
  h: fc.double({ min: 0, max: 360, noNaN: true }),
});
const wildOklch = fc.record({ l: wild, c: wild, h: wild });
const modes = fc.constantFrom<Mode>("dark", "light");

function inputs(mode: Mode) {
  const status = THEME_INPUTS[mode === "dark" ? "dark" : "light"].status;
  return { mode, status };
}

describe("generateTheme (property-based, section 3 floors hold for any input)", () => {
  it("every text x surface pair meets its floor and the dark ink ceiling", () => {
    fc.assert(
      fc.property(
        modes,
        fc.oneof(oklch, wildOklch),
        fc.oneof(oklch, wildOklch),
        fc.oneof(fc.integer({ min: 0, max: 100 }), wild),
        (mode, base, accent, contrast) => {
          const t = generateTheme({ ...inputs(mode), base, accent, contrast });
          const bad = contrastPairs(t, mode).filter((p) => !p.ok);
          expect(bad.map((p) => `${p.fg}/${p.bg}=${p.ratio.toFixed(2)}`)).toEqual([]);
        },
      ),
      { numRuns: 400 },
    );
  });

  it("never emits pure black canvas or pure white text; respects L bounds", () => {
    fc.assert(
      fc.property(modes, oklch, oklch, fc.integer({ min: 0, max: 100 }), (mode, base, accent, contrast) => {
        const t = generateTheme({ ...inputs(mode), base, accent, contrast });
        expect(t.canvas).not.toBe("#000000");
        for (const k of ["ink", "ink-muted", "ink-subtle", "ink-tertiary"] as const) {
          expect(t[k]).not.toBe("#ffffff");
        }
        if (mode === "dark") {
          expect(hexToOklch(t.canvas).l).toBeGreaterThanOrEqual(MIN_DARK_CANVAS_L - 0.006);
          expect(hexToOklch(t.ink).l).toBeLessThanOrEqual(MAX_INK_L + 0.003);
          for (const s of SURFACE_NAMES) expect(hexToOklch(t[s]).l).toBeLessThan(0.3);
        }
      }),
      { numRuns: 300 },
    );
  });

  it("dark surface ladder steps stay within +0.025..+0.047 L", () => {
    fc.assert(
      fc.property(oklch, oklch, fc.integer({ min: 0, max: 100 }), (base, accent, contrast) => {
        const t = generateTheme({ ...inputs("dark"), base, accent, contrast });
        const ls = SURFACE_NAMES.map((s) => hexToOklch(t[s]).l);
        for (let i = 1; i < ls.length; i++) {
          const d = ls[i]! - ls[i - 1]!;
          expect(d).toBeGreaterThan(0.025);
          expect(d).toBeLessThan(0.047);
        }
      }),
      { numRuns: 300 },
    );
  });

  it("text steps keep their order (ink > muted > subtle > tertiary) on the worst surface", () => {
    fc.assert(
      fc.property(modes, oklch, oklch, fc.integer({ min: 0, max: 100 }), (mode, base, accent, contrast) => {
        const t = generateTheme({ ...inputs(mode), base, accent, contrast });
        const r = (k: "ink" | "ink-muted" | "ink-subtle" | "ink-tertiary") =>
          contrastRatio(t[k], t["surface-4"]);
        expect(r("ink")).toBeGreaterThan(r("ink-muted"));
        expect(r("ink-muted")).toBeGreaterThan(r("ink-subtle"));
        expect(r("ink-subtle")).toBeGreaterThanOrEqual(r("ink-tertiary"));
      }),
      { numRuns: 200 },
    );
  });

  it("is deterministic", () => {
    const a = generateTheme(THEME_INPUTS.dark);
    expect(generateTheme(THEME_INPUTS.dark)).toEqual(a);
  });
});

describe("shipped themes", () => {
  const themes = buildThemes();
  it.each(THEME_IDS)("%s passes every pair", (id) => {
    const bad = contrastPairs(themes[id], THEME_INPUTS[id].mode).filter((p) => !p.ok);
    expect(bad).toEqual([]);
  });

  it("dark ink stays under the 16:1 ceiling on the canvas", () => {
    for (const id of ["dark", "hc-dark"] as const) {
      expect(contrastRatio(themes[id].ink, themes[id].canvas)).toBeLessThanOrEqual(DARK_INK_CEILING);
    }
  });

  it("clamp helper tolerates NaN", () => {
    expect(clamp(NaN, 1, 2)).toBe(1);
  });
});

import {
  DEFAULT_APPEARANCE,
  generateCustom,
  parseAppearance,
  serializeAppearance,
  DEFAULT_CUSTOM,
} from "../src/appearance.ts";

describe("appearance cookie", () => {
  it("defaults to system and round-trips every choice", () => {
    expect(parseAppearance(undefined)).toEqual(DEFAULT_APPEARANCE);
    expect(DEFAULT_APPEARANCE.theme).toBe("system");
    for (const theme of ["system", "dark", "light", "hc-dark"] as const) {
      expect(parseAppearance(serializeAppearance({ theme }))).toEqual({ theme });
    }
    const a = { theme: "custom", custom: DEFAULT_CUSTOM } as const;
    expect(parseAppearance(serializeAppearance(a))).toEqual(a);
  });

  it("rejects garbage and clamps hostile custom values", () => {
    expect(parseAppearance("custom~x")).toEqual(DEFAULT_APPEARANCE);
    expect(parseAppearance("nope")).toEqual(DEFAULT_APPEARANCE);
    const p = parseAppearance("custom~9~9~9999~9~9~9999~999");
    expect(p.theme).toBe("custom");
    if (p.theme === "custom") {
      const { mode, tokens: t } = generateCustom(p.custom);
      expect(contrastPairs(t, mode).every((x) => x.ok)).toBe(true);
    }
  });
});

describe("neutral palette (frontend polish U1)", () => {
  const themes = buildThemes();
  // Swatch-page values from the plan (R1, R2). The generator keeps the contrast
  // floors and ceilings, so outputs land near, not on, these.
  const swatch = {
    dark: {
      canvas: "#08090a",
      "surface-1": "#0f1011",
      "surface-2": "#151617",
      "surface-3": "#1c1d1f",
      "lining-faint": "#26282c",
      ink: "#ededef",
    },
    light: {
      canvas: "#f7f7f8",
      "surface-1": "#ffffff",
      "surface-2": "#f1f1f3",
      "surface-3": "#e8e8eb",
      "lining-faint": "#dcdde0",
      ink: "#16171a",
    },
  } as const;
  const TOLERANCE = 4;

  for (const id of ["dark", "light"] as const) {
    it(`${id} surfaces, line and ink sit within tolerance of the swatch values`, () => {
      for (const [k, hex] of Object.entries(swatch[id])) {
        const got = themes[id][k as keyof (typeof themes)["dark"]];
        expect(deltaE(hex, got), `${id} ${k} ${got}`).toBeLessThanOrEqual(TOLERANCE);
      }
    });
  }

  it("has no hue bias in surfaces, linings or ink in dark, light or hc-dark", () => {
    const neutral = [
      ...SURFACE_NAMES,
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
    ] as const;
    for (const id of THEME_IDS) {
      for (const k of neutral) {
        const c = hexToOklch(themes[id][k]).c;
        expect(c, `${id} ${k} ${themes[id][k]}`).toBeLessThan(0.012);
      }
    }
  });

  it("keeps dark canvas lightness at or above the floor and no pure white or black", () => {
    for (const id of ["dark", "hc-dark"] as const) {
      expect(hexToOklch(themes[id].canvas).l).toBeGreaterThanOrEqual(MIN_DARK_CANVAS_L - 0.006);
      expect(themes[id].canvas).not.toBe("#000000");
      expect(themes[id].ink).not.toBe("#ffffff");
    }
  });

  it("uses the owner's Azure accent: #339fee dark, #005fba light", () => {
    expect(themes.dark.accent).toBe("#339fee");
    expect(themes.light.accent).toBe("#005fba");
  });

  it("still tints surfaces, linings and ink for a deliberately tinted custom base", () => {
    for (const mode of ["dark", "light"] as const) {
      const base = { l: mode === "dark" ? 0.16 : 0.97, c: 0.03, h: 255 };
      const t = generateTheme({ ...THEME_INPUTS[mode], base });
      for (const k of ["surface-3", "lining", "ink-muted"] as const) {
        expect(hexToOklch(t[k]).c, `${mode} ${k} ${t[k]}`).toBeGreaterThan(0.004);
      }
    }
  });

  it("makes the default custom theme follow the neutral dark inputs", () => {
    expect(DEFAULT_CUSTOM.base).toEqual(THEME_INPUTS.dark.base);
    const { tokens } = generateCustom(DEFAULT_CUSTOM);
    expect(tokens.canvas).toBe(themes.dark.canvas);
    expect(tokens.accent).toBe(themes.dark.accent);
  });
});
