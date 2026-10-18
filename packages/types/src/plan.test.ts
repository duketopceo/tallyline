import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parsePlan } from "./plan.js";

const fixture = (name: string) =>
  readFileSync(new URL(`../fixtures/plans/${name}`, import.meta.url), "utf8");

const PRODUCTION = fixture("2026-10-15-2155-feat-kate-production-launch-plan.md");
const MONETIZATION = fixture("2026-10-16-0000-feat-kate-monetization-growth-plan.md");

describe("parsePlan on the Kate production launch plan", () => {
  const plan = parsePlan(PRODUCTION);

  it("reads the title from front matter or the first heading", () => {
    expect(plan.title).toBe("Kate Production Launch for 10k Users - Plan");
  });

  it("finds U1-U15 in order, with titles", () => {
    expect(plan.units.map((u) => u.id)).toEqual(
      Array.from({ length: 15 }, (_, i) => `U${i + 1}`),
    );
    expect(plan.units[0]).toMatchObject({ id: "U1", title: "Kill switch" });
    expect(plan.units[14]!.title).toBe("Production rollout and Luke's checklist");
  });

  it("captures goal, verification, files and dependencies", () => {
    const u1 = plan.units[0]!;
    expect(u1.goal).toMatch(/pause sign-ups, uploads or all writes/);
    expect(u1.verification).toBeTruthy();
    expect(u1.files).toContain("drizzle/migrations/0049_system_flags.sql");
    expect(u1.dependencies).toEqual([]);
    expect(plan.units.find((u) => u.id === "U2")!.dependencies).toEqual(["U1"]);
    expect(plan.units.find((u) => u.id === "U8")!.dependencies).toEqual(["U3", "U6"]);
  });

  it("expands ranges in a dependency line", () => {
    expect(plan.units.find((u) => u.id === "U15")!.dependencies).toEqual(
      expect.arrayContaining(["U1", "U2", "U3", "U4"]),
    );
  });

  it("does not report problems on a well-formed plan", () => {
    expect(plan.problems).toEqual([]);
  });
});

describe("parsePlan on the Kate monetization plan", () => {
  const plan = parsePlan(MONETIZATION);

  it("finds U16-U32", () => {
    expect(plan.units.map((u) => u.id)).toEqual(
      Array.from({ length: 17 }, (_, i) => `U${i + 16}`),
    );
  });

  it("reads dependencies from the label, ignoring 'none'", () => {
    const byId = Object.fromEntries(plan.units.map((u) => [u.id, u]));
    expect(byId.U16!.dependencies).toEqual([]);
    expect(byId.U17!.dependencies).toEqual(["U16"]);
    expect(byId.U20!.dependencies).toEqual(["U17", "U19"]);
  });

  it("extracts Luke actions as a numbered list with the slice flag and group", () => {
    expect(plan.lukeActions.length).toBeGreaterThan(20);
    expect(plan.lukeActions[0]).toMatchObject({
      number: 1,
      slice: true,
      group: "App Store Connect and Apple",
    });
    expect(plan.lukeActions[0]!.text).toMatch(/Paid Apps Agreement/);
    expect(plan.lukeActions[4]).toMatchObject({ number: 5, slice: false });
    expect(plan.lukeActions.find((a) => a.number === 13)!.group).toBe("Stripe");
  });
});

describe("parsePlan on the roadmap shape and edge cases", () => {
  const ROADMAP = [
    "# Roadmap Plan",
    "",
    "## Planning Contract",
    "",
    "### Phase map and the PM-ready slice",
    "",
    "| Phase | Window | Units | Exit gate |",
    "|---|---|---|---|",
    "| 0 Safe | days 1-5 | U1, U2 | backups |",
    "| 1 PM-ready slice | days 4-12 | U3 | Kate tracked |",
    "",
    "## Implementation Units",
    "",
    "| U-ID | Title | Files touched (key) | Depends on |",
    "|---|---|---|---|",
    "| U1 | First | `a.ts` | none |",
    "| U2 | Second | `b.ts` | U1 |",
    "| U3 | Third | `c.ts` | U1, U2 |",
    "",
    "### U1. First",
    "",
    "- **Goal:** do the first thing. (R1)",
    "- **Files:** `a.ts`, `a.test.ts`.",
    "- **Verification:** `pnpm test`.",
    "",
    "### U2. Second",
    "",
    "- **Goal:** do the second thing.",
    "- **Approach:** see https://github.com/duketopceo/kate-ios/issues/12 and duketopceo/kate#7.",
    "",
    "### U3. Third",
    "",
    "Legacy body with no labels at all.",
    "",
  ].join("\n");

  it("reads dependencies from the overview table when no label exists", () => {
    const plan = parsePlan(ROADMAP);
    const byId = Object.fromEntries(plan.units.map((u) => [u.id, u]));
    expect(byId.U1!.dependencies).toEqual([]);
    expect(byId.U2!.dependencies).toEqual(["U1"]);
    expect(byId.U3!.dependencies).toEqual(["U1", "U2"]);
  });

  it("reads bullet-style labels and a legacy unlabeled body", () => {
    const plan = parsePlan(ROADMAP);
    expect(plan.units[0]!.goal).toBe("do the first thing. (R1)");
    expect(plan.units[0]!.files).toEqual(["a.ts", "a.test.ts"]);
    expect(plan.units[2]!.goal).toBe("Legacy body with no labels at all.");
  });

  it("maps phase table rows to units", () => {
    const plan = parsePlan(ROADMAP);
    expect(plan.phases).toEqual([
      { name: "0 Safe", unitIds: ["U1", "U2"] },
      { name: "1 PM-ready slice", unitIds: ["U3"] },
    ]);
  });

  it("finds GitHub issue references in a unit body", () => {
    const plan = parsePlan(ROADMAP);
    expect(plan.units[1]!.githubIssues).toEqual([
      { repo: "duketopceo/kate-ios", number: 12 },
      { repo: "duketopceo/kate", number: 7 },
    ]);
  });

  it("maps units under a Phase heading", () => {
    const plan = parsePlan(
      ["# P", "", "## Phase A", "", "### U1. One", "", "**Goal:** g", "", "## Phase B: later", "", "### U2. Two", ""].join("\n"),
    );
    expect(plan.phases).toEqual([
      { name: "Phase A", unitIds: ["U1"] },
      { name: "Phase B: later", unitIds: ["U2"] },
    ]);
  });

  it("reports a unit with no title and a duplicate id, and keeps the rest", () => {
    const plan = parsePlan(
      ["# P", "", "### U1.", "", "body", "", "### U2. Fine", "", "### U2. Again", ""].join("\n"),
    );
    expect(plan.units.map((u) => u.id)).toEqual(["U2"]);
    expect(plan.problems.map((p) => [p.unitId, p.code])).toEqual([
      ["U1", "MISSING_TITLE"],
      ["U2", "DUPLICATE_ID"],
    ]);
  });

  it("returns no units for a document with none", () => {
    expect(parsePlan("# Nothing here\n").units).toEqual([]);
  });

  it("does not read headings inside fenced code blocks", () => {
    const plan = parsePlan(["# P", "", "```", "### U9. Not real", "```", "", "### U1. Real", ""].join("\n"));
    expect(plan.units.map((u) => u.id)).toEqual(["U1"]);
  });
});

describe("parsePlan performance on hostile input", () => {
  const timed = (fn: () => void) => {
    const t0 = performance.now();
    fn();
    return performance.now() - t0;
  };

  it("handles a heading followed by a 100KB run of spaces", () => {
    const md = `### U1. Title${" ".repeat(100_000)}x\n\n### U2. Next\n`;
    let ids: string[] = [];
    const ms = timed(() => {
      ids = parsePlan(md).units.map((u) => u.id);
    });
    expect(ms).toBeLessThan(200);
    expect(ids).toContain("U2");
  });

  it("handles a plain heading with a 100KB run of spaces and hashes", () => {
    const md = `## Heading${" #".repeat(50_000)} x\n### U1. Fine\n`;
    expect(timed(() => parsePlan(md))).toBeLessThan(200);
  });

  it("handles a table with many rows", () => {
    const rows = Array.from({ length: 20_000 }, (_, i) => `| U${i} | t | U1 |`);
    const md = ["| U-ID | Title | Depends on |", "|---|---|---|", ...rows, "### U1. One\n"].join("\n");
    expect(timed(() => parsePlan(md))).toBeLessThan(200);
  });

  it("handles thousands of repeated table headers", () => {
    const md = Array.from({ length: 5_000 }, () => "| U-ID | Depends on |").join("\n");
    expect(timed(() => parsePlan(md))).toBeLessThan(200);
  });

  it("truncates very long lines and ignores lines past the cap", () => {
    const md = `### U1. ${"a".repeat(5_000)}\n` + "x\n".repeat(200_000) + "### U2. Late\n";
    const plan = parsePlan(md);
    expect(plan.units[0]!.title.length).toBeLessThanOrEqual(2_000);
    expect(plan.units.map((u) => u.id)).toEqual(["U1"]);
  });
});

