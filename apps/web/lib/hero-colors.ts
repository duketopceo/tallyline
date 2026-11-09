// Reads the landing hero's colors from the design tokens at runtime, so the 3D
// scene follows the active theme and never carries a color of its own. A token
// that cannot be read yields null and the hero stays on its static mark.

export interface HeroColors {
  /** the four tally strokes */
  stroke: number;
  /** the single strike through them */
  strike: number;
}

/** Parse a computed custom-property value (`#rrggbb`, `#rgb` or `rgb(r, g, b)`) into 0xRRGGBB. */
export function parseCssColor(value: string): number | null {
  const v = value.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(v);
  if (hex) {
    const h = hex[1]!;
    const full = h.length === 3 ? [...h].map((c) => c + c).join("") : h;
    return parseInt(full, 16);
  }
  const rgb = /^rgba?\(\s*(\d{1,3})[\s,]+(\d{1,3})[\s,]+(\d{1,3})/.exec(v);
  if (rgb) {
    const [r, g, b] = [rgb[1], rgb[2], rgb[3]].map((n) => Math.min(255, Number(n)));
    return ((r! << 16) | (g! << 8) | b!) >>> 0;
  }
  return null;
}

type StyleReader = (el: Element) => Pick<CSSStyleDeclaration, "getPropertyValue">;

export function readHeroColors(el: Element, getStyle: StyleReader = (e) => getComputedStyle(e)): HeroColors | null {
  const style = getStyle(el);
  const stroke = parseCssColor(style.getPropertyValue("--color-ink"));
  const strike = parseCssColor(style.getPropertyValue("--color-accent"));
  return stroke === null || strike === null ? null : { stroke, strike };
}
