import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import manifest from "./manifest";

describe("web app manifest", () => {
  const m = manifest();
  it("is installable: standalone display, start url inside scope, name", () => {
    expect(m.display).toBe("standalone");
    expect(m.name).toBe("Tallyline");
    expect(m.start_url?.startsWith(m.scope ?? "/")).toBe(true);
  });
  it("ships 192 and 512 icons that exist under public/", () => {
    const sizes = (m.icons ?? []).map((i) => i.sizes);
    expect(sizes).toEqual(expect.arrayContaining(["192x192", "512x512"]));
    for (const icon of m.icons ?? []) {
      expect(existsSync(resolve(__dirname, "../public", icon.src.replace(/^\//, ""))), icon.src).toBe(true);
    }
  });
});
