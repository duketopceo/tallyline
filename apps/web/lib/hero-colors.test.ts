import { describe, expect, it } from "vitest";
import { parseCssColor, readHeroColors } from "./hero-colors";

const style = (vars: Record<string, string>) => () => ({ getPropertyValue: (k: string) => vars[k] ?? "" });

describe("parseCssColor", () => {
  it("parses six- and three-digit hex", () => {
    expect(parseCssColor("#339fee")).toBe(0x339fee);
    expect(parseCssColor(" #FA0 ")).toBe(0xffaa00);
  });
  it("parses rgb() and rgba()", () => {
    expect(parseCssColor("rgb(51, 159, 238)")).toBe(0x339fee);
    expect(parseCssColor("rgba(0 0 0 / 0.5)")).toBe(0);
  });
  it("returns null for anything else", () => {
    expect(parseCssColor("")).toBeNull();
    expect(parseCssColor("var(--sl-accent)")).toBeNull();
    expect(parseCssColor("oklch(0.7 0.1 240)")).toBeNull();
  });
});

describe("readHeroColors", () => {
  const el = {} as Element;
  it("reads the ink and accent tokens", () => {
    const c = readHeroColors(el, style({ "--color-ink": "#e5e5e5", "--color-accent": "#339fee" }));
    expect(c).toEqual({ stroke: 0xe5e5e5, strike: 0x339fee });
  });
  it("returns null when a token is missing, so the caller keeps the static mark", () => {
    expect(readHeroColors(el, style({ "--color-ink": "#e5e5e5" }))).toBeNull();
    expect(readHeroColors(el, style({}))).toBeNull();
  });
});
