import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { app } from "../index.js";
import { closeDb, db } from "../db/client.js";
import { runMigrations } from "../db/migrate.js";
import {
  agentKeys,
  agents,
  authIdentities,
  authProviders,
  comments,
  cycles,
  cycleVelocity,
  events,
  invites,
  issues,
  labels,
  oauthCodes,
  projectMilestones,
  projects,
  sessions,
  teamMembers,
  teams,
  userIdMap,
  users,
  userTokens,
  views,
  workspaceMembers,
  workspaces,
} from "../db/schema.js";
import { NOW, useFrozenClock } from "../../test/clock.js";

useFrozenClock();

const SLUG = "projects-test";

interface TestBody {
  error?: { code: string; message: string };
  projects?: {
    id: string;
    name: string;
    status: string;
    teamId: string | null;
    startDate: string | null;
    targetDate: string | null;
  }[];
  milestones?: {
    id: string;
    projectId: string;
    title: string;
    targetDate: string | null;
    sortOrder: number;
    done: boolean;
  }[];
  issues?: { key: string; projectId: string | null; state: string }[];
  [key: string]: unknown;
}

let sessionCookie = "";

async function req(
  path: string,
  init?: RequestInit,
): Promise<{ status: number; body: TestBody }> {
  const extraHeaders = (init?.headers as Record<string, string>) ?? {};
  const res = await app.fetch(
    new Request(`http://api.test${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        ...(sessionCookie && !extraHeaders.authorization
          ? { cookie: sessionCookie }
          : {}),
        ...extraHeaders,
      },
    }),
  );
  const setCookie = res.headers.get("set-cookie");
  if (setCookie?.startsWith("tly_session=")) {
    sessionCookie = setCookie.split(";")[0]!;
  }
  return { status: res.status, body: (await res.json()) as TestBody };
}

const day = 86_400_000;
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

async function createProject(
  over: Record<string, unknown> = {},
): Promise<TestBody> {
  const res = await req(`/v1/workspaces/${SLUG}/projects`, {
    method: "POST",
    body: JSON.stringify({ name: "proj", ...over }),
  });
  return res.body;
}

async function createIssue(
  over: Record<string, unknown> = {},
): Promise<TestBody> {
  const res = await req(`/v1/workspaces/${SLUG}/issues`, {
    method: "POST",
    body: JSON.stringify({ teamKey: "ENG", title: "proj issue", ...over }),
  });
  return res.body;
}

beforeAll(async () => {
  await runMigrations();
  for (const t of [
    comments,
    events,
    issues,
    labels,
    agentKeys,
    agents,
    userTokens,
    views,
    cycleVelocity,
    cycles,
    projectMilestones,
    projects,
    authIdentities,
    authProviders,
    invites,
    oauthCodes,
    teamMembers,
    userIdMap,
    workspaceMembers,
    sessions,
    users,
    teams,
  ] as const) {
    await db.delete(t);
  }
  await db.delete(workspaces);

  const boot = await req("/v1/auth/bootstrap", {
    method: "POST",
    body: JSON.stringify({
      workspaceSlug: SLUG,
      workspaceName: "Projects Test",
      teamKey: "ENG",
      email: "p@p.co",
      name: "Proj",
      password: "test-password-123",
    }),
  });
  if (boot.status !== 201) throw new Error("bootstrap failed");

  await req(`/v1/workspaces/${SLUG}/teams`, {
    method: "POST",
    body: JSON.stringify({ key: "OPS", name: "Ops" }),
  });
});

afterAll(async () => {
  const [ws] = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.slug, SLUG));
  if (ws) {
    await db.delete(invites).where(eq(invites.workspaceId, ws.id));
    await db
      .delete(users)
      .where(
        sql`${users.id} in (select ${workspaceMembers.userId} from ${workspaceMembers} where ${workspaceMembers.workspaceId} = ${ws.id})`,
      );
    for (const t of [
      comments,
      events,
      issues,
      labels,
      agentKeys,
      agents,
      userTokens,
      views,
      cycleVelocity,
      cycles,
      projectMilestones,
      projects,
      invites,
      oauthCodes,
      workspaceMembers,
      sessions,
      teams,
    ] as const) {
      await db.delete(t).where(eq(t.workspaceId, ws.id));
    }
    await db.delete(workspaces).where(eq(workspaces.id, ws.id));
  }
  await closeDb();
});

describe("projects + milestones (real postgres)", () => {
  it("project CRUD carries the roadmap window and validates it", async () => {
    const p = await createProject({
      name: "roadmap proj",
      status: "started",
      teamKey: "ENG",
      startDate: iso(-7 * day),
      targetDate: iso(30 * day),
    });
    expect(p.id).toBeDefined();
    expect(p.teamId).not.toBeNull();
    expect(p.startDate).toBeDefined();
    expect(p.targetDate).toBeDefined();

    // inverted window on create → zod refine rejects
    const bad = await req(`/v1/workspaces/${SLUG}/projects`, {
      method: "POST",
      body: JSON.stringify({
        name: "backwards",
        startDate: iso(day),
        targetDate: iso(-day),
      }),
    });
    expect(bad.status).toBe(400);

    // PATCH merges with the stored window — can't push start past target
    const badPatch = await req(`/v1/workspaces/${SLUG}/projects/${p.id}`, {
      method: "PATCH",
      body: JSON.stringify({ startDate: iso(60 * day) }),
    });
    expect(badPatch.status).toBe(422);
    expect(badPatch.body.error!.code).toBe("INVALID_WINDOW");

    // legal PATCH: move the target out, then clear it with null
    const moved = await req(`/v1/workspaces/${SLUG}/projects/${p.id}`, {
      method: "PATCH",
      body: JSON.stringify({ targetDate: iso(90 * day) }),
    });
    expect(moved.status).toBe(200);
    const cleared = await req(`/v1/workspaces/${SLUG}/projects/${p.id}`, {
      method: "PATCH",
      body: JSON.stringify({ targetDate: null, status: "paused" }),
    });
    expect(cleared.body.targetDate).toBeNull();
    expect(cleared.body.status).toBe("paused");
  });

  it("project iconUrl is explicit, https-only and clearable", async () => {
    const p = await createProject({ name: "iconed", iconUrl: "https://example.com/logo.png" });
    expect(p.iconUrl).toBe("https://example.com/logo.png");
    const plain = await createProject({ name: "plain" });
    expect(plain.iconUrl).toBeNull();

    for (const bad of ["http://example.com/a.png", "https://127.0.0.1/a.png", "javascript:alert(1)"]) {
      const r = await req(`/v1/workspaces/${SLUG}/projects`, {
        method: "POST",
        body: JSON.stringify({ name: "bad icon", iconUrl: bad }),
      });
      expect(r.status).toBe(400);
    }

    const set = await req(`/v1/workspaces/${SLUG}/projects/${plain.id as string}`, {
      method: "PATCH",
      body: JSON.stringify({ iconUrl: "https://example.org/favicon.ico" }),
    });
    expect(set.body.iconUrl).toBe("https://example.org/favicon.ico");
    const cleared = await req(`/v1/workspaces/${SLUG}/projects/${plain.id as string}`, {
      method: "PATCH",
      body: JSON.stringify({ iconUrl: null }),
    });
    expect(cleared.body.iconUrl).toBeNull();
  });

  it("milestone CRUD is nested under the project and ordered", async () => {
    const p = await createProject({ name: "with milestones" });

    const m2 = await req(`/v1/workspaces/${SLUG}/projects/${p.id}/milestones`, {
      method: "POST",
      body: JSON.stringify({ title: "beta", sortOrder: 2 }),
    });
    expect(m2.status).toBe(201);
    const m1 = await req(`/v1/workspaces/${SLUG}/projects/${p.id}/milestones`, {
      method: "POST",
      body: JSON.stringify({
        title: "alpha",
        sortOrder: 1,
        targetDate: iso(14 * day),
      }),
    });
    expect(m1.status).toBe(201);
    expect(m1.body.targetDate).toBeDefined();
    expect(m1.body.done).toBe(false);

    const list = await req(
      `/v1/workspaces/${SLUG}/projects/${p.id}/milestones`,
    );
    expect(list.body.milestones!.map((m) => m.title)).toEqual([
      "alpha",
      "beta",
    ]);

    // the flat workspace list powers the roadmap in one request
    const flat = await req(`/v1/workspaces/${SLUG}/milestones`);
    expect(
      flat.body.milestones!.filter((m) => m.projectId === p.id),
    ).toHaveLength(2);

    const patched = await req(
      `/v1/workspaces/${SLUG}/projects/${p.id}/milestones/${m1.body.id}`,
      { method: "PATCH", body: JSON.stringify({ done: true, title: "α" }) },
    );
    expect(patched.body.done).toBe(true);
    expect(patched.body.title).toBe("α");

    // milestones are scoped to their project — wrong parent → 404
    const other = await createProject({ name: "other proj" });
    const wrongParent = await req(
      `/v1/workspaces/${SLUG}/projects/${other.id}/milestones/${m1.body.id}`,
      { method: "PATCH", body: JSON.stringify({ done: false }) },
    );
    expect(wrongParent.status).toBe(404);
    const missingProject = await req(
      `/v1/workspaces/${SLUG}/projects/00000000-0000-0000-0000-000000000000/milestones`,
      { method: "POST", body: JSON.stringify({ title: "x" }) },
    );
    expect(missingProject.status).toBe(404);

    const del = await req(
      `/v1/workspaces/${SLUG}/projects/${p.id}/milestones/${m2.body.id}`,
      { method: "DELETE" },
    );
    expect(del.status).toBe(200);
    const after = await req(
      `/v1/workspaces/${SLUG}/projects/${p.id}/milestones`,
    );
    expect(after.body.milestones).toHaveLength(1);
  });

  it("issue↔project assignment validates workspace + team scope", async () => {
    const wsProject = await createProject({ name: "ws level" });
    const engProject = await createProject({
      name: "eng only",
      teamKey: "ENG",
    });
    const opsProject = await createProject({
      name: "ops only",
      teamKey: "OPS",
    });

    // workspace-level project accepts any team's issues
    const i1 = await createIssue({
      title: "in ws project",
      projectId: wsProject.id,
    });
    expect(i1.projectId).toBe(wsProject.id);

    // team-matched project ok via PATCH; ops-scoped project rejected for ENG
    const i2 = await createIssue({ title: "assign me" });
    const ok = await req(`/v1/workspaces/${SLUG}/issues/${i2.key}`, {
      method: "PATCH",
      body: JSON.stringify({ projectId: engProject.id }),
    });
    expect(ok.status).toBe(200);
    expect(ok.body.projectId).toBe(engProject.id);

    const crossTeam = await req(`/v1/workspaces/${SLUG}/issues/${i2.key}`, {
      method: "PATCH",
      body: JSON.stringify({ projectId: opsProject.id }),
    });
    expect(crossTeam.status).toBe(422);
    expect(crossTeam.body.error!.code).toBe("INVALID_PROJECT");
    // rejected patch didn't move the assignment
    const still = await req(`/v1/workspaces/${SLUG}/issues/${i2.key}`);
    expect(still.body.projectId).toBe(engProject.id);

    // a foreign-workspace project id is invisible → 422, not an FK error
    const [otherWs] = await db
      .insert(workspaces)
      .values({ slug: `${SLUG}-other`, name: "Other" })
      .returning();
    const [foreign] = await db
      .insert(projects)
      .values({ workspaceId: otherWs!.id, name: "foreign" })
      .returning();
    const crossWs = await req(`/v1/workspaces/${SLUG}/issues/${i2.key}`, {
      method: "PATCH",
      body: JSON.stringify({ projectId: foreign!.id }),
    });
    expect(crossWs.status).toBe(422);
    expect(crossWs.body.error!.code).toBe("INVALID_PROJECT");
    await db.delete(projects).where(eq(projects.id, foreign!.id));
    await db.delete(workspaces).where(eq(workspaces.id, otherWs!.id));

    // nonexistent id — same rejection on create and patch
    const bogus = "00000000-0000-0000-0000-000000000000";
    const badCreate = await createIssue({ projectId: bogus });
    expect(badCreate.error!.code).toBe("INVALID_PROJECT");
    const badPatch = await req(`/v1/workspaces/${SLUG}/issues/${i2.key}`, {
      method: "PATCH",
      body: JSON.stringify({ projectId: bogus }),
    });
    expect(badPatch.status).toBe(422);

    // ?project= filter on the issue list + clearing via null
    const filtered = await req(
      `/v1/workspaces/${SLUG}/issues?project=${wsProject.id}`,
    );
    expect(filtered.body.issues!.map((i) => i.key)).toContain(i1.key);
    expect(filtered.body.issues!.map((i) => i.key)).not.toContain(i2.key);
    const cleared = await req(`/v1/workspaces/${SLUG}/issues/${i2.key}`, {
      method: "PATCH",
      body: JSON.stringify({ projectId: null }),
    });
    expect(cleared.body.projectId).toBeNull();
  });

  it("project validation runs before the state transition commits", async () => {
    const issue = await createIssue({ title: "ordering probe" });
    expect(issue.state).toBe("backlog");

    // bogus project + a legal transition in one PATCH — validation must
    // reject the whole request; the state must not move
    const res = await req(`/v1/workspaces/${SLUG}/issues/${issue.key}`, {
      method: "PATCH",
      body: JSON.stringify({
        state: "todo",
        projectId: "00000000-0000-0000-0000-000000000000",
      }),
    });
    expect(res.status).toBe(422);
    expect(res.body.error!.code).toBe("INVALID_PROJECT");

    const after = await req(`/v1/workspaces/${SLUG}/issues/${issue.key}`);
    expect(after.body.state).toBe("backlog");
    expect(after.body.projectId).toBeNull();
  });

  it("deleting a project unassigns its issues and cascades milestones", async () => {
    const p = await createProject({ name: "doomed" });
    await req(`/v1/workspaces/${SLUG}/projects/${p.id}/milestones`, {
      method: "POST",
      body: JSON.stringify({ title: "m" }),
    });
    const issue = await createIssue({
      title: "orphan",
      projectId: p.id,
    });

    const del = await req(`/v1/workspaces/${SLUG}/projects/${p.id}`, {
      method: "DELETE",
    });
    expect(del.status).toBe(200);

    const after = await req(`/v1/workspaces/${SLUG}/issues/${issue.key}`);
    expect(after.body.projectId).toBeNull();
    const ms = await db
      .select()
      .from(projectMilestones)
      .where(eq(projectMilestones.projectId, p.id as string));
    expect(ms).toHaveLength(0);
  });
});
