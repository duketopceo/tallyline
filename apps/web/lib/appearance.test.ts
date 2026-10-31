import { DEFAULT_APPEARANCE, DEFAULT_CUSTOM, generateCustom, tokens } from "@tallyline/silver-lining";
import { describe, expect, it } from "vitest";
import { resolvedMode, themeColorsFor } from "./appearance";

describe("themeColorsFor", () => {
  it("defaults to a light/dark media pair of the generated canvases", () => {
    expect(DEFAULT_APPEARANCE).toEqual({ theme: "system" });
    expect(themeColorsFor(DEFAULT_APPEARANCE)).toEqual([
      { color: tokens.light.canvas, media: "(prefers-color-scheme: light)" },
      { color: tokens.dark.canvas, media: "(prefers-color-scheme: dark)" },
    ]);
  });

  it("uses one unconditional colour for an explicit choice", () => {
    expect(themeColorsFor({ theme: "light" })).toEqual([{ color: tokens.light.canvas }]);
    expect(themeColorsFor({ theme: "dark" })).toEqual([{ color: tokens.dark.canvas }]);
    expect(themeColorsFor({ theme: "hc-dark" })).toEqual([{ color: tokens["hc-dark"].canvas }]);
    expect(themeColorsFor({ theme: "custom", custom: DEFAULT_CUSTOM })).toEqual([
      { color: generateCustom(DEFAULT_CUSTOM).tokens.canvas },
    ]);
  });

  it("keeps the light and dark canvases distinct", () => {
    expect(tokens.light.canvas).not.toBe(tokens.dark.canvas);
  });
});

describe("resolvedMode", () => {
  it("follows the OS only for system", () => {
    expect(resolvedMode({ theme: "system" }, true)).toBe("light");
    expect(resolvedMode({ theme: "system" }, false)).toBe("dark");
    expect(resolvedMode({ theme: "dark" }, true)).toBe("dark");
    expect(resolvedMode({ theme: "light" }, false)).toBe("light");
    expect(resolvedMode({ theme: "hc-dark" }, true)).toBe("dark");
  });
});
