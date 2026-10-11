import { randomBytes, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { NOW, useFrozenClock } from "../../test/clock.js";
import { mkAgent, mkComment, mkIssue, newSession, seedTenant, type Tenant } from "../../test/tenants.js";
import { db, pool } from "../db/client.js";
import { usageDaily } from "../db/schema.js";
import { app } from "../index.js";
import {
  countApiCall,
  dayKey,
  flushApiCalls,
  pendingApiCalls,
  rollupTick,
  rollupUsage,
  storageBytes,
  type UsageReport,
} from "../services/usage.js";

// PLAN-059: usage metering. Deterministic: the clock is frozen at
// 2026-10-11T12:00Z (test/clock.ts) and every timestamp is relative to it.

useFrozenClock();

const TODAY = "2026-10-11";
let seq = 0;
const nextKey = () => `U${String.fromCharCode(65 + (seq % 26))}${String.fromCharCode(65 + (Math.floor(seq++ / 26) % 26))}`;

async function get(path: string, cookie: string) {
  const res = await app.fetch(new Request(`http://usage.test${path}`, { headers: { cookie: `dok_session=${cookie}` } }));
  return { status: res.status, json: (await res.json().catch(() => null)) as never };
}

async function dispatchAt(t: Tenant, at: Date) {
  const issue = await mkIssue(t);
  await pool.query(
    `insert into dispatches (workspace_id, issue_id, agent_id, trigger, status, created_at)
     values ($1, $2, $3, 'assign', 'completed', $4)`,
    [t.ws.id, issue.id, t.agent.id, at],
  );
}

async function row(t: Tenant, day: string) {
  const [r] = await db
    .select()
    .from(usageDaily)
    .where(and(eq(usageDaily.workspaceId, t.ws.id), eq(usageDaily.day, day)));
  return r;
}

let A: Tenant;
let B: Tenant;

beforeAll(async () => {
  vi.stubGlobal("fetch", async () => {
    throw new Error("network disabled in usage test");
  });
  A = await seedTenant("ua", nextKey());
  B = await seedTenant("ub", nextKey());
});

describe("dayKey", () => {
  it("is the UTC calendar day", () => {
    expect(dayKey(NOW)).toBe(TODAY);
    expect(dayKey(Date.parse("2026-10-11T23:59:59.999Z"))).toBe("2026-10-11");
    expect(dayKey(Date.parse("2026-10-12T00:00:00.000Z"))).toBe("2026-10-12");
  });
});

describe("API-call counter", () => {
  it("counts only requests that passed the workspace gate, then flushes into usage_daily", async () => {
    const t = await seedTenant(`api${seq}`, nextKey());
    await flushApiCalls(); // drain anything earlier tests counted
    const owner = await newSession(t, "owner");
    const outsider = await newSession(B, "owner");
    for (let i = 0; i < 3; i++) {
      expect((await get(`/v1/workspaces/${t.ws.slug}/issues`, owner)).status).toBe(200);
    }
    // refused requests never count against the workspace they targeted
    expect((await get(`/v1/workspaces/${t.ws.slug}/issues`, outsider)).status).toBe(403);
    expect(pendingApiCalls(t.ws.id, TODAY)).toBe(3);
    expect(await flushApiCalls()).toBeGreaterThanOrEqual(3);
    expect(pendingApiCalls(t.ws.id, TODAY)).toBe(0);
    expect((await row(t, TODAY))!.apiCalls).toBe(3);
    // a second flush adds, never overwrites
    countApiCall(t.ws.id);
    countApiCall(t.ws.id);
    await flushApiCalls();
    expect((await row(t, TODAY))!.apiCalls).toBe(5);
  });

  it("counts agent-key traffic against the agent's workspace", async () => {
    const t = await seedTenant(`agt${seq}`, nextKey());
    await flushApiCalls();
    const res = await app.fetch(
      new Request(`http://usage.test/v1/workspaces/${t.ws.slug}/issues`, {
        headers: { authorization: `Bearer ${t.agentKeys.read}` },
      }),
    );
    expect(res.status).toBe(200);
    expect(pendingApiCalls(t.ws.id, TODAY)).toBe(1);
  });

  it("a flush for a deleted workspace drops its counts instead of failing", async () => {
    await flushApiCalls();
    countApiCall(randomUUID()); // no such workspace (FK violation on insert)
    await expect(flushApiCalls()).resolves.toBe(0);
  });
});

describe("daily rollup", () => {
  it("writes seats, agents, exact agent runs and storage for the day; idempotent", async () => {
    const t = await seedTenant(`roll${seq}`, nextKey());
    await mkAgent(t); // 2 agents
    // day boundaries: 2 runs today, 1 yesterday 23:59:59.999, 1 tomorrow 00:00
    await dispatchAt(t, new Date("2026-10-11T00:00:00.000Z"));
    await dispatchAt(t, new Date(NOW));
    await dispatchAt(t, new Date("2026-10-10T23:59:59.999Z"));
    await dispatchAt(t, new Date("2026-10-12T00:00:00.000Z"));
    const issue = await mkIssue(t);
    await mkComment(t, issue.id);

    await rollupUsage({ workspaceId: t.ws.id });
    const r1 = await row(t, TODAY);
    expect(r1).toMatchObject({ seats: 3, agents: 2, agentRuns: 2 });
    expect(r1!.storageBytes).toBeGreaterThan(0);
    expect(r1!.storageBytes).toBe(await storageBytes(t.ws.id));

    await rollupUsage({ workspaceId: t.ws.id, day: "2026-10-10" });
    expect((await row(t, "2026-10-10"))!.agentRuns).toBe(1);

    // api calls survive a re-rollup of the same day
    countApiCall(t.ws.id);
    await rollupUsage({ workspaceId: t.ws.id });
    await rollupUsage({ workspaceId: t.ws.id });
    const r2 = await row(t, TODAY);
    expect(r2).toMatchObject({ seats: 3, agents: 2, agentRuns: 2, apiCalls: 1 });
    const [{ n }] = (
      await pool.query(`select count(*)::int n from usage_daily where workspace_id = $1 and day = $2`, [t.ws.id, TODAY])
    ).rows;
    expect(n).toBe(1);
  });

  it("the scheduler tick rolls up today and settles yesterday's run count", async () => {
    const t = await seedTenant(`tick${seq}`, nextKey());
    await db.insert(usageDaily).values({ workspaceId: t.ws.id, day: "2026-10-10", seats: 3, agentRuns: 0, storageBytes: 77 });
    // a run that became visible after yesterday's last rollup
    await dispatchAt(t, new Date("2026-10-10T22:00:00.000Z"));
    expect(await rollupTick()).toBe(true);
    expect(await row(t, TODAY)).toMatchObject({ seats: 3, agents: 1 });
    // yesterday: run count settled, snapshots untouched (no storage rescan)
    expect(await row(t, "2026-10-10")).toMatchObject({ agentRuns: 1, seats: 3, storageBytes: 77 });
  });

  it("only one replica runs the tick at a time", async () => {
    const holder = await pool.connect();
    try {
      await holder.query("select pg_advisory_lock(hashtext('tallyline-usage-rollup')::bigint)");
      expect(await rollupTick()).toBe(false);
    } finally {
      await holder.query("select pg_advisory_unlock(hashtext('tallyline-usage-rollup')::bigint)");
      holder.release();
    }
    expect(await rollupTick()).toBe(true);
  });

  it("storage only counts the workspace's own rows", async () => {
    const t = await seedTenant(`sto${seq}`, nextKey());
    const before = await storageBytes(t.ws.id);
    const bBefore = await storageBytes(B.ws.id);
    // random (incompressible) text, so TOAST compression can't hide it
    await mkIssue(t, { description: randomBytes(1500).toString("hex") });
    expect(await storageBytes(t.ws.id)).toBeGreaterThan(before + 1000);
    expect(await storageBytes(B.ws.id)).toBe(bBefore);
  });
});

describe("GET /v1/workspaces/{ws}/usage", () => {
  it("returns plan, live counters and a gap-filled daily series, oldest first", async () => {
    const t = await seedTenant(`rep${seq}`, nextKey());
    await db.insert(usageDaily).values([
      { workspaceId: t.ws.id, day: "2026-10-05", seats: 2, agents: 1, agentRuns: 7, apiCalls: 120, storageBytes: 1000 },
      { workspaceId: t.ws.id, day: "2026-09-01", seats: 9, agents: 9, agentRuns: 99, apiCalls: 999, storageBytes: 9 },
    ]);
    await dispatchAt(t, new Date(NOW - 60_000));
    await dispatchAt(t, new Date("2026-10-02T08:00:00.000Z"));
    await dispatchAt(t, new Date("2026-09-30T08:00:00.000Z")); // last month
    const owner = await newSession(t, "owner");
    const r = await get(`/v1/workspaces/${t.ws.slug}/usage?days=14`, owner);
    expect(r.status).toBe(200);
    const rep = r.json as UsageReport;
    expect(rep.plan).toMatchObject({ plan: "self_host_unlimited", enforced: false });
    expect(rep.from).toBe("2026-09-28");
    expect(rep.to).toBe(TODAY);
    expect(rep.daily).toHaveLength(14);
    expect(rep.daily[0]!.day).toBe("2026-09-28");
    expect(rep.daily.at(-1)!.day).toBe(TODAY);
    expect(rep.daily.find((d) => d.day === "2026-10-05")).toEqual({
      day: "2026-10-05",
      seats: 2,
      agents: 1,
      agentRuns: 7,
      apiCalls: 120,
      storageBytes: 1000,
    });
    expect(rep.daily.find((d) => d.day === "2026-10-06")).toMatchObject({ agentRuns: 0, apiCalls: 0 });
    // today is live, not waiting for the rollup
    expect(rep.daily.at(-1)).toMatchObject({ seats: 3, agents: 1, agentRuns: 1 });
    expect(rep.current).toMatchObject({ seats: 3, pendingInvites: 0, agents: 1, agentRunsThisMonth: 2 });
    expect(rep.current.apiCallsToday).toBeGreaterThanOrEqual(1);
    expect(rep.current.storageBytes).toBeGreaterThan(0);
  });

  it("defaults to 30 days and validates the range", async () => {
    const owner = await newSession(A, "owner");
    const r = await get(`/v1/workspaces/${A.ws.slug}/usage`, owner);
    expect((r.json as UsageReport).daily).toHaveLength(30);
    expect((await get(`/v1/workspaces/${A.ws.slug}/usage?days=0`, owner)).status).toBe(400);
    expect((await get(`/v1/workspaces/${A.ws.slug}/usage?days=91`, owner)).status).toBe(400);
  });

  it("is owner/admin only", async () => {
    expect((await get(`/v1/workspaces/${A.ws.slug}/usage`, await newSession(A, "admin"))).status).toBe(200);
    const m = await get(`/v1/workspaces/${A.ws.slug}/usage`, await newSession(A, "member"));
    expect(m.status).toBe(403);
    expect((m.json as { error: { code: string } }).error.code).toBe("FORBIDDEN_ROLE");
    const x = await get(`/v1/workspaces/${A.ws.slug}/usage`, await newSession(B, "owner"));
    expect(x.status).toBe(403);
  });

  it("never mixes in another workspace's usage", async () => {
    await db.insert(usageDaily).values({ workspaceId: B.ws.id, day: "2026-10-09", agentRuns: 4242, apiCalls: 4242 });
    const r = await get(`/v1/workspaces/${A.ws.slug}/usage`, await newSession(A, "owner"));
    expect(JSON.stringify(r.json)).not.toContain("4242");
  });

  it("holds no ids, names or content: aggregates only", async () => {
    const r = await get(`/v1/workspaces/${A.ws.slug}/usage`, await newSession(A, "owner"));
    const text = JSON.stringify(r.json);
    expect(text).not.toContain(A.sentinel);
    expect(text).not.toContain(A.ws.id);
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
  });
});

