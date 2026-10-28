import { describe, expect, it } from "vitest";
import { githubOwnerIconUrl, normalizeIconUrl } from "./project-icon.js";

describe("githubOwnerIconUrl", () => {
  it("builds the owner avatar url", () => {
    expect(githubOwnerIconUrl("duketopceo/tallyline")).toBe("https://github.com/duketopceo.png?size=64");
  });
  it("rejects malformed names", () => {
    expect(githubOwnerIconUrl("nope")).toBeNull();
    expect(githubOwnerIconUrl("-bad/repo")).toBeNull();
    expect(githubOwnerIconUrl("a b/repo")).toBeNull();
  });
});

describe("normalizeIconUrl", () => {
  it("accepts public https", () => {
    expect(normalizeIconUrl("https://example.com/favicon.ico")).toBe("https://example.com/favicon.ico");
  });
  it.each([
    "http://example.com/a.png",
    "https://user:pw@example.com/a.png",
    "https://localhost/a.png",
    "https://127.0.0.1/a.png",
    "https://[::1]/a.png",
    "https://printer.local/a.png",
    "https://intranet/a.png",
    "javascript:alert(1)",
    "not a url",
    `https://example.com/${"a".repeat(2100)}`,
  ])("rejects %s", (u) => {
    expect(normalizeIconUrl(u)).toBeNull();
  });
});
