import { eq } from "drizzle-orm";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { db, pool } from "../db/client.js";
import {
  events,
  githubRepos,
  glitchtipConnections,
  glitchtipProjectLinks,
  issues,
  projectMilestones,
  projects,
} from "../db/schema.js";
import { app } from "../index.js";
import { MILESTONE_LIMIT, RECENT_LIMIT } from "../services/portfolio.js";
import {
  mkAgent,
  mkIssue,
  mkMilestone,
  mkProject,
  newSession,
  seedTenant,
  type Tenant,
} from "../../test/tenants.js";

// Portfolio overview. Real Postgres; nothing is mocked except a spy that
// counts SQL statements.

interface ProjectView {
  id: string;
  name: string;
  teamKey: string | null;
  counts: Record<string, number>;
  progress: { total: number; done: number; percent: number };
  milestones: {
    total: number;
    completed: number;
    items: { id: string; title: string; progress: { total: number; done: number } }[];
  };
  repos: string[];
  recent: { id: number; action: string; actorName: string | null; actorType: string; issueKey: string }[];
  lastActivityAt: string | null;
  errors: { mapped: boolean; status: string | null; openCount: number; openCapped: boolean; stale: boolean };
}

let A: Tenant;
let B: Tenant;
let member: string;
let bMember: string;

const ws = (t: Tenant) => `/v1/workspaces/${t.ws.slug}`;
const call = async (headers: Record<string, string>, path: string) => {
  const res = await app.fetch(new Request(`http://api.test${path}`, { headers }));
  const text = await res.text();
  let json: { projects?: ProjectView[]; error?: { code: string } } = {};
  try {
    json = JSON.parse(text);
  } catch {
    /* not json */
  }
  return { status: res.status, json, text };
};
const portfolio = (t: Tenant, cookie: string) => call({ cookie }, `${ws(t)}/portfolio`);

async function mkEvent(t: Tenant, issueId: string, action: string, over: Partial<typeof events.$inferInsert> = {}) {
  const [row] = await db
    .insert(events)
    .values({
      workspaceId: t.ws.id,
      entityType: "issue",
      entityId: issueId,
      action,
      actorType: "human",
      actorId: t.people.member.id,
      before: { secret: `before-${t.sentinel}` },
      after: { secret: `after-${t.sentinel}` },
      ...over,
    })
    .returning();
  return row!;
}

beforeAll(async () => {
  A = await seedTenant("pf-a", "PFA");
  B = await seedTenant("pf-b", "PFB");
  member = `tly_session=${await newSession(A, "member")}`;
  bMember = `tly_session=${await newSession(B, "member")}`;
});

afterEach(() => vi.restoreAllMocks());

describe("portfolio", () => {
  it("is empty for a workspace with no projects", async () => {
    const t = await seedTenant("pf-empty", "PFE");
    const r = await portfolio(t, `tly_session=${await newSession(t, "member")}`);
    expect(r.status).toBe(200);
    expect(r.json.projects).toEqual([]);
  });

  it("requires a session and refuses an outsider", async () => {
    expect((await call({}, `${ws(A)}/portfolio`)).status).toBe(401);
    expect((await portfolio(A, bMember)).status).toBe(403);
  });

  it("counts tickets by state and excludes canceled and duplicate from progress", async () => {
    const p = await mkProject(A);
    for (const state of ["triage", "backlog", "todo", "in_progress", "in_review", "done", "done", "canceled", "duplicate"] as const) {
      await mkIssue(A, { projectId: p.id, state });
    }
    const r = await portfolio(A, member);
    const view = r.json.projects!.find((x) => x.id === p.id)!;
    expect(view.counts).toMatchObject({
      triage: 1, backlog: 1, todo: 1, in_progress: 1, in_review: 1, done: 2, canceled: 1, duplicate: 1,
    });
    expect(view.progress).toEqual({ total: 7, done: 2, percent: 29 });
  });

  it("reports zero progress for a project with no issues", async () => {
    const p = await mkProject(A);
    const view = (await portfolio(A, member)).json.projects!.find((x) => x.id === p.id)!;
    expect(view.progress).toEqual({ total: 0, done: 0, percent: 0 });
    expect(view.counts.todo).toBe(0);
    expect(view.recent).toEqual([]);
    expect(view.lastActivityAt).toBeNull();
    expect(view.errors).toMatchObject({ mapped: false, openCount: 0 });
  });

  it("does not count another project's or another tenant's tickets", async () => {
    const p1 = await mkProject(A);
    const p2 = await mkProject(A);
    const pb = await mkProject(B);
    await mkIssue(A, { projectId: p1.id, state: "todo" });
    await mkIssue(A, { projectId: p2.id, state: "done" });
    await mkIssue(B, { projectId: pb.id, state: "todo" });
    await mkIssue(A, { state: "todo" }); // no project
    const views = (await portfolio(A, member)).json.projects!;
    expect(views.find((x) => x.id === p1.id)!.progress.total).toBe(1);
    expect(views.find((x) => x.id === p2.id)!.progress.done).toBe(1);
    expect(views.find((x) => x.id === pb.id)).toBeUndefined();
  });

  it("derives milestone progress from linked issues and caps the list", async () => {
    const p = await mkProject(A);
    const m = await mkMilestone(A, p.id);
    await mkIssue(A, { projectId: p.id, milestoneId: m.id, state: "done" });
    await mkIssue(A, { projectId: p.id, milestoneId: m.id, state: "todo" });
    await mkIssue(A, { projectId: p.id, milestoneId: m.id, state: "canceled" });
    const view = (await portfolio(A, member)).json.projects!.find((x) => x.id === p.id)!;
    expect(view.milestones.total).toBe(1);
    expect(view.milestones.items[0]!.progress).toEqual({ total: 2, done: 1 });

    const many = await mkProject(A);
    await db.insert(projectMilestones).values(
      Array.from({ length: MILESTONE_LIMIT + 3 }, (_, i) => ({
        workspaceId: A.ws.id,
        projectId: many.id,
        title: `Phase ${i}`,
        sortOrder: i,
        done: i === 0,
      })),
    );
    const manyView = (await portfolio(A, member)).json.projects!.find((x) => x.id === many.id)!;
    expect(manyView.milestones).toMatchObject({ total: MILESTONE_LIMIT + 3, completed: 1 });
    expect(manyView.milestones.items).toHaveLength(MILESTONE_LIMIT);
    // Phase 0 is done, so the open ones lead and the next milestone is never cut off
    expect(manyView.milestones.items[0]!.title).toBe("Phase 1");
    expect(manyView.milestones.items.map((m) => m.title)).not.toContain("Phase 0");
  });

  it("lists bound repos for a project", async () => {
    const p = await mkProject(A);
    await db.insert(githubRepos).values({
      workspaceId: A.ws.id,
      fullName: `acme/${A.sentinel}-portfolio`,
      projectId: p.id,
      enabled: true,
    });
    const view = (await portfolio(A, member)).json.projects!.find((x) => x.id === p.id)!;
    expect(view.repos).toEqual([`acme/${A.sentinel}-portfolio`]);
  });

  it("returns the newest events per project, with actor names and no payloads", async () => {
    const p = await mkProject(A);
    const other = await mkProject(A);
    const i1 = await mkIssue(A, { projectId: p.id });
    const iOther = await mkIssue(A, { projectId: other.id });
    const agent = await mkAgent(A);
    for (let n = 0; n < RECENT_LIMIT + 3; n++) await mkEvent(A, i1.id, `action_${n}`);
    await mkEvent(A, i1.id, "by_agent", { actorType: "agent", actorId: agent.id });
    await mkEvent(A, iOther.id, "other_project");
    // outside the window and not an issue entity: both ignored
    await mkEvent(A, i1.id, "ancient", { createdAt: new Date(Date.now() - 90 * 86_400_000) });
    await mkEvent(A, i1.id, "not_issue", { entityType: "project" });

    const r = await portfolio(A, member);
    const view = r.json.projects!.find((x) => x.id === p.id)!;
    expect(view.recent).toHaveLength(RECENT_LIMIT);
    expect(view.recent[0]).toMatchObject({ action: "by_agent", actorType: "agent", actorName: agent.name, issueKey: i1.key });
    const ids = view.recent.map((e) => e.id);
    expect([...ids].sort((a, b) => b - a)).toEqual(ids);
    expect(view.recent.map((e) => e.action)).not.toContain("ancient");
    expect(view.recent.map((e) => e.action)).not.toContain("not_issue");
    expect(view.recent.map((e) => e.action)).not.toContain("other_project");
    expect(r.text).not.toContain(`before-${A.sentinel}`);
    expect(r.text).not.toContain(`after-${A.sentinel}`);
    expect(view.lastActivityAt).not.toBeNull();
  });

  it("merges cached GlitchTip health and stays quiet when disconnected", async () => {
    const t = await seedTenant("pf-gt", "PFG");
    const cookie = `tly_session=${await newSession(t, "member")}`;
    const mapped = await mkProject(t);
    const plain = await mkProject(t);
    await db.insert(glitchtipProjectLinks).values({
      workspaceId: t.ws.id,
      projectId: mapped.id,
      orgSlug: "acme",
      projectSlug: "api",
      lastStatus: "ok",
      lastSyncedAt: new Date(),
      openCount: 7,
    });
    // a cached count is not reported until a connection exists
    let views = (await portfolio(t, cookie)).json.projects!;
    expect(views.find((x) => x.id === mapped.id)!.errors).toMatchObject({ mapped: true, status: null, openCount: 0 });

    await db.insert(glitchtipConnections).values({
      workspaceId: t.ws.id,
      baseUrl: "https://glitchtip.example",
      tokenEnc: "v1:not-a-real-token",
      tokenLast4: "oken",
    });
    const r = await portfolio(t, cookie);
    views = r.json.projects!;
    expect(views.find((x) => x.id === mapped.id)!.errors).toMatchObject({ mapped: true, status: "ok", openCount: 7, stale: false });
    expect(views.find((x) => x.id === plain.id)!.errors.mapped).toBe(false);
    expect(r.text).not.toContain("not-a-real-token");
  });

  it("is isolated between tenants", async () => {
    const pa = await mkProject(A);
    const pb = await mkProject(B);
    const ia = await mkIssue(A, { projectId: pa.id });
    const ib = await mkIssue(B, { projectId: pb.id });
    await mkEvent(A, ia.id, "a_only");
    await mkEvent(B, ib.id, "b_only", { actorId: B.people.member.id });
    const rA = await portfolio(A, member);
    const rB = await portfolio(B, bMember);
    expect(rA.text).not.toContain(B.sentinel);
    expect(rA.text).not.toContain(pb.id);
    expect(rA.text).not.toContain("b_only");
    expect(rB.text).not.toContain(A.sentinel);
    expect(rB.text).not.toContain(pa.id);
    expect(rB.text).not.toContain("a_only");
    // A's slug with B's cookie is refused outright
    expect((await portfolio(A, bMember)).status).toBe(403);
  });

  it("allows a read-scope agent key", async () => {
    const r = await call({ authorization: `Bearer ${A.agentKeys.read}` }, `${ws(A)}/portfolio`);
    expect(r.status).toBe(200);
  });

  it("issues the same number of SQL statements for 1 project and for many", async () => {
    const t = await seedTenant("pf-qc", "PFQ");
    const cookie = `tly_session=${await newSession(t, "member")}`;
    const count = async () => {
      const spy = vi.spyOn(pool, "query");
      const r = await portfolio(t, cookie);
      const n = spy.mock.calls.length;
      spy.mockRestore();
      expect(r.status).toBe(200);
      return n;
    };
    const p1 = await mkProject(t);
    await mkIssue(t, { projectId: p1.id });
    const one = await count();
    for (let i = 0; i < 12; i++) {
      const p = await mkProject(t);
      const iss = await mkIssue(t, { projectId: p.id, state: "done" });
      await mkEvent(t, iss.id, "touched");
      await mkMilestone(t, p.id);
    }
    const many = await count();
    expect(one).toBeGreaterThan(0);
    expect(many).toBe(one);
    expect(many).toBeLessThanOrEqual(12);
    expect(await db.select().from(projects).where(eq(projects.workspaceId, t.ws.id))).toHaveLength(13);
    expect(await db.select().from(issues).where(eq(issues.workspaceId, t.ws.id))).toHaveLength(13);
  });
});
