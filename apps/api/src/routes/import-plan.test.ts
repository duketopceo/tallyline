import { readFileSync } from "node:fs";
import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import type { PlanImportDiff } from "@tallyline/types";
import { app } from "../index.js";
import { db } from "../db/client.js";
import {
  events,
  githubIssueLinks,
  githubRepos,
  issueExternalRefs,
  issues,
  projectMilestones,
} from "../db/schema.js";
import { mkIssue, mkProject, seedTenant, type Tenant } from "../../test/tenants.js";

const SOURCE = { repo: "duketopceo/kate", path: "docs/plans/kp.md", sha: "abc1234" };

function plan(units: [string, string, string?][], extra = ""): string {
  return [
    "# Test plan",
    "",
    extra,
    "## Implementation Units",
    "",
    ...units.flatMap(([id, title, deps]) => [
      `### ${id}. ${title}`,
      "",
      `**Goal:** Goal of ${id}.`,
      "",
      `**Dependencies:** ${deps ?? "none"}.`,
      "",
      `**Verification:** check ${id}.`,
      "",
    ]),
  ].join("\n");
}

const FIVE: [string, string, string?][] = [
  ["U1", "Kill switch"],
  ["U2", "Creation throttles", "U1"],
  ["U3", "Usage guard cron", "U1"],
  ["U4", "Complete account deletion"],
  ["U5", "Bounded reads", "U2, U3"],
];

let t: Tenant;
let project: { id: string };

beforeEach(async () => {
  t = await seedTenant("imp", "IMP");
  project = await mkProject(t);
});

type Who = "owner" | "agent";
async function call(
  body: Record<string, unknown>,
  who: Who = "owner",
  slug = t.ws.slug,
): Promise<{ status: number; body: PlanImportDiff & { error?: { code: string }; diff?: PlanImportDiff } }> {
  const token = who === "owner" ? t.pats.write : t.agentKeys.write;
  const res = await app.fetch(
    new Request(`http://api.test/v1/workspaces/${slug}/import/plan`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, body: (await res.json()) as never };
}

function req(markdown: string, over: Record<string, unknown> = {}) {
  return {
    project: project.id,
    teamKey: t.team.key,
    plan: { scope: "KP", source: SOURCE, markdown },
    ...over,
  };
}

async function applyPlan(markdown: string, over: Record<string, unknown> = {}, who: Who = "owner") {
  const dry = await call(req(markdown, over), who);
  expect(dry.status).toBe(200);
  return call(req(markdown, { ...over, mode: "apply", diffHash: dry.body.diffHash }), who);
}

const issueRows = () => db.select().from(issues).where(eq(issues.workspaceId, t.ws.id));

describe("POST /import/plan", () => {
  it("dry-runs by default: reports five creates and writes nothing", async () => {
    const r = await call(req(plan(FIVE)));
    expect(r.status).toBe(200);
    expect(r.body.mode).toBe("dry_run");
    expect(r.body.counts).toMatchObject({ create: 5, update: 0, unchanged: 0, ambiguous: 0, invalid: 0 });
    expect(r.body.units.map((u) => u.scopedId)).toEqual(["KP-U1", "KP-U2", "KP-U3", "KP-U4", "KP-U5"]);
    expect(await issueRows()).toHaveLength(0);
    expect(await db.select().from(issueExternalRefs).where(eq(issueExternalRefs.workspaceId, t.ws.id))).toHaveLength(0);
  });

  it("apply creates five scoped issues with plan refs, then a second apply is all unchanged", async () => {
    const first = await applyPlan(plan(FIVE));
    expect(first.status).toBe(200);
    expect(first.body.counts.create).toBe(5);
    expect(first.body.applied!.created).toHaveLength(5);

    const rows = await issueRows();
    expect(rows).toHaveLength(5);
    expect(rows.map((r) => r.title).sort()).toContain("[KP-U2] Creation throttles");
    expect(rows.every((r) => r.projectId === project.id && r.state === "backlog")).toBe(true);
    const u2 = rows.find((r) => r.title.startsWith("[KP-U2]"))!;
    expect(u2.description).toContain("Goal of U2.");
    expect(u2.description).toContain("check U2.");
    expect(u2.description).toContain("duketopceo/kate");
    expect(u2.description).toContain("Depends on: KP-U1");

    const refs = await db.select().from(issueExternalRefs).where(eq(issueExternalRefs.workspaceId, t.ws.id));
    expect(refs.map((r) => `${r.system}:${r.externalId}`).sort()).toEqual(
      ["U1", "U2", "U3", "U4", "U5"].map((u) => `plan:duketopceo/kate:docs/plans/kp.md:${u}`),
    );

    const second = await applyPlan(plan(FIVE));
    expect(second.body.counts).toMatchObject({ create: 0, update: 0, unchanged: 5 });
    expect(await issueRows()).toHaveLength(5);
  });

  it("updates in place when a unit title changes", async () => {
    await applyPlan(plan(FIVE));
    const before = (await issueRows()).find((r) => r.title.startsWith("[KP-U4]"))!;
    const changed = FIVE.map((u) => (u[0] === "U4" ? (["U4", "Account deletion, complete"] as [string, string]) : u));
    const r = await applyPlan(plan(changed));
    expect(r.body.counts).toMatchObject({ create: 0, update: 1, unchanged: 4 });
    const after = (await issueRows()).find((row) => row.id === before.id)!;
    expect(after.title).toBe("[KP-U4] Account deletion, complete");
    expect(await issueRows()).toHaveLength(5);
  });

  it("two plans that both number a unit U1 do not collide (scope)", async () => {
    await applyPlan(plan([["U1", "Production thing"]]));
    const other = {
      plan: { scope: "KM", source: { ...SOURCE, path: "docs/plans/km.md" }, markdown: plan([["U1", "Monetization thing"]]) },
    };
    const dry = await call(req("", other));
    expect(dry.body.counts).toMatchObject({ create: 1, ambiguous: 0 });
    await call(req("", { ...other, mode: "apply", diffHash: dry.body.diffHash }));
    const titles = (await issueRows()).map((r) => r.title).sort();
    expect(titles).toEqual(["[KM-U1] Monetization thing", "[KP-U1] Production thing"]);
  });

  it("reports a bare-ID title with no scope as ambiguous and never merges it", async () => {
    const old = await mkIssue(t, { title: "[U3] Usage guard, written by hand", description: "no source here" });
    const r = await call(req(plan(FIVE)));
    const u3 = r.body.units.find((u) => u.unitId === "U3")!;
    expect(u3.action).toBe("ambiguous");
    expect(u3.candidates).toEqual([expect.objectContaining({ key: old.key, reason: "bare_id" })]);
    expect(r.body.counts).toMatchObject({ create: 4, ambiguous: 1 });
    const applied = await applyPlan(plan(FIVE));
    expect(applied.body.counts.ambiguous).toBe(1);
    expect(await issueRows()).toHaveLength(5); // the old issue + four new, none merged
  });

  it("treats a bare ID as a match when the issue description names the plan source", async () => {
    const old = await mkIssue(t, {
      title: "[U3] Usage guard",
      description: "from docs/plans/kp.md",
    });
    const r = await call(req(plan(FIVE)));
    expect(r.body.units.find((u) => u.unitId === "U3")).toMatchObject({
      action: "update",
      issueKey: old.key,
      matchedBy: "bare_id",
    });
  });

  it("matches a scoped ID already in a title", async () => {
    const old = await mkIssue(t, { title: "[KP-U2] Creation throttles, by hand" });
    const r = await call(req(plan(FIVE)));
    expect(r.body.units.find((u) => u.unitId === "U2")).toMatchObject({
      action: "update",
      issueKey: old.key,
      matchedBy: "scoped_id",
    });
  });

  it("resolves an ambiguous unit through `resolutions`, and the next dry run is unchanged", async () => {
    const old = await mkIssue(t, {
      title: "[U3] Usage guard, written by hand",
      description: "my hand-written notes",
    });
    const res = { resolutions: { "KP-U3": old.key } };
    const dry = await call(req(plan(FIVE), res));
    expect(dry.body.units.find((u) => u.unitId === "U3")).toMatchObject({
      action: "update",
      issueKey: old.key,
      matchedBy: "resolution",
    });
    const applied = await call(req(plan(FIVE), { ...res, mode: "apply", diffHash: dry.body.diffHash }));
    expect(applied.status).toBe(200);
    expect(await issueRows()).toHaveLength(5);
    const [adopted] = await db.select().from(issues).where(eq(issues.id, old.id));
    expect(adopted!.projectId).toBe(project.id);
    expect(adopted!.description).toBe("my hand-written notes"); // adopted issues keep their text

    const again = await call(req(plan(FIVE))); // no resolutions needed any more
    expect(again.body.units.find((u) => u.unitId === "U3")).toMatchObject({
      action: "unchanged",
      issueKey: old.key,
      matchedBy: "ref",
    });
    expect(again.body.counts).toMatchObject({ create: 0, update: 0, unchanged: 5 });
  });

  it("rejects a resolution that names an issue that does not exist", async () => {
    const r = await call(req(plan(FIVE), { resolutions: { "KP-U3": "IMP-99999" } }));
    expect(r.status).toBe(422);
    expect(r.body.error!.code).toBe("UNKNOWN_RESOLUTION");
  });

  it("returns 409 with the new diff when the world changed between dry run and apply", async () => {
    const dry = await call(req(plan(FIVE)));
    await mkIssue(t, { title: "[KP-U1] someone else made this", description: "x" });
    const r = await call(req(plan(FIVE), { mode: "apply", diffHash: dry.body.diffHash }));
    expect(r.status).toBe(409);
    expect(r.body.error!.code).toBe("STALE_DIFF");
    expect(r.body.diff!.diffHash).not.toBe(dry.body.diffHash);
    expect(r.body.diff!.units.find((u) => u.unitId === "U1")!.action).toBe("update");
    expect(await issueRows()).toHaveLength(1); // nothing written
  });

  it("refuses apply without a diff hash, and with a hash from different input", async () => {
    const none = await call(req(plan(FIVE), { mode: "apply" }));
    expect(none.status).toBe(400);
    expect(none.body.error!.code).toBe("DIFF_HASH_REQUIRED");
    const dry = await call(req(plan(FIVE)));
    const other = await call(req(plan(FIVE.slice(0, 4)), { mode: "apply", diffHash: dry.body.diffHash }));
    expect(other.status).toBe(409);
    expect(await issueRows()).toHaveLength(0);
  });

  it("matches an issue linked through github_issue_links and assigns it to the project", async () => {
    const gh = await mkIssue(t, { title: "Tab audit: Journal dead ends", description: "from GitHub" });
    const [repo] = await db
      .insert(githubRepos)
      .values({ workspaceId: t.ws.id, fullName: "duketopceo/kate-ios", enabled: true })
      .returning();
    await db.insert(githubIssueLinks).values({
      workspaceId: t.ws.id,
      repoId: repo!.id,
      ghIssueId: 9001,
      ghIssueNumber: 12,
      issueId: gh.id,
    });
    const md = plan(
      [["U9", "Every-tab audit and simplification"]],
      "",
    ).replace("**Goal:**", "**Goal:** Tracks https://github.com/duketopceo/kate-ios/issues/12 .");
    const r = await applyPlan(md);
    expect(r.body.units[0]).toMatchObject({ action: "update", issueKey: gh.key, matchedBy: "github_link" });
    expect(await issueRows()).toHaveLength(1);
    const [row] = await db.select().from(issues).where(eq(issues.id, gh.id));
    expect(row!.projectId).toBe(project.id);
    expect(row!.title).toBe("Tab audit: Journal dead ends");
  });

  it("reports a ~0.88 trigram title match as ambiguous and does not merge it", async () => {
    const old = await mkIssue(t, { title: "Add kill switch for signups and uploads page", description: "x" });
    const sim = await db.execute(
      sql`select similarity('add kill switch for signups and uploads', 'add kill switch for signups and uploads page') as s`,
    );
    expect((sim.rows[0] as { s: number }).s).toBeGreaterThanOrEqual(0.85);
    const r = await call(req(plan([["U1", "Add kill switch for signups and uploads"]])));
    const u1 = r.body.units[0]!;
    expect(u1.action).toBe("ambiguous");
    expect(u1.candidates![0]).toMatchObject({ key: old.key, reason: "similar_title" });
    expect(u1.candidates![0]!.score).toBeGreaterThanOrEqual(0.85);
    const applied = await applyPlan(plan([["U1", "Add kill switch for signups and uploads"]]));
    expect(applied.body.counts.ambiguous).toBe(1);
    expect(await issueRows()).toHaveLength(1);
  });

  it("does not report dissimilar titles", async () => {
    await mkIssue(t, { title: "Rewrite the onboarding flow", description: "x" });
    const r = await call(req(plan([["U1", "Kill switch"]])));
    expect(r.body.units[0]!.action).toBe("create");
  });

  describe("historical state and evidence", () => {
    const evidence = {
      U1: {
        state: "done",
        mergedAt: "2026-10-12T15:30:00.000Z",
        prs: [{ repo: "duketopceo/kate", number: 31, url: "https://github.com/duketopceo/kate/pull/31" }],
      },
      U2: { state: "in_progress" },
      U3: { state: "todo" },
    };

    it("refuses `historical` for an agent credential", async () => {
      const r = await call(req(plan(FIVE), { historical: true }), "agent");
      expect(r.status).toBe(403);
      expect(await issueRows()).toHaveLength(0);
    });

    it("refuses evidence marking a unit done from an agent key, and writes nothing", async () => {
      const dry = await call(req(plan(FIVE), { evidence }), "agent");
      expect(dry.status).toBe(403);
      const r = await call(req(plan(FIVE), { evidence, mode: "apply" }), "agent");
      expect(r.status).toBe(403);
      expect(await issueRows()).toHaveLength(0);
    });

    it("lets an agent supply backlog and todo evidence only", async () => {
      const r = await applyPlan(plan(FIVE), { evidence: { U3: { state: "todo" } } }, "agent");
      expect(r.status).toBe(200);
      const rows = await issueRows();
      expect(rows.find((x) => x.title.startsWith("[KP-U3]"))!.state).toBe("todo");
      expect(rows.find((x) => x.title.startsWith("[KP-U1]"))!.state).toBe("backlog");
      expect(rows.every((x) => x.creatorType === "agent")).toBe(true);
    });

    it("an owner's historical import writes done and in-progress issues with one imported event and a PR ref", async () => {
      const r = await applyPlan(plan(FIVE), { evidence, historical: true });
      expect(r.status).toBe(200);
      const rows = await issueRows();
      const u1 = rows.find((x) => x.title.startsWith("[KP-U1]"))!;
      expect(u1.state).toBe("done");
      expect(rows.find((x) => x.title.startsWith("[KP-U2]"))!.state).toBe("in_progress");
      expect(rows.find((x) => x.title.startsWith("[KP-U3]"))!.state).toBe("todo");

      const evs = await db
        .select()
        .from(events)
        .where(and(eq(events.workspaceId, t.ws.id), eq(events.entityId, u1.id)));
      expect(evs.map((e) => e.action)).toEqual(["imported"]);
      expect(evs[0]!.after).toMatchObject({
        state: "done",
        mergedAt: "2026-10-12T15:30:00.000Z",
        prs: [{ repo: "duketopceo/kate", number: 31 }],
      });
      expect(evs[0]!.createdAt.toISOString()).toBe("2026-10-12T15:30:00.000Z");

      const prRefs = await db
        .select()
        .from(issueExternalRefs)
        .where(and(eq(issueExternalRefs.workspaceId, t.ws.id), eq(issueExternalRefs.system, "github_pr")));
      expect(prRefs.map((p) => p.externalId)).toEqual([`duketopceo/kate#31:${u1.key}`]);
    });

    it("ignores done and in-progress evidence from an owner when `historical` is not set", async () => {
      const r = await applyPlan(plan(FIVE), { evidence });
      expect(r.status).toBe(200);
      expect(r.body.warnings.join(" ")).toMatch(/historical/);
      const rows = await issueRows();
      expect(rows.find((x) => x.title.startsWith("[KP-U1]"))!.state).toBe("backlog");
      expect(rows.find((x) => x.title.startsWith("[KP-U3]"))!.state).toBe("todo");
    });

    it("moves an existing issue forward only, and a re-run is unchanged", async () => {
      await applyPlan(plan(FIVE));
      const r = await applyPlan(plan(FIVE), { evidence, historical: true });
      expect(r.body.counts).toMatchObject({ create: 0, update: 3, unchanged: 2 });
      const again = await applyPlan(plan(FIVE), { evidence: { U1: { state: "todo" } }, historical: true });
      expect(again.body.counts.update).toBe(0); // done never moves back to todo
      const rows = await issueRows();
      expect(rows.find((x) => x.title.startsWith("[KP-U1]"))!.state).toBe("done");
    });

    it("warns about evidence for a unit that is not in the plan", async () => {
      const r = await call(req(plan(FIVE), { evidence: { U99: { state: "todo" } } }));
      expect(r.body.warnings.join(" ")).toMatch(/U99/);
    });
  });

  it("reports a unit with no title and imports the rest", async () => {
    const md = plan(FIVE.slice(0, 2)) + "\n### U9.\n\nbody\n";
    const r = await applyPlan(md);
    expect(r.body.counts).toMatchObject({ create: 2, invalid: 1 });
    expect(r.body.units.find((u) => u.unitId === "U9")).toMatchObject({ action: "invalid" });
    expect(await issueRows()).toHaveLength(2);
  });

  it("rejects a plan over the issue cap before any write", async () => {
    const many = Array.from({ length: 201 }, (_, i) => [`U${i + 1}`, `Unit number ${i + 1}`] as [string, string]);
    const r = await call(req(plan(many)));
    expect(r.status).toBe(422);
    expect(r.body.error!.code).toBe("PLAN_TOO_LARGE");
    expect(await issueRows()).toHaveLength(0);
  });

  it("rejects a plan with no units", async () => {
    const r = await call(req("# nothing here\n"));
    expect(r.status).toBe(422);
    expect(r.body.error!.code).toBe("NO_UNITS");
  });

  it("creates a milestone per phase and reuses it on the next run", async () => {
    const md = [
      "# P",
      "## Phase A",
      "### U1. One",
      "**Goal:** g",
      "## Phase B",
      "### U2. Two",
      "**Goal:** g",
    ].join("\n");
    const dry = await call(req(md));
    expect(dry.body.milestones).toEqual({ create: ["Phase A", "Phase B"], existing: [] });
    await applyPlan(md);
    const ms = await db.select().from(projectMilestones).where(eq(projectMilestones.projectId, project.id));
    expect(ms.map((m) => m.title).sort()).toEqual(["Phase A", "Phase B"]);
    const again = await call(req(md));
    expect(again.body.milestones).toEqual({ create: [], existing: ["Phase A", "Phase B"] });
  });

  it("resolves the project by name, 404s on an unknown or foreign project, and 404s on an unknown team", async () => {
    const [p] = [await mkProject(t)];
    const { name } = (await db.query.projects.findFirst({ where: (x, { eq: e }) => e(x.id, p.id) }))!;
    const byName = await call(req(plan(FIVE), { project: name }));
    expect(byName.status).toBe(200);

    const other = await seedTenant("imp2", "OTH");
    const foreign = await mkProject(other);
    const r = await call(req(plan(FIVE), { project: foreign.id }));
    expect(r.status).toBe(404);
    expect((await call(req(plan(FIVE), { project: "00000000-0000-4000-8000-000000000000" }))).status).toBe(404);
    expect((await call(req(plan(FIVE), { teamKey: "NOPE" }))).status).toBe(404);
    expect(await db.select().from(issues).where(eq(issues.workspaceId, other.ws.id))).toHaveLength(0);
  });

  it("rejects a malformed scope", async () => {
    const r = await call(req(plan(FIVE), { plan: { scope: "kp-1", source: SOURCE, markdown: plan(FIVE) } }));
    expect(r.status).toBe(400);
  });

  it("serializes two concurrent applies of the same plan: one writes, the other gets 409", async () => {
    const dry = await call(req(plan(FIVE)));
    const body = req(plan(FIVE), { mode: "apply", diffHash: dry.body.diffHash });
    const [a, b] = await Promise.all([call(body), call(body)]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(await issueRows()).toHaveLength(5);
  });

  describe("real ce-plan files (Kate)", () => {
    const fixture = (n: string) =>
      readFileSync(new URL(`../../../../packages/types/fixtures/plans/${n}`, import.meta.url), "utf8");
    const KP = fixture("2026-10-15-2155-feat-kate-production-launch-plan.md");
    const KM = fixture("2026-10-16-0000-feat-kate-monetization-growth-plan.md");

    it("imports both plans into one project under their own scopes, and re-runs unchanged", async () => {
      const kp = { plan: { scope: "KP", source: { ...SOURCE, path: "docs/plans/kp.md" }, markdown: KP } };
      const km = { plan: { scope: "KM", source: { ...SOURCE, path: "docs/plans/km.md" }, markdown: KM } };
      const first = await applyPlan("", kp);
      expect(first.body.counts).toMatchObject({ create: 15, ambiguous: 0, invalid: 0 });
      const second = await applyPlan("", km);
      expect(second.body.counts).toMatchObject({ create: 17, ambiguous: 0, invalid: 0 });

      const titles = (await issueRows()).map((r) => r.title);
      expect(titles).toHaveLength(32);
      expect(titles).toContain("[KP-U1] Kill switch");
      expect(titles.some((x) => x.startsWith("[KM-U16] Owner tier"))).toBe(true);

      const again = await call(req("", kp));
      expect(again.body.counts).toMatchObject({ create: 0, update: 0, unchanged: 15 });
      const againKm = await call(req("", km));
      expect(againKm.body.counts).toMatchObject({ create: 0, update: 0, unchanged: 17 });
      const u15 = (await issueRows()).find((r) => r.title.startsWith("[KP-U15]"))!;
      expect(u15.description).toContain("Depends on: KP-U1, KP-U2, KP-U3, KP-U4");
    });
  });
});
