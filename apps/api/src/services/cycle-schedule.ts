import { and, asc, desc, eq, gt, lte, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { cycles, events, teams } from "../db/schema.js";
import { clock } from "./clock.js";

// Weekly cycle auto-schedule (KTD8). For every team that opted in, keeps one
// cycle covering "now" plus `cycleUpcomingCount` future ones, and flags the
// current one active when the team has none. Boundaries are local midnight on
// the team's start weekday in its IANA timezone (UTC when unset), computed from
// calendar dates so a DST change never shifts a week off midnight.
// Rolling issues over is completeCycle's job (sweepExpiredCycles runs first);
// this only creates and activates windows. Idempotent: a second tick adds none.

type Team = typeof teams.$inferSelect;
type Parts = { y: number; m: number; d: number; weekday: number };

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
      weekday: "short",
    });
    formatters.set(tz, f);
  }
  return f;
}

export function isValidTimezone(tz: string): boolean {
  try {
    formatter(tz);
    return true;
  } catch {
    return false;
  }
}

function localParts(ms: number, tz: string): Parts & { msOfDay: number } {
  const p = Object.fromEntries(
    formatter(tz)
      .formatToParts(new Date(ms))
      .map((x) => [x.type, x.value]),
  );
  return {
    y: Number(p.year),
    m: Number(p.month),
    d: Number(p.day),
    weekday: WEEKDAYS.indexOf(String(p.weekday)),
    msOfDay:
      ((Number(p.hour) * 60 + Number(p.minute)) * 60 + Number(p.second)) * 1000,
  };
}

// UTC offset (ms) of `tz` at the instant `ms`
function offsetAt(ms: number, tz: string): number {
  const p = localParts(ms, tz);
  return Date.UTC(p.y, p.m - 1, p.d) + p.msOfDay - Math.floor(ms / 1000) * 1000;
}

// The instant of 00:00 on a local calendar date (month may overflow, as in Date.UTC)
function localMidnight(y: number, m: number, d: number, tz: string): number {
  const guess = Date.UTC(y, m - 1, d);
  let t = guess - offsetAt(guess, tz);
  t = guess - offsetAt(t, tz);
  return t;
}

// Start of the window that contains `ms`: the latest start weekday at local midnight.
function windowStartContaining(ms: number, tz: string, weekday: number): number {
  const p = localParts(ms, tz);
  const back = (p.weekday - weekday + 7) % 7;
  return localMidnight(p.y, p.m, p.d - back, tz);
}

function addDays(ms: number, days: number, tz: string): number {
  const p = localParts(ms, tz);
  return localMidnight(p.y, p.m, p.d + days, tz);
}

// Snap an arbitrary instant (a manual cycle's end) up to the next local midnight.
function snapUpToMidnight(ms: number, tz: string): number {
  const p = localParts(ms, tz);
  const mid = localMidnight(p.y, p.m, p.d, tz);
  return mid >= ms ? mid : localMidnight(p.y, p.m, p.d + 1, tz);
}

async function scheduleTeam(team: Team, now: number): Promise<number> {
  const tz = team.timezone ?? "UTC";
  const length = team.cycleLengthDays;
  const created: { id: string; number: number; startsAt: Date }[] = [];

  await db.transaction(async (tx) => {
    // serialize ticks per team (also across API replicas)
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${team.id}, 0))`,
    );
    const [last] = await tx
      .select()
      .from(cycles)
      .where(eq(cycles.teamId, team.id))
      .orderBy(desc(cycles.startsAt))
      .limit(1);
    const upcomingRows = await tx
      .select({ id: cycles.id })
      .from(cycles)
      .where(and(eq(cycles.teamId, team.id), gt(cycles.startsAt, new Date(now))));
    const [covering] = await tx
      .select({ id: cycles.id })
      .from(cycles)
      .where(
        and(
          eq(cycles.teamId, team.id),
          lte(cycles.startsAt, new Date(now)),
          gt(cycles.endsAt, new Date(now)),
        ),
      )
      .limit(1);

    // next window to create: continue after the last cycle, but never create
    // windows that already ended (downtime does not backfill history)
    const current = windowStartContaining(now, tz, team.cycleStartWeekday);
    let start = last ? snapUpToMidnight(last.endsAt.getTime(), tz) : current;
    if (addDays(start, length, tz) <= now) start = current;

    let upcoming = upcomingRows.length;
    let haveCovering = Boolean(covering);
    let number = last?.number ?? 0;
    // bounded loop: at most keep-ahead + 1 windows are ever missing
    for (let i = 0; i < team.cycleUpcomingCount + 2; i++) {
      if (haveCovering && upcoming >= team.cycleUpcomingCount) break;
      const end = addDays(start, length, tz);
      number += 1;
      const [row] = await tx
        .insert(cycles)
        .values({
          workspaceId: team.workspaceId,
          teamId: team.id,
          number,
          startsAt: new Date(start),
          endsAt: new Date(end),
        })
        .returning({ id: cycles.id, number: cycles.number, startsAt: cycles.startsAt });
      created.push(row!);
      if (start <= now && now < end) haveCovering = true;
      else if (start > now) upcoming += 1;
      start = end;
    }

    // activate the cycle covering now when the team has no active one
    const [active] = await tx
      .select({ id: cycles.id })
      .from(cycles)
      .where(and(eq(cycles.teamId, team.id), eq(cycles.isActive, true)))
      .limit(1);
    if (!active) {
      const [cur] = await tx
        .select({ id: cycles.id })
        .from(cycles)
        .where(
          and(
            eq(cycles.teamId, team.id),
            lte(cycles.startsAt, new Date(now)),
            gt(cycles.endsAt, new Date(now)),
          ),
        )
        .orderBy(asc(cycles.startsAt))
        .limit(1);
      if (cur) {
        await tx.update(cycles).set({ isActive: true }).where(eq(cycles.id, cur.id));
      }
    }

    if (created.length > 0) {
      await tx.insert(events).values(
        created.map((c) => ({
          workspaceId: team.workspaceId,
          entityType: "cycle",
          entityId: c.id,
          action: "created",
          actorType: "system" as const,
          actorId: null,
          after: { number: c.number, startsAt: c.startsAt, auto: true },
        })),
      );
    }
  });
  return created.length;
}

// Returns the number of cycles created across all teams.
export async function tickCycleSchedule(): Promise<number> {
  const now = clock.ms();
  const enabled = await db
    .select()
    .from(teams)
    .where(eq(teams.cycleAutoEnabled, true));
  let total = 0;
  for (const team of enabled) {
    try {
      total += await scheduleTeam(team, now);
    } catch (e) {
      // one bad team (e.g. an unusable timezone) must not stall the others
      console.error(`cycle schedule failed for team ${team.key}`, e);
    }
  }
  return total;
}
