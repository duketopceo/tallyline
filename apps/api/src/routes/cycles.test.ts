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
  slackLinks,
  teamMembers,
  teams,
  userIdMap,
  users,
  userTokens,
  views,
  workspaceMembers,
  workspaces,
} from "../db/schema.js";
import { sweepExpiredCycles } from "../services/cycles.js";
import { NOW, useFrozenClock } from "../../test/clock.js";

useFrozenClock();

const SLUG = "cycles-test";

interface TestBody {
  error?: { code: string; message: string };
  cycles?: {
    id: string;
    number: number;
    teamId: string;
    isActive: boolean;
  }[];
  issues?: { key: string; cycleId: string | null; state: string }[];
  cycle?: { id: string; isActive: boolean };
  movedIssues?: number;
  destination?: string;
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

async function createCycle(
  teamKey: string,
  over: Record<string, unknown> = {},
): Promise<TestBody> {
  const res = await req(`/v1/workspaces/${SLUG}/cycles`, {
    method: "POST",
    body: JSON.stringify({
      teamKey,
      startsAt: iso(-day),
      endsAt: iso(day),
      ...over,
    }),
  });
  return res.body;
}

async function createIssue(
  over: Record<string, unknown> = {},
): Promise<TestBody> {
  const res = await req(`/v1/workspaces/${SLUG}/issues`, {
    method: "POST",
    body: JSON.stringify({ teamKey: "ENG", title: "cyc issue", ...over }),
  });
  return res.body;
}

let eng2Id = "";

beforeAll(async () => {
  await runMigrations();
  for (const t of [
    comments,
    events,
    issues,
    slackLinks,
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
      workspaceName: "Cycles Test",
      teamKey: "ENG",
      email: "c@c.co",
      name: "Cyc",
      password: "test-password-123",
    }),
  });
  if (boot.status !== 201) throw new Error("bootstrap failed");

  const eng2 = await req(`/v1/workspaces/${SLUG}/teams`, {
    method: "POST",
    body: JSON.stringify({ key: "OPS", name: "Ops" }),
  });
  eng2Id = eng2.body.id as string;
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
      slackLinks,
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

describe("cycles engine (real postgres)", () => {
  it("enforces one active cycle per team on create and activate", async () => {
    const c1 = await createCycle("ENG", { isActive: true, name: "Sprint 1" });
    expect(c1.isActive).toBe(true);

    // creating a second active cycle demotes the first — no 409, the flag
    // just moves
    const c2 = await createCycle("ENG", {
      isActive: true,
      name: "Sprint 2",
      startsAt: iso(day),
      endsAt: iso(14 * day),
    });
    expect(c2.isActive).toBe(true);
    expect(c2.number).toBe(2);

    const active = await req(
      `/v1/workspaces/${SLUG}/cycles?team=ENG&active=true`,
    );
    expect(active.body.cycles).toHaveLength(1);
    expect(active.body.cycles![0]!.id).toBe(c2.id);

    const first = await req(`/v1/workspaces/${SLUG}/cycles/${c1.id}`);
    expect(first.body.isActive).toBe(false);

    // PATCH-activating the first again demotes the second
    const react = await req(`/v1/workspaces/${SLUG}/cycles/${c1.id}`, {
      method: "PATCH",
      body: JSON.stringify({ isActive: true }),
    });
    expect(react.body.isActive).toBe(true);
    const second = await req(`/v1/workspaces/${SLUG}/cycles/${c2.id}`);
    expect(second.body.isActive).toBe(false);

    // a different team's active flag is independent
    const ops = await createCycle("OPS", { isActive: true });
    expect(ops.isActive).toBe(true);
    const stillActive = await req(`/v1/workspaces/${SLUG}/cycles/${c1.id}`);
    expect(stillActive.body.isActive).toBe(true);

    // deactivating leaves the team with zero active cycles
    const off = await req(`/v1/workspaces/${SLUG}/cycles/${ops.id}`, {
      method: "PATCH",
      body: JSON.stringify({ isActive: false }),
    });
    expect(off.body.isActive).toBe(false);
    const opsActive = await req(
      `/v1/workspaces/${SLUG}/cycles?team=OPS&active=true`,
    );
    expect(opsActive.body.cycles).toHaveLength(0);
  });

  it("validates the cycle window", async () => {
    const bad = await req(`/v1/workspaces/${SLUG}/cycles`, {
      method: "POST",
      body: JSON.stringify({
        teamKey: "ENG",
        startsAt: iso(day),
        endsAt: iso(-day),
      }),
    });
    expect(bad.status).toBe(400);

    const list = await req(`/v1/workspaces/${SLUG}/cycles?team=ENG`);
    const c1 = list.body.cycles!.find((c) => c.number === 1)!;
    const badPatch = await req(`/v1/workspaces/${SLUG}/cycles/${c1.id}`, {
      method: "PATCH",
      body: JSON.stringify({ endsAt: iso(-30 * day) }),
    });
    expect(badPatch.status).toBe(422);
    expect(badPatch.body.error!.code).toBe("INVALID_WINDOW");
  });

  it("assigns issues to cycles on create and patch, rejects foreign cycles", async () => {
    const list = await req(`/v1/workspaces/${SLUG}/cycles?team=ENG`);
    const engCycle = list.body.cycles!.find((c) => c.number === 1)!;
    const opsList = await req(`/v1/workspaces/${SLUG}/cycles?team=OPS`);
    const opsCycle = opsList.body.cycles![0]!;

    // assignment on create
    const created = await createIssue({
      title: "in cycle",
      cycleId: engCycle.id,
    });
    expect(created.cycleId).toBe(engCycle.id);

    // assignment via PATCH
    const created2 = await createIssue({ title: "assign me" });
    expect(created2.cycleId).toBeNull();
    const patched = await req(
      `/v1/workspaces/${SLUG}/issues/${created2.key}`,
      { method: "PATCH", body: JSON.stringify({ cycleId: engCycle.id }) },
    );
    expect(patched.status).toBe(200);
    expect(patched.body.cycleId).toBe(engCycle.id);

    // ?cycle= filter on the issue list
    const filtered = await req(
      `/v1/workspaces/${SLUG}/issues?cycle=${engCycle.id}`,
    );
    const keys = filtered.body.issues!.map((i) => i.key);
    expect(keys).toContain(created.key);
    expect(keys).toContain(created2.key);

    // clearing via null
    const cleared = await req(
      `/v1/workspaces/${SLUG}/issues/${created2.key}`,
      { method: "PATCH", body: JSON.stringify({ cycleId: null }) },
    );
    expect(cleared.body.cycleId).toBeNull();

    // cycle from another team → 422
    const crossTeam = await req(
      `/v1/workspaces/${SLUG}/issues/${created.key}`,
      { method: "PATCH", body: JSON.stringify({ cycleId: opsCycle.id }) },
    );
    expect(crossTeam.status).toBe(422);
    expect(crossTeam.body.error!.code).toBe("INVALID_CYCLE");

    // nonexistent cycle → 422 on create and patch
    const bogus = "00000000-0000-0000-0000-000000000000";
    const badCreate = await createIssue({ cycleId: bogus });
    expect(badCreate.error!.code).toBe("INVALID_CYCLE");
    const badPatch = await req(
      `/v1/workspaces/${SLUG}/issues/${created.key}`,
      { method: "PATCH", body: JSON.stringify({ cycleId: bogus }) },
    );
    expect(badPatch.status).toBe(422);
  });

  it("rolls unfinished issues to the next cycle; terminal issues stay", async () => {
    // ENG has cycles 1 (active) and 2; complete cycle 1 with a mix of states
    const list = await req(`/v1/workspaces/${SLUG}/cycles?team=ENG`);
    const c1 = list.body.cycles!.find((c) => c.number === 1)!;
    const c2 = list.body.cycles!.find((c) => c.number === 2)!;

    const wip = await createIssue({ title: "wip", cycleId: c1.id });
    const done = await createIssue({ title: "shipped", cycleId: c1.id });
    // force terminal state directly — the lifecycle path isn't under test here
    await db
      .update(issues)
      .set({ state: "done" })
      .where(eq(issues.key, done.key as string));

    const res = await req(
      `/v1/workspaces/${SLUG}/cycles/${c1.id}/complete`,
      { method: "POST" },
    );
    expect(res.status).toBe(200);
    expect(res.body.destination).toBe("next_cycle");
    expect(res.body.movedIssues).toBe(2); // wip + the earlier "in cycle" issue
    expect(res.body.cycle!.isActive).toBe(false);

    const moved = await req(`/v1/workspaces/${SLUG}/issues/${wip.key}`);
    expect(moved.body.cycleId).toBe(c2.id);
    const stayed = await req(`/v1/workspaces/${SLUG}/issues/${done.key}`);
    expect(stayed.body.cycleId).toBe(c1.id); // terminal issues keep history
    expect(stayed.body.state).toBe("done");

    // cycle-completion lands on the workspace event feed
    const feed = await req(`/v1/workspaces/${SLUG}/events?limit=50`);
    const actions = (feed.body.events as { action: string }[]).map(
      (e) => e.action,
    );
    expect(actions).toContain("completed");

    // team 1's rollover happens per-team: OPS is untouched
    const opsList = await req(`/v1/workspaces/${SLUG}/cycles?team=OPS`);
    expect(opsList.body.cycles).toHaveLength(1);
  });

  it("completing with no next cycle unschedules unfinished issues", async () => {
    // cycle 2 is now the last ENG cycle — nothing follows it
    const list = await req(`/v1/workspaces/${SLUG}/cycles?team=ENG`);
    const c2 = list.body.cycles!.find((c) => c.number === 2)!;

    const res = await req(
      `/v1/workspaces/${SLUG}/cycles/${c2.id}/complete`,
      { method: "POST" },
    );
    expect(res.body.destination).toBe("unscheduled");
    const leftovers = await req(
      `/v1/workspaces/${SLUG}/issues?cycle=${c2.id}`,
    );
    expect(
      leftovers.body.issues!.filter((i) => i.state !== "done"),
    ).toHaveLength(0);
  });

  it("backlog rollover clears the cycle and returns issues to backlog", async () => {
    // flip ENG's rollover behavior via the team PATCH
    const teamList = await req(`/v1/workspaces/${SLUG}/teams`);
    const engId = (
      teamList.body.teams as { id: string; key: string }[]
    ).find((t) => t.key === "ENG")!.id;
    const patched = await req(
      `/v1/workspaces/${SLUG}/teams/${engId}`,
      {
        method: "PATCH",
        body: JSON.stringify({ rolloverBehavior: "backlog" }),
      },
    );
    expect(patched.status).toBe(200);
    expect(patched.body.rolloverBehavior).toBe("backlog");

    const c3 = await createCycle("ENG", { name: "Sprint 3" });
    const issue = await createIssue({ title: "roll me", cycleId: c3.id });
    await db
      .update(issues)
      .set({ state: "in_progress" })
      .where(eq(issues.key, issue.key as string));

    const res = await req(
      `/v1/workspaces/${SLUG}/cycles/${c3.id}/complete`,
      { method: "POST" },
    );
    expect(res.body.destination).toBe("backlog");
    expect(res.body.movedIssues).toBe(1);

    const after = await req(`/v1/workspaces/${SLUG}/issues/${issue.key}`);
    expect(after.body.cycleId).toBeNull();
    expect(after.body.state).toBe("backlog");
  });

  it("deleting a cycle unassigns its issues", async () => {
    const c4 = await createCycle("ENG");
    const issue = await createIssue({ title: "orphan", cycleId: c4.id });
    const del = await req(`/v1/workspaces/${SLUG}/cycles/${c4.id}`, {
      method: "DELETE",
    });
    expect(del.status).toBe(200);
    const after = await req(`/v1/workspaces/${SLUG}/issues/${issue.key}`);
    expect(after.body.cycleId).toBeNull();
    const gone = await req(`/v1/workspaces/${SLUG}/cycles/${c4.id}`);
    expect(gone.status).toBe(404);
  });

  it("team PATCH validates and 404s unknown teams", async () => {
    const bad = await req(`/v1/workspaces/${SLUG}/teams/${eng2Id}`, {
      method: "PATCH",
      body: JSON.stringify({ rolloverBehavior: "sideways" }),
    });
    expect(bad.status).toBe(400);

    const missing = await req(
      `/v1/workspaces/${SLUG}/teams/00000000-0000-0000-0000-000000000000`,
      { method: "PATCH", body: JSON.stringify({ name: "nope" }) },
    );
    expect(missing.status).toBe(404);
  });

  it("team PATCH stores cycle schedule settings and rejects bad ones", async () => {
    const path = `/v1/workspaces/${SLUG}/teams/${eng2Id}`;
    const ok = await req(path, {
      method: "PATCH",
      body: JSON.stringify({
        cycleAutoEnabled: true,
        cycleLengthDays: 7,
        cycleStartWeekday: 1,
        cycleUpcomingCount: 2,
        timezone: "America/Chicago",
      }),
    });
    expect(ok.status).toBe(200);
    expect(ok.body.cycleAutoEnabled).toBe(true);
    expect(ok.body.timezone).toBe("America/Chicago");
    for (const bad of [
      { timezone: "Mars/Olympus" },
      { cycleLengthDays: 0 },
      { cycleStartWeekday: 7 },
      { cycleUpcomingCount: 99 },
    ]) {
      const res = await req(path, { method: "PATCH", body: JSON.stringify(bad) });
      expect(res.status).toBe(400);
    }
    const cleared = await req(path, {
      method: "PATCH",
      body: JSON.stringify({ timezone: null, cycleAutoEnabled: false }),
    });
    expect(cleared.body.timezone).toBeNull();
  });

  it("boundary sweep completes expired active cycles — audited + idempotent", async () => {
    // an already-expired active cycle with open + done issues
    const expired = await createCycle("ENG", {
      name: "expired",
      isActive: true,
      startsAt: iso(-3 * day),
      endsAt: iso(-day), // window closed yesterday
    });
    const open = await createIssue({
      title: "swept",
      cycleId: expired.id,
    });
    const finished = await createIssue({
      title: "kept",
      cycleId: expired.id,
    });
    await db
      .update(issues)
      .set({ estimate: 3 })
      .where(eq(issues.key, open.key as string));
    await db
      .update(issues)
      .set({ state: "done", estimate: 5 })
      .where(eq(issues.key, finished.key as string));
    // a live active cycle (other team — same-team would demote `expired`)
    // must not be swept
    const live = await createCycle("OPS", {
      name: "live",
      isActive: true,
      endsAt: iso(2 * day),
    });

    const swept = await sweepExpiredCycles(new Date(NOW));
    expect(swept).toBe(1);

    const openAfter = await req(
      `/v1/workspaces/${SLUG}/issues/${open.key}`,
    );
    // ENG rollover is "backlog" now (flipped earlier in this suite)
    expect(openAfter.body.cycleId).toBeNull();
    expect(openAfter.body.state).toBe("backlog");
    const liveAfter = await req(
      `/v1/workspaces/${SLUG}/cycles/${live.id}`,
    );
    expect(liveAfter.body.isActive).toBe(true);

    // per-issue audit event + velocity snapshot + system actor
    const evRows = await db
      .select()
      .from(events)
      .where(eq(events.entityId, openAfter.body.id as string));
    expect(evRows.map((e) => e.action)).toContain("rolled_over");
    const roll = evRows.find((e) => e.action === "rolled_over")!;
    expect(roll.actorType).toBe("system");
    expect((roll.before as { cycleId: string }).cycleId).toBe(expired.id);
    expect((roll.after as { cycleId: null }).cycleId).toBeNull();

    const [vel] = await db
      .select()
      .from(cycleVelocity)
      .where(eq(cycleVelocity.cycleId, expired.id as string));
    expect(vel).toBeDefined();
    expect(vel!.issueCount).toBe(2);
    expect(vel!.doneCount).toBe(1);
    expect(vel!.estimateDone).toBe(5);
    expect(vel!.estimateTotal).toBe(8);

    // re-run is a no-op — no duplicate events, no error
    expect(await sweepExpiredCycles(new Date(NOW))).toBe(0);
    const manualRetry = await req(
      `/v1/workspaces/${SLUG}/cycles/${expired.id}/complete`,
      { method: "POST" },
    );
    expect(manualRetry.status).toBe(409);
  });
});
