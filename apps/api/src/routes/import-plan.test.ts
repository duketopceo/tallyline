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

  it("links each unit's issue to its phase milestone, and a re-import changes nothing (U16)", async () => {
    const md = ["# P", "## Phase A", "### U1. One", "**Goal:** g", "## Phase B", "### U2. Two", "**Goal:** g"].join("\n");
    const first = await applyPlan(md);
    expect(first.status).toBe(200);
    const ms = await db.select().from(projectMilestones).where(eq(projectMilestones.projectId, project.id));
    const idOf = (title: string) => ms.find((m) => m.title === title)!.id;
    const rows = await issueRows();
    expect(rows.find((r) => r.title.startsWith("[KP-U1]"))!.milestoneId).toBe(idOf("Phase A"));
    expect(rows.find((r) => r.title.startsWith("[KP-U2]"))!.milestoneId).toBe(idOf("Phase B"));
    const again = await applyPlan(md);
    expect(again.body.counts).toMatchObject({ create: 0, update: 0, unchanged: 2 });
  });

  it("adopts an existing unmilestoned issue into the phase, but keeps a hand-set milestone (U16)", async () => {
    const md = ["# P", "## Phase A", "### U1. One", "**Goal:** g", "### U2. Two", "**Goal:** g"].join("\n");
    await applyPlan(md);
    const [a] = await db.select().from(projectMilestones).where(and(eq(projectMilestones.projectId, project.id), eq(projectMilestones.title, "Phase A")));
    const [other] = await db.insert(projectMilestones).values({ workspaceId: t.ws.id, projectId: project.id, title: "Hand" }).returning();
    const rows = await issueRows();
    const u1 = rows.find((r) => r.title.startsWith("[KP-U1]"))!;
    const u2 = rows.find((r) => r.title.startsWith("[KP-U2]"))!;
    // U1 loses its milestone, U2 is moved by hand; edit U2's text so the import no longer owns it
    await db.update(issues).set({ milestoneId: null }).where(eq(issues.id, u1.id));
    await db.update(issues).set({ milestoneId: other!.id, title: "[KP-U2] Two (edited)" }).where(eq(issues.id, u2.id));
    const r = await applyPlan(md);
    expect(r.status).toBe(200);
    const after = await issueRows();
    expect(after.find((x) => x.id === u1.id)!.milestoneId).toBe(a!.id);
    expect(after.find((x) => x.id === u2.id)!.milestoneId).toBe(other!.id);
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

describe("hardening", () => {
  const post = async (body: string, who: Who = "owner") => {
    const token = who === "owner" ? t.pats.write : t.agentKeys.write;
    return app.fetch(
      new Request(`http://api.test/v1/workspaces/${t.ws.slug}/import/plan`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body,
      }),
    );
  };

  it("accepts only https source urls", async () => {
    for (const url of ["javascript:alert(1)", "http://example.com/p.md", "data:text/html,x"]) {
      const r = await call(req(plan(FIVE), { plan: { scope: "KP", source: { ...SOURCE, url }, markdown: plan(FIVE) } }));
      expect(r.status, url).toBe(400);
    }
    const ok = await call(
      req(plan(FIVE), { plan: { scope: "KP", source: { ...SOURCE, url: "https://github.com/duketopceo/kate/blob/x/p.md" }, markdown: plan(FIVE) } }),
    );
    expect(ok.status).toBe(200);
  });

  it("builds PR urls from repo and number, ignoring any supplied url", async () => {
    const evidence = { U1: { state: "done", prs: [{ repo: "duketopceo/kate", number: 31, url: "javascript:alert(1)" }] } };
    const r = await applyPlan(plan(FIVE), { evidence, historical: true });
    expect(r.status).toBe(200);
    const [ref] = await db
      .select()
      .from(issueExternalRefs)
      .where(and(eq(issueExternalRefs.workspaceId, t.ws.id), eq(issueExternalRefs.system, "github_pr")));
    expect(ref!.url).toBe("https://github.com/duketopceo/kate/pull/31");
  });

  it("keeps a manually edited imported issue, applies the other changes, and warns", async () => {
    await applyPlan(plan(FIVE));
    const row = (await issueRows()).find((x) => x.title.startsWith("[KP-U2]"))!;
    await db.update(issues).set({ description: `${row.description}\n\nMy own notes.` }).where(eq(issues.id, row.id));

    const changed = FIVE.map((u) => (u[0] === "U2" ? (["U2", "Throttles renamed"] as [string, string]) : u));
    const r = await applyPlan(plan(changed), { evidence: { U2: { state: "todo" } } });
    expect(r.status).toBe(200);
    expect(r.body.warnings.join(" ")).toMatch(/KP-U2.*edited/);
    const after = (await issueRows()).find((x) => x.id === row.id)!;
    expect(after.title).toBe("[KP-U2] Creation throttles");
    expect(after.description).toContain("My own notes.");
    expect(after.state).toBe("todo"); // state still follows evidence
  });

  it("still updates an imported issue nobody edited", async () => {
    await applyPlan(plan(FIVE));
    const changed = FIVE.map((u) => (u[0] === "U2" ? (["U2", "Throttles renamed"] as [string, string]) : u));
    const r = await applyPlan(plan(changed));
    expect(r.body.counts.update).toBe(1);
    expect(r.body.warnings).toEqual([]);
  });

  it("rejects a request body over 2MB with 413", async () => {
    const big = JSON.stringify({ project: project.id, pad: "x".repeat(2_200_000) });
    const res = await post(big);
    expect(res.status).toBe(413);
  });

  it("caps evidence and resolutions at 200 keys", async () => {
    const evidence = Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`U${i + 1}`, { state: "todo" }]));
    expect((await call(req(plan(FIVE), { evidence }))).status).toBe(400);
    const resolutions = Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`KP-U${i + 1}`, "IMP-1"]));
    expect((await call(req(plan(FIVE), { resolutions }))).status).toBe(400);
  });

  it("rejects two units that resolve to the same issue with 422", async () => {
    const old = await mkIssue(t, { title: "Shared issue", description: "x" });
    const r = await call(req(plan(FIVE), { resolutions: { "KP-U1": old.key, "KP-U2": old.key } }));
    expect(r.status).toBe(422);
    expect(r.body.error!.code).toBe("DUPLICATE_MATCH");
  });

  it("creates a shared phase milestone once under concurrent imports of different plans", async () => {
    const md = (n: string) => ["# P", "## Phase A", `### U1. ${n}`, "**Goal:** g"].join("\n");
    const run = async (path: string, scope: string, title: string) => {
      const base = { plan: { scope, source: { ...SOURCE, path }, markdown: md(title) } };
      const dry = await call(req("", base));
      return call(req("", { ...base, mode: "apply", diffHash: dry.body.diffHash }));
    };
    const results = await Promise.all([run("a.md", "AA", "One"), run("b.md", "BB", "Two")]);
    // the loser may see a changed diff (the milestone now exists) and get 409; never a 500
    expect(results.map((r) => r.status).every((c) => c === 200 || c === 409)).toBe(true);
    expect(results.some((r) => r.status === 200)).toBe(true);
    const ms = await db.select().from(projectMilestones).where(eq(projectMilestones.projectId, project.id));
    expect(ms.map((m) => m.title)).toEqual(["Phase A"]);
  });

  it("forbids PR and merge-date evidence from an agent key, and writes nothing", async () => {
    for (const evidence of [
      { U1: { prs: [{ repo: "duketopceo/kate", number: 1 }] } },
      { U1: { mergedAt: "2026-10-01T00:00:00.000Z" } },
    ]) {
      const r = await call(req(plan(FIVE), { evidence }), "agent");
      expect(r.status).toBe(403);
    }
    expect(await issueRows()).toHaveLength(0);
  });

  it("rejects a future mergedAt", async () => {
    const r = await call(
      req(plan(FIVE), { evidence: { U1: { state: "done", mergedAt: "2099-01-01T00:00:00.000Z" } }, historical: true }),
    );
    expect(r.status).toBe(422);
    expect(r.body.error!.code).toBe("INVALID_EVIDENCE");
  });

  it("does not offer a plan's own issues as fuzzy matches for a new unit", async () => {
    await applyPlan(plan([["U1", "Add kill switch for signups and uploads"]]));
    const r = await applyPlan(
      plan([
        ["U1", "Add kill switch for signups and uploads"],
        ["U2", "Add kill switch for signups and uploads page"],
      ]),
    );
    expect(r.body.counts).toMatchObject({ create: 1, ambiguous: 0, unchanged: 1 });
  });

  it("does not match a github link whose rows point into another workspace", async () => {
    const other = await seedTenant("imp3", "OT3");
    const foreignIssue = await mkIssue(other, { title: "Foreign tab audit", description: "x" });
    const [foreignRepo] = await db
      .insert(githubRepos)
      .values({ workspaceId: other.ws.id, fullName: "duketopceo/kate-ios", enabled: true })
      .returning();
    // inconsistent row: stamped with our workspace, pointing at B's repo and issue
    await db.insert(githubIssueLinks).values({
      workspaceId: t.ws.id,
      repoId: foreignRepo!.id,
      ghIssueId: 777,
      ghIssueNumber: 12,
      issueId: foreignIssue.id,
    });
    const md = plan([["U9", "Every-tab audit"]]).replace(
      "**Goal:**",
      "**Goal:** https://github.com/duketopceo/kate-ios/issues/12",
    );
    const r = await call(req(md));
    expect(r.body.units[0]!.action).toBe("create");
  });

  it("rolls everything back when a write fails mid-apply", async () => {
    const md = ["# P", "## Phase A", ...FIVE.flatMap(([id, title]) => [`### ${id}. ${title}`, "**Goal:** g"])].join("\n");
    await db.execute(sql`
      create function tly_fail_u3() returns trigger language plpgsql as $$
      begin raise exception 'forced failure'; end $$`);
    await db.execute(
      sql`create trigger tly_fail_u3 before insert on issues for each row when (new.title like '[KP-U3]%') execute function tly_fail_u3()`,
    );
    try {
      const dry = await call(req(md));
      const r = await call(req(md, { mode: "apply", diffHash: dry.body.diffHash }));
      expect(r.status).toBe(500);
    } finally {
      await db.execute(sql`drop trigger tly_fail_u3 on issues`);
      await db.execute(sql`drop function tly_fail_u3()`);
    }
    expect(await issueRows()).toHaveLength(0);
    expect(await db.select().from(issueExternalRefs).where(eq(issueExternalRefs.workspaceId, t.ws.id))).toHaveLength(0);
    expect(await db.select().from(projectMilestones).where(eq(projectMilestones.projectId, project.id))).toHaveLength(0);
    const { teams } = await import("../db/schema.js");
    const [team] = await db.select().from(teams).where(eq(teams.id, t.team.id));
    expect(team!.nextIssueNumber).toBe(1);
  });
});
