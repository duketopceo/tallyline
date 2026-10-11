import { and, asc, eq, gte, lt, sql } from "drizzle-orm";
import { db, pool } from "../db/client.js";
import { dispatches, usageDaily, workspaces } from "../db/schema.js";
import { clock } from "./clock.js";
import {
  agentCount,
  agentRunsThisMonth,
  entitlements,
  pendingInviteCount,
  seatCount,
  type Entitlements,
} from "./entitlements.js";

// Usage metering (PLAN-059, go-live PLAN.md section 5). First-party
// aggregates from our own tables, one row per workspace per UTC day in
// usage_daily. Nothing here reads issue or comment content, and nothing is
// recorded per person.

const DAY_MS = 86_400_000;

/** YYYY-MM-DD for the UTC day containing `at` */
export function dayKey(at: Date | number): string {
  return new Date(at).toISOString().slice(0, 10);
}

function dayBounds(day: string): { start: Date; end: Date } {
  const start = new Date(`${day}T00:00:00.000Z`);
  return { start, end: new Date(start.getTime() + DAY_MS) };
}

// ── API calls: counted in process, flushed in batches ────────────────────
// requireWorkspace() calls countApiCall() once an authenticated caller has
// passed the workspace gate, so refused requests never count against the
// workspace they targeted. A Map increment per request; one upsert per
// workspace-day per flush.

const apiCalls = new Map<string, number>(); // `${workspaceId}|${day}` -> n

export function countApiCall(workspaceId: string): void {
  const k = `${workspaceId}|${dayKey(clock.ms())}`;
  apiCalls.set(k, (apiCalls.get(k) ?? 0) + 1);
}

/** pending (unflushed) API calls, for tests and the live usage view */
export function pendingApiCalls(workspaceId: string, day: string): number {
  return apiCalls.get(`${workspaceId}|${day}`) ?? 0;
}

function pgCode(err: unknown): string | undefined {
  const e = err as { code?: string; cause?: { code?: string } };
  return e.code ?? e.cause?.code;
}

export async function flushApiCalls(): Promise<number> {
  if (apiCalls.size === 0) return 0;
  const batch = [...apiCalls.entries()];
  apiCalls.clear();
  let flushed = 0;
  let failure: unknown;
  for (const [k, n] of batch) {
    const [workspaceId, day] = k.split("|") as [string, string];
    try {
      await db
        .insert(usageDaily)
        .values({ workspaceId, day, apiCalls: n, updatedAt: clock.now() })
        .onConflictDoUpdate({
          target: [usageDaily.workspaceId, usageDaily.day],
          set: {
            apiCalls: sql`${usageDaily.apiCalls} + ${n}`,
            updatedAt: clock.now(),
          },
        });
      flushed += n;
    } catch (err) {
      // workspace deleted meanwhile (FK violation): drop its counts. Anything
      // else goes back into the map for the next flush.
      if (pgCode(err) !== "23503") {
        apiCalls.set(k, (apiCalls.get(k) ?? 0) + n);
        failure ??= err;
      }
    }
  }
  if (failure) throw failure;
  return flushed;
}

// ── storage: approximate bytes of a workspace's rows ─────────────────────
// pg_column_size over the content-bearing tables. There are no attachments
// yet, so this is the whole footprint to within indexes and TOAST overhead.
const STORAGE_TABLES = ["issues", "comments", "events", "dispatch_events", "webhook_deliveries"] as const;

export async function storageBytes(workspaceId: string): Promise<number> {
  const parts = STORAGE_TABLES.map(
    (t) => `(select coalesce(sum(pg_column_size(x)), 0) from "${t}" x where x.workspace_id = $1)`,
  ).join(" + ");
  const { rows } = await pool.query<{ b: string }>(`select (${parts})::bigint as b`, [workspaceId]);
  return Number(rows[0]?.b ?? 0);
}

async function agentRunsOn(workspaceId: string, day: string): Promise<number> {
  const { start, end } = dayBounds(day);
  const [r] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(dispatches)
    .where(
      and(
        eq(dispatches.workspaceId, workspaceId),
        gte(dispatches.createdAt, start),
        lt(dispatches.createdAt, end),
      ),
    );
  return r?.n ?? 0;
}

/**
 * Daily rollup: writes seats/agents/storage snapshots and the exact agent-run
 * count for `day` (default: today, UTC) for every workspace (or one).
 * Idempotent; api_calls is left to flushApiCalls().
 */
export async function rollupUsage(opts: { day?: string; workspaceId?: string } = {}): Promise<number> {
  await flushApiCalls();
  const day = opts.day ?? dayKey(clock.ms());
  const targets = opts.workspaceId
    ? [{ id: opts.workspaceId }]
    : await db.select({ id: workspaces.id }).from(workspaces);
  for (const { id } of targets) {
    const row = {
      seats: await seatCount(id),
      agents: await agentCount(id),
      agentRuns: await agentRunsOn(id, day),
      storageBytes: await storageBytes(id),
      updatedAt: clock.now(),
    };
    await db
      .insert(usageDaily)
      .values({ workspaceId: id, day, ...row })
      .onConflictDoUpdate({ target: [usageDaily.workspaceId, usageDaily.day], set: row });
  }
  return targets.length;
}

/**
 * Close out a past day: only agent_runs can still change (late-visible
 * dispatch rows); the snapshots stay as last written. Cheap: no storage scan.
 */
export async function settleDayRuns(day: string): Promise<void> {
  const rows = await db
    .select({ workspaceId: usageDaily.workspaceId })
    .from(usageDaily)
    .where(eq(usageDaily.day, day));
  for (const { workspaceId } of rows) {
    await db
      .update(usageDaily)
      .set({ agentRuns: await agentRunsOn(workspaceId, day), updatedAt: clock.now() })
      .where(and(eq(usageDaily.workspaceId, workspaceId), eq(usageDaily.day, day)));
  }
}

/**
 * Scheduler tick (boot + hourly): settle yesterday's run counts, then roll up
 * today. With several API replicas only one runs it (session advisory lock).
 * Returns false when another replica holds the lock.
 */
export async function rollupTick(): Promise<boolean> {
  const client = await pool.connect();
  try {
    const { rows } = await client.query<{ ok: boolean }>(
      "select pg_try_advisory_lock(hashtext('tallyline-usage-rollup')::bigint) as ok",
    );
    if (!rows[0]?.ok) return false;
    try {
      const now = clock.ms();
      await settleDayRuns(dayKey(now - DAY_MS));
      await rollupUsage({ day: dayKey(now) });
      return true;
    } finally {
      await client
        .query("select pg_advisory_unlock(hashtext('tallyline-usage-rollup')::bigint)")
        .catch(() => {});
    }
  } finally {
    client.release();
  }
}

export interface UsageDay {
  day: string;
  seats: number;
  agents: number;
  agentRuns: number;
  apiCalls: number;
  storageBytes: number;
}

export interface UsageReport {
  plan: Entitlements;
  /** live values right now (not waiting for the rollup) */
  current: {
    seats: number;
    pendingInvites: number;
    agents: number;
    agentRunsThisMonth: number;
    apiCallsToday: number;
    storageBytes: number;
  };
  /** one entry per day, oldest first, gaps filled with zeros */
  daily: UsageDay[];
  from: string;
  to: string;
}

export async function usageReport(workspaceId: string, days: number): Promise<UsageReport> {
  const now = clock.ms();
  const to = dayKey(now);
  const from = dayKey(now - (days - 1) * DAY_MS);
  const rows = await db
    .select()
    .from(usageDaily)
    .where(
      and(
        eq(usageDaily.workspaceId, workspaceId),
        gte(usageDaily.day, from),
        lt(usageDaily.day, dayKey(now + DAY_MS)),
      ),
    )
    .orderBy(asc(usageDaily.day));
  const byDay = new Map(rows.map((r) => [r.day, r]));

  const current = {
    seats: await seatCount(workspaceId),
    pendingInvites: await pendingInviteCount(workspaceId),
    agents: await agentCount(workspaceId),
    agentRunsThisMonth: await agentRunsThisMonth(workspaceId),
    apiCallsToday: (byDay.get(to)?.apiCalls ?? 0) + pendingApiCalls(workspaceId, to),
    storageBytes: await storageBytes(workspaceId),
  };

  const daily: UsageDay[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const day = dayKey(now - i * DAY_MS);
    const r = byDay.get(day);
    daily.push({
      day,
      seats: r?.seats ?? 0,
      agents: r?.agents ?? 0,
      agentRuns: r?.agentRuns ?? 0,
      apiCalls: r?.apiCalls ?? 0,
      storageBytes: r?.storageBytes ?? 0,
    });
  }
  // today is live: the rollup may not have run yet
  const today = daily[daily.length - 1]!;
  today.seats = current.seats;
  today.agents = current.agents;
  today.agentRuns = await agentRunsOn(workspaceId, to);
  today.apiCalls = current.apiCallsToday;
  today.storageBytes = current.storageBytes;

  return { plan: await entitlements(workspaceId), current, daily, from, to };
}
