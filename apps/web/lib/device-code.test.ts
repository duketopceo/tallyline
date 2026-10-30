import { describe, expect, it } from "vitest";
import { CODE_RE, SLUG_RE, approvableWorkspaces, parseUserCode } from "./device-code";

describe("parseUserCode", () => {
  it("accepts any casing, spacing and dashes", () => {
    expect(parseUserCode("bcdf-g2h3")).toBe("BCDF-G2H3");
    expect(parseUserCode(" BCDFG2H3 ")).toBe("BCDF-G2H3");
    expect(parseUserCode("bcdf g2h3")).toBe("BCDF-G2H3");
  });
  it("rejects things that cannot be a code", () => {
    for (const bad of ["", "BCDF", "BCDF-G2H3X", "BCDF-G2H!", "../../etc", undefined, null]) {
      expect(parseUserCode(bad), String(bad)).toBeNull();
    }
  });
});

describe("approvableWorkspaces", () => {
  it("keeps admin and owner roles in live workspaces only", () => {
    const out = approvableWorkspaces([
      { workspaceSlug: "a", workspaceName: "Alpha", role: "owner" },
      { workspaceSlug: "b", role: "admin" },
      { workspaceSlug: "c", role: "member" },
      { workspaceSlug: "d", role: "admin", deletedAt: "2026-10-01T00:00:00Z" },
    ]);
    expect(out).toEqual([
      { slug: "a", name: "Alpha" },
      { slug: "b", name: "b" },
    ]);
  });
  it("copes with no memberships", () => {
    expect(approvableWorkspaces(undefined)).toEqual([]);
  });
});

describe("bridge path guards", () => {
  it("only plain slugs and codes become part of an upstream path", () => {
    expect(SLUG_RE.test("ada")).toBe(true);
    expect(SLUG_RE.test("my-team-2")).toBe(true);
    for (const bad of ["", "../x", "a/b", "A", "-x", "a b", "x".repeat(64)]) expect(SLUG_RE.test(bad), bad).toBe(false);
    expect(CODE_RE.test("BCDF-G2H3")).toBe(true);
    for (const bad of ["", "a/b", "..", "BC", "x".repeat(17), "a?b"]) expect(CODE_RE.test(bad), bad).toBe(false);
  });
});
