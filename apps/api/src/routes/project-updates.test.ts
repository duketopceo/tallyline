import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { db } from "../db/client.js";
import { events, issueRelations, projects } from "../db/schema.js";
import { app } from "../index.js";
import { suggestHealth } from "../services/project-update-draft.js";
import { mkIssue, mkProject, newSession, seedTenant, type Tenant } from "../../test/tenants.js";

// U14 (R13): status updates are drafted from the event log (no model call),
// posted by a human or an agent, and scoped to the workspace.

let A: Tenant;
let B: Tenant;
let cookie: string;
let bCookie: string;

beforeAll(async () => {
  A = await seedTenant("pu-a", "PUA");
  B = await seedTenant("pu-b", "PUB");
  cookie = `tly_session=${await newSession(A, "member")}`;
  bCookie = `tly_session=${await newSession(B, "member")}`;
});

interface Body {
  [key: string]: unknown;
  counts: { done: number };
  updates: { body: string }[];
}

async function call(
  path: string,
  init: RequestInit & { cookie?: string; bearer?: string } = {},
) {
  const { cookie: ck, bearer, ...rest } = init;
  const res = await app.fetch(
    new Request(`http://api.test${path}`, {
      ...rest,
      headers: {
        "content-type": "application/json",
        ...(ck ? { cookie: ck } : {}),
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      },
    }),
  );
  return { status: res.status, body: (await res.json()) as Body };
}

const base = (t: Tenant, projectId: string) => `/v1/workspaces/${t.ws.slug}/projects/${projectId}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function closeIssue(t: Tenant, issueId: string) {
  // a done transition as the event log records it
  await db.insert(events).values({
    workspaceId: t.ws.id,
    entityType: "issue",
    entityId: issueId,
    action: "state_changed",
    actorType: "human",
    before: { state: "in_progress" },
    after: { state: "done" },
  });
}

describe("health rule", () => {
  const now = new Date("2026-10-28T00:00:00Z");
  it("is off_track past the target date with open issues", () => {
    expect(suggestHealth({ targetDate: new Date("2026-10-01T00:00:00Z"), now, open: 2, blocked: 0 }).health).toBe("off_track");
  });
  it("is on_track past the target date when nothing is open", () => {
    expect(suggestHealth({ targetDate: new Date("2026-10-01T00:00:00Z"), now, open: 0, blocked: 0 }).health).toBe("on_track");
  });
  it("is at_risk when something open is blocked", () => {
    expect(suggestHealth({ targetDate: null, now, open: 3, blocked: 1 }).health).toBe("at_risk");
  });
});

describe("project status updates (real postgres)", () => {
  it("drafts an empty window honestly and posts nothing by itself", async () => {
    const project = await mkProject(A);
    const draft = await call(`${base(A, project.id)}/update-draft`, { cookie });
    expect(draft.status).toBe(200);
    expect(draft.body.empty).toBe(true);
    expect(draft.body.body).toContain("No tracked activity");
    expect(draft.body.suggestedHealth).toBe("on_track");
    const list = await call(`${base(A, project.id)}/updates`, { cookie });
    expect(list.body.updates).toEqual([]);
  });

  it("counts only events inside the window since the last update", async () => {
    const project = await mkProject(A);
    const before = await mkIssue(A, { projectId: project.id });
    await closeIssue(A, before.id);
    await sleep(25);
    const first = await call(`${base(A, project.id)}/updates`, {
      method: "POST",
      cookie,
      body: JSON.stringify({ health: "on_track", body: "first" }),
    });
    expect(first.status).toBe(201);
    await sleep(25);
    const after = await mkIssue(A, { projectId: project.id });
    await closeIssue(A, after.id);

    const draft = await call(`${base(A, project.id)}/update-draft`, { cookie });
    expect(draft.body.doneKeys).toEqual([after.key]);
    expect(draft.body.doneKeys).not.toContain(before.key);
    expect(draft.body.counts.done).toBe(1);
    expect(draft.body.empty).toBe(false);
  });

  it("flags blocked work and suggests off_track once the target date has passed", async () => {
    const [project] = await db
      .insert(projects)
      .values({ workspaceId: A.ws.id, name: "late", targetDate: new Date(Date.now() - 86_400_000) })
      .returning();
    const blocker = await mkIssue(A, { projectId: project!.id });
    const blocked = await mkIssue(A, { projectId: project!.id });
    await db.insert(issueRelations).values({
      workspaceId: A.ws.id,
      sourceIssueId: blocker.id,
      targetIssueId: blocked.id,
      relationType: "blocks",
    });
    const draft = await call(`${base(A, project!.id)}/update-draft`, { cookie });
    expect(draft.body.blockedKeys).toEqual([blocked.key]);
    expect(draft.body.suggestedHealth).toBe("off_track");
  });

  it("posts as a human, lists newest first, and records an event", async () => {
    const project = await mkProject(A);
    const one = await call(`${base(A, project.id)}/updates`, {
      method: "POST",
      cookie,
      body: JSON.stringify({ health: "at_risk", body: "  slipping  " }),
    });
    expect(one.status).toBe(201);
    expect(one.body.authorType).toBe("human");
    expect(one.body.body).toBe("slipping");
    await sleep(15);
    await call(`${base(A, project.id)}/updates`, {
      method: "POST",
      cookie,
      body: JSON.stringify({ health: "on_track", body: "recovered" }),
    });
    const list = await call(`${base(A, project.id)}/updates`, { cookie });
    expect(list.body.updates.map((u) => u.body)).toEqual(["recovered", "slipping"]);
    const ev = await db.select().from(events).where(eq(events.entityId, project.id));
    expect(ev.filter((e) => e.action === "update_posted")).toHaveLength(2);
  });

  it("marks an agent-posted update as agent-authored", async () => {
    const project = await mkProject(A);
    const res = await call(`${base(A, project.id)}/updates`, {
      method: "POST",
      bearer: A.agentKeys.write,
      body: JSON.stringify({ health: "on_track", body: "from the agent" }),
    });
    expect(res.status).toBe(201);
    expect(res.body.authorType).toBe("agent");
    expect(res.body.authorId).toBe(A.agent.id);
  });

  it("rejects bad input, read-only agents, and other workspaces", async () => {
    const project = await mkProject(A);
    const post = (c: Record<string, string>, payload: unknown) =>
      call(`${base(A, project.id)}/updates`, { method: "POST", body: JSON.stringify(payload), ...c });
    expect((await post({ cookie }, { health: "great", body: "x" })).status).toBe(400);
    expect((await post({ cookie }, { health: "on_track", body: "   " })).status).toBe(400);
    expect((await post({ bearer: A.agentKeys.read }, { health: "on_track", body: "x" })).status).toBe(403);
    // B's member cannot touch A's project through B's or A's workspace path
    expect((await post({ cookie: bCookie }, { health: "on_track", body: "x" })).status).toBe(403);
    const bPath = await call(`${base(B, project.id)}/update-draft`, { cookie: bCookie });
    expect(bPath.status).toBe(404);
  });
});
