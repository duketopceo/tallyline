import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { tokens } from "@tallyline/silver-lining";
import { describe, expect, it } from "vitest";
import manifest from "./manifest";

describe("web app manifest", () => {
  const m = manifest();
  it("is installable: standalone display, start url inside scope, name", () => {
    expect(m.display).toBe("standalone");
    expect(m.name).toBe("Tallyline");
    expect(m.start_url?.startsWith(m.scope ?? "/")).toBe(true);
  });
  it("uses the dark canvas for both colours (a manifest cannot be theme-aware)", () => {
    expect(m.background_color).toBe(tokens.dark.canvas);
    expect(m.theme_color).toBe(tokens.dark.canvas);
  });
  it("ships 192 and 512 icons that exist under public/", () => {
    const sizes = (m.icons ?? []).map((i) => i.sizes);
    expect(sizes).toEqual(expect.arrayContaining(["192x192", "512x512"]));
    for (const icon of m.icons ?? []) {
      expect(existsSync(resolve(__dirname, "../public", icon.src.replace(/^\//, ""))), icon.src).toBe(true);
    }
  });
});
