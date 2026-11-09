import { describe, expect, it } from "vitest";
import { levelClass, openLabel, safeLink, syncStatusText } from "./glitchtip-errors";

describe("glitchtip error display rules", () => {
  it("says what each sync status means in words", () => {
    expect(syncStatusText(null)).toBe("Not synced yet");
    expect(syncStatusText("ok")).toBe("Up to date");
    expect(syncStatusText("rate_limited")).toContain("slow down");
    expect(syncStatusText("something_new")).toBe("Sync status unknown");
  });

  it("marks a capped count with a plus", () => {
    expect(openLabel(3, false)).toBe("3 open");
    expect(openLabel(100, true)).toBe("100+ open");
  });

  it("colors only the serious levels", () => {
    expect(levelClass("error")).toBe("text-urgent");
    expect(levelClass("warning")).toBe("text-attention");
    expect(levelClass("info")).toBe("text-ink-muted");
  });

  it("refuses links that are not http(s)", () => {
    expect(safeLink("https://gt.example.com/acme/issues/1")).toBe("https://gt.example.com/acme/issues/1");
    expect(safeLink("javascript:alert(1)")).toBeNull();
    expect(safeLink("not a url")).toBeNull();
  });
});
