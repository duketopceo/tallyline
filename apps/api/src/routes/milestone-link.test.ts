import { readFileSync } from "node:fs";
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { app } from "../index.js";
import { db } from "../db/client.js";
import { issues, labels } from "../db/schema.js";
import { mkIssue, mkLabel, mkMilestone, mkProject, seedTenant, type Tenant } from "../../test/tenants.js";

// U16: issues.milestone_id, milestone progress from linked issues, hitl label.

let t: Tenant;

interface Body {
  key?: string;
  milestoneId?: string | null;
  error: { code: string };
  issues: { key: string }[];
  milestones: { id: string; progress: { total: number; done: number } }[];
}

async function call(method: string, path: string, body?: unknown) {
  const res = await app.fetch(
    new Request(`http://api.test/v1/workspaces/${t.ws.slug}${path}`, {
      method,
      headers: { "content-type": "application/json", authorization: `Bearer ${t.pats.write}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  return { status: res.status, body: (await res.json()) as Body };
}

beforeEach(async () => {
  t = await seedTenant("ms", "MSL");
});

describe("issue <-> milestone link (U16)", () => {
  it("creates and patches an issue with a milestone of its project", async () => {
    const p = await mkProject(t);
    const m = await mkMilestone(t, p.id);
    const c = await call("POST", "/issues", { title: "linked", projectId: p.id, milestoneId: m.id });
    expect(c.status).toBe(201);
    expect(c.body.milestoneId).toBe(m.id);

    const loose = await mkIssue(t, { projectId: p.id });
    const patched = await call("PATCH", `/issues/${loose.key}`, { milestoneId: m.id });
    expect(patched.status).toBe(200);
    expect(patched.body.milestoneId).toBe(m.id);
    const cleared = await call("PATCH", `/issues/${loose.key}`, { milestoneId: null });
    expect(cleared.body.milestoneId).toBeNull();
  });

  it("refuses a milestone from another project, or an issue with no project", async () => {
    const p1 = await mkProject(t);
    const p2 = await mkProject(t);
    const m2 = await mkMilestone(t, p2.id);
    const issue = await mkIssue(t, { projectId: p1.id });
    const wrong = await call("PATCH", `/issues/${issue.key}`, { milestoneId: m2.id });
    expect(wrong.status).toBe(422);
    expect(wrong.body.error.code).toBe("INVALID_MILESTONE");
    const create = await call("POST", "/issues", { title: "x", projectId: p1.id, milestoneId: m2.id });
    expect(create.status).toBe(422);
    const noProject = await mkIssue(t);
    const r = await call("PATCH", `/issues/${noProject.key}`, { milestoneId: m2.id });
    expect(r.status).toBe(422);
    // moving to the milestone's project in the same patch is fine
    const ok = await call("PATCH", `/issues/${noProject.key}`, { projectId: p2.id, milestoneId: m2.id });
    expect(ok.status).toBe(200);
  });

  it("refuses a milestone id from another workspace", async () => {
    const other = await seedTenant("ms2", "MSM");
    const op = await mkProject(other);
    const om = await mkMilestone(other, op.id);
    const p = await mkProject(t);
    const issue = await mkIssue(t, { projectId: p.id });
    const r = await call("PATCH", `/issues/${issue.key}`, { milestoneId: om.id });
    expect(r.status).toBe(422);
  });

  it("moving an issue to another project clears its stale milestone", async () => {
    const p1 = await mkProject(t);
    const p2 = await mkProject(t);
    const m1 = await mkMilestone(t, p1.id);
    const issue = await mkIssue(t, { projectId: p1.id, milestoneId: m1.id });
    const r = await call("PATCH", `/issues/${issue.key}`, { projectId: p2.id });
    expect(r.status).toBe(200);
    expect(r.body.milestoneId).toBeNull();
  });

  it("deleting a milestone clears the link and keeps the issue", async () => {
    const p = await mkProject(t);
    const m = await mkMilestone(t, p.id);
    const issue = await mkIssue(t, { projectId: p.id, milestoneId: m.id });
    const del = await call("DELETE", `/projects/${p.id}/milestones/${m.id}`);
    expect(del.status).toBe(200);
    const [row] = await db.select().from(issues).where(eq(issues.id, issue.id));
    expect(row!.milestoneId).toBeNull();
    expect(row!.projectId).toBe(p.id);
  });

  it("filters the issue list by milestone, exactly", async () => {
    const p = await mkProject(t);
    const m = await mkMilestone(t, p.id);
    const a = await mkIssue(t, { projectId: p.id, milestoneId: m.id });
    const b = await mkIssue(t, { projectId: p.id, milestoneId: m.id });
    await mkIssue(t, { projectId: p.id });
    const r = await call("GET", `/issues?milestone=${m.id}`);
    expect(r.status).toBe(200);
    expect(r.body.issues.map((i) => i.key).sort()).toEqual([a.key, b.key].sort());
  });

  it("milestone progress counts only linked issues", async () => {
    const p = await mkProject(t);
    const m = await mkMilestone(t, p.id);
    await mkIssue(t, { projectId: p.id, milestoneId: m.id, state: "done" });
    await mkIssue(t, { projectId: p.id, milestoneId: m.id, state: "done" });
    await mkIssue(t, { projectId: p.id, milestoneId: m.id, state: "todo" });
    await mkIssue(t, { projectId: p.id, milestoneId: m.id, state: "canceled" });
    await mkIssue(t, { projectId: p.id, state: "done" }); // same project, not linked
    const nested = await call("GET", `/projects/${p.id}/milestones`);
    expect(nested.body.milestones[0]!.progress).toEqual({ total: 3, done: 2 });
    const flat = await call("GET", `/milestones`);
    const row = flat.body.milestones.find((x) => x.id === m.id);
    expect(row!.progress).toEqual({ total: 3, done: 2 });
  });
});

describe("hitl label (U16)", () => {
  it("filters the issue list by the hitl label id", async () => {
    const [hitl] = await db
      .insert(labels)
      .values({ workspaceId: t.ws.id, name: "hitl", color: "#f59e0b" })
      .returning();
    const other = await mkLabel(t);
    const created = await call("POST", "/issues", { title: "needs luke", labelIds: [hitl!.id] });
    await call("POST", "/issues", { title: "other", labelIds: [other.id] });
    const r = await call("GET", `/issues?label=${hitl!.id}`);
    expect(r.body.issues.map((i) => i.key)).toEqual([created.body.key]);
  });
});

describe("migration 0027 label seed", () => {
  it("adds hitl and launch-blocker to a workspace once, however often it runs", async () => {
    const file = new URL("../../drizzle/0027_milestone_issue_link.sql", import.meta.url);
    const stmt = readFileSync(file, "utf8").split("--> statement-breakpoint").pop()!;
    await db.execute(sql.raw(stmt));
    await db.execute(sql.raw(stmt));
    const rows = await db.select().from(labels).where(eq(labels.workspaceId, t.ws.id));
    expect(rows.map((l) => l.name).sort()).toEqual(["hitl", "launch-blocker"]);
  });
});
