import { describe, expect, it } from "vitest";
import { normalizeLogoInput } from "./project-logo";

// The helper reads window.location for relative URLs, so the tests run
// against a fixed origin.
const origin = "https://tallyline.app";
const withWindow = <T>(fn: () => T): T => {
  const g = globalThis as { window?: unknown };
  const had = "window" in g;
  g.window = { location: new URL(origin) };
  try {
    return fn();
  } finally {
    if (!had) delete g.window;
  }
};

describe("normalizeLogoInput", () => {
  it("keeps an absolute https URL", () => {
    expect(withWindow(() => normalizeLogoInput("https://example.com/mark.svg"))).toBe(
      "https://example.com/mark.svg",
    );
  });

  it("adds https when a host is pasted without a scheme", () => {
    expect(withWindow(() => normalizeLogoInput("example.com/mark.png"))).toBe(
      "https://example.com/mark.png",
    );
  });

  it("resolves a bare file name against the site", () => {
    expect(withWindow(() => normalizeLogoInput("brand/marks/wisp.svg"))).toBe(
      `${origin}/brand/marks/wisp.svg`,
    );
    expect(withWindow(() => normalizeLogoInput("mark.png"))).toBe(`${origin}/mark.png`);
  });

  it("accepts a protocol-relative URL", () => {
    expect(withWindow(() => normalizeLogoInput("//cdn.example.com/a.png"))).toBe(
      "https://cdn.example.com/a.png",
    );
  });

  it("upgrades same-origin http to https", () => {
    expect(withWindow(() => normalizeLogoInput(`http://tallyline.app/brand/x.png`))).toBe(
      `${origin}/brand/x.png`,
    );
  });

  it("rejects empty input and non-web schemes", () => {
    expect(withWindow(() => normalizeLogoInput("   "))).toBeNull();
    expect(withWindow(() => normalizeLogoInput("javascript:alert(1)"))).toBeNull();
    expect(withWindow(() => normalizeLogoInput("data:image/png;base64,AAAA"))).toBeNull();
  });
});
