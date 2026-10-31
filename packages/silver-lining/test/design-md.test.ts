import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { deltaE } from "../src/color.ts";
import { THEME_INPUTS, buildThemes } from "../src/themes.ts";
import { buildCss, buildJson, buildTs } from "../src/emit.ts";

const root = (p: string) => new URL(`../${p}`, import.meta.url);
const designMd = readFileSync(new URL("../../../DESIGN.md", import.meta.url), "utf8");
const front = designMd.split("\n---\n")[0]!;
const designColors = new Map<string, string>();
for (const m of front.matchAll(/^ {2}([a-z0-9-]+): "(#[0-9a-f]{6})"$/gm)) designColors.set(m[1]!, m[2]!);

describe("DESIGN.md stays in sync with the generator (within deltaE 2)", () => {
  const themes = buildThemes();
  const light: Record<string, string> = {
    "light-canvas": "canvas",
    "light-surface-1": "surface-1",
    "light-surface-2": "surface-2",
    "light-surface-3": "surface-3",
    "light-surface-4": "surface-4",
    "light-ink": "ink",
    "light-ink-muted": "ink-muted",
    "light-ink-subtle": "ink-subtle",
    "light-lining-faint": "lining-faint",
    "light-lining": "lining",
    "light-lining-strong": "lining-strong",
    "light-lining-bright": "lining-bright",
    "light-accent": "accent",
    "light-accent-hover": "accent-hover",
  };
  it("dark values", () => {
    let n = 0;
    for (const [k, v] of designColors) {
      if (k.startsWith("light-") || !(k in themes.dark)) continue;
      n++;
      expect(deltaE(v, themes.dark[k as keyof typeof themes.dark]), k).toBeLessThanOrEqual(2);
    }
    expect(n).toBeGreaterThan(20);
  });
  it("light values", () => {
    for (const [k, t] of Object.entries(light)) {
      const v = designColors.get(k);
      expect(v, k).toBeDefined();
      expect(deltaE(v!, themes.light[t as keyof typeof themes.light]), k).toBeLessThanOrEqual(2);
    }
  });
  it("dark input matches the spec defaults", () => {
    expect(THEME_INPUTS.dark.contrast).toBe(30);
    expect(THEME_INPUTS.dark.base).toEqual({ l: 0.16, c: 0, h: 0 });
    expect(THEME_INPUTS["hc-dark"].contrast).toBe(70);
  });
});

describe("checked-in outputs are current", () => {
  it("silver-lining.css, tokens.json, tokens.generated.ts match the generator", () => {
    expect(readFileSync(root("silver-lining.css"), "utf8")).toBe(buildCss());
    expect(readFileSync(root("tokens.json"), "utf8")).toBe(buildJson());
    expect(readFileSync(root("src/tokens.generated.ts"), "utf8")).toBe(buildTs());
  });
});
