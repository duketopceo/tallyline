import { describe, expect, it } from "vitest";
import { issueLink, pathAfterMove } from "./issue-link";

describe("issueLink", () => {
  it("copies the API url", () => {
    expect(issueLink({ url: "https://app.example/issues/ENG-4" }, "http://x/y")).toBe("https://app.example/issues/ENG-4");
  });
  it("falls back when the server sends no url", () => {
    expect(issueLink({}, "http://x/issues/ENG-4")).toBe("http://x/issues/ENG-4");
    expect(issueLink({ url: null }, "http://x/issues/ENG-4")).toBe("http://x/issues/ENG-4");
  });
});

describe("pathAfterMove", () => {
  it("moves the open issue page to the new key", () => {
    expect(pathAfterMove("/issues/ENG-4", "ENG-4", "OPS-9")).toBe("/issues/OPS-9");
  });
  it("leaves other pages and unchanged keys alone", () => {
    expect(pathAfterMove("/issues", "ENG-4", "OPS-9")).toBeNull();
    expect(pathAfterMove("/issues/ENG-4", "ENG-4", "ENG-4")).toBeNull();
    expect(pathAfterMove("/issues/ENG-4", "ENG-4", undefined)).toBeNull();
  });
});
