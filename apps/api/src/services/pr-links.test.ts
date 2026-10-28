import { describe, expect, it } from "vitest";
import { parsePrReferences, prLinkState } from "./pr-links.js";

describe("parsePrReferences", () => {
  it("reads a key at the start of the branch, any case", () => {
    expect(parsePrReferences({ branch: "tly-42-fix-it" }).branchKey).toBe("TLY-42");
    expect(parsePrReferences({ branch: "TLY-42" }).branchKey).toBe("TLY-42");
    expect(parsePrReferences({ branch: "feat/tly-42" }).branchKey).toBeNull();
    expect(parsePrReferences({ branch: "tly-42x-nope" }).branchKey).toBeNull();
  });

  it("separates closing keywords from plain references", () => {
    const r = parsePrReferences({
      title: "[TLY-1] add search",
      body: "Closes TLY-42 and TLY-43.\nFixes: ENG-7\nRefs TLY-50, see also KAT-2",
    });
    expect(r.closes.sort()).toEqual(["ENG-7", "TLY-42", "TLY-43"]);
    expect(r.refs.sort()).toEqual(["KAT-2", "TLY-1", "TLY-50"]);
  });

  it("is case-insensitive on keywords and keys, and handles every closing verb", () => {
    for (const verb of ["close", "closes", "closed", "fix", "fixes", "fixed", "resolve", "resolves", "resolved"]) {
      expect(parsePrReferences({ body: `${verb} tly-9` }).closes, verb).toEqual(["TLY-9"]);
    }
  });

  it("does not count a branch key twice and ignores text with no key", () => {
    const r = parsePrReferences({ branch: "tly-3-x", title: "TLY-3 thing", body: "Closes TLY-3" });
    expect(r).toEqual({ branchKey: "TLY-3", closes: [], refs: [] });
    expect(parsePrReferences({ title: "fixes the build", body: null })).toEqual({ branchKey: null, closes: [], refs: [] });
  });
});

describe("prLinkState", () => {
  it("maps webhook actions to a chip state", () => {
    expect(prLinkState({ merged: true }, "closed")).toBe("merged");
    expect(prLinkState({ merged: false }, "closed")).toBe("closed");
    expect(prLinkState({ draft: true }, "opened")).toBe("draft");
    expect(prLinkState({}, "synchronize")).toBe("open");
  });
});
