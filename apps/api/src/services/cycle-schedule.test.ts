import { and, asc, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { closeDb, db } from "../db/client.js";
import { runMigrations } from "../db/migrate.js";
import { cycles, issues, teams, workspaces } from "../db/schema.js";
import { tickCycleSchedule } from "./cycle-schedule.js";
import { sweepExpiredCycles } from "./cycles.js";

const slug = `cycsched-${Date.now()}`;
let wsId = "";
let seq = 0;

beforeAll(async () => {
  await runMigrations();
  vi.useFakeTimers({ toFake: ["Date"] });
  const [ws] = await db
    .insert(workspaces)
    .values({ slug, name: "Cycle schedule" })
    .returning();
  wsId = ws!.id;
});

afterAll(async () => {
  vi.useRealTimers();
  await closeDb();
});

afterEach(() => vi.setSystemTime(new Date("2026-10-14T12:00:00Z")));

async function mkTeam(over: Partial<typeof teams.$inferInsert> = {}) {
  seq += 1;
  const [t] = await db
    .insert(teams)
    .values({
      workspaceId: wsId,
      key: `T${seq}`,
      name: `Team ${seq}`,
      ...over,
    })
    .returning();
  return t!;
}

const teamCycles = (teamId: string) =>
  db
    .select()
    .from(cycles)
    .where(and(eq(cycles.workspaceId, wsId), eq(cycles.teamId, teamId)))
    .orderBy(asc(cycles.startsAt));

const iso = (d: Date) => d.toISOString();

describe("weekly cycle auto-schedule", () => {
  it("creates the current cycle (active) plus two upcoming once; a second tick adds none", async () => {
    vi.setSystemTime(new Date("2026-10-14T12:00:00Z")); // Wednesday
    const t = await mkTeam({ cycleAutoEnabled: true });
    expect(await tickCycleSchedule()).toBeGreaterThanOrEqual(3);
    const rows = await teamCycles(t.id);
    expect(rows.map((r) => iso(r.startsAt))).toEqual([
      "2026-10-12T00:00:00.000Z",
      "2026-10-19T00:00:00.000Z",
      "2026-10-26T00:00:00.000Z",
    ]);
    expect(rows.map((r) => r.number)).toEqual([1, 2, 3]);
    expect(rows.map((r) => r.isActive)).toEqual([true, false, false]);
    expect(iso(rows[0]!.endsAt)).toBe("2026-10-19T00:00:00.000Z");

    await tickCycleSchedule();
    expect(await teamCycles(t.id)).toHaveLength(3);
  });

  it("creates nothing for a team with the setting off", async () => {
    const t = await mkTeam();
    await tickCycleSchedule();
    expect(await teamCycles(t.id)).toHaveLength(0);
  });

  it("starts weeks at Monday 00:00 in the team timezone across a DST change", async () => {
    // Wed 4 Mar 2026; US DST begins Sun 8 Mar 02:00
    vi.setSystemTime(new Date("2026-03-04T15:00:00Z"));
    const t = await mkTeam({
      cycleAutoEnabled: true,
      timezone: "America/New_York",
    });
    await tickCycleSchedule();
    const rows = await teamCycles(t.id);
    expect(rows.map((r) => iso(r.startsAt))).toEqual([
      "2026-03-02T05:00:00.000Z", // Mon 00:00 EST
      "2026-03-09T04:00:00.000Z", // Mon 00:00 EDT
      "2026-03-16T04:00:00.000Z",
    ]);
    expect(rows[0]!.isActive).toBe(true);
  });

  it("flips the week exactly at local midnight", async () => {
    // Sun 1 Mar 2026 23:59 EST is still the week of Mon 23 Feb
    vi.setSystemTime(new Date("2026-03-02T04:59:00Z"));
    const before = await mkTeam({
      cycleAutoEnabled: true,
      timezone: "America/New_York",
    });
    await tickCycleSchedule();
    expect(iso((await teamCycles(before.id))[0]!.startsAt)).toBe(
      "2026-02-23T05:00:00.000Z",
    );
    // one minute later it is Mon 00:00 local
    vi.setSystemTime(new Date("2026-03-02T05:00:00Z"));
    const after = await mkTeam({
      cycleAutoEnabled: true,
      timezone: "America/New_York",
    });
    await tickCycleSchedule();
    expect(iso((await teamCycles(after.id))[0]!.startsAt)).toBe(
      "2026-03-02T05:00:00.000Z",
    );
  });

  it("honours length, start weekday and keep-ahead settings", async () => {
    vi.setSystemTime(new Date("2026-10-14T12:00:00Z")); // Wed
    const t = await mkTeam({
      cycleAutoEnabled: true,
      cycleLengthDays: 14,
      cycleStartWeekday: 3, // Wednesday
      cycleUpcomingCount: 1,
    });
    await tickCycleSchedule();
    expect((await teamCycles(t.id)).map((r) => iso(r.startsAt))).toEqual([
      "2026-10-14T00:00:00.000Z",
      "2026-10-28T00:00:00.000Z",
    ]);
  });

  it("does not backfill historic cycles after downtime", async () => {
    vi.setSystemTime(new Date("2026-10-14T12:00:00Z"));
    const t = await mkTeam({ cycleAutoEnabled: true });
    await tickCycleSchedule();
    vi.setSystemTime(new Date("2026-12-09T12:00:00Z")); // 8 weeks later
    await tickCycleSchedule();
    const rows = await teamCycles(t.id);
    expect(rows.filter((r) => r.startsAt > new Date("2026-10-26T00:00:00Z"))
      .map((r) => iso(r.startsAt))).toEqual([
      "2026-12-07T00:00:00.000Z",
      "2026-12-14T00:00:00.000Z",
      "2026-12-21T00:00:00.000Z",
    ]);
    expect(rows.filter((r) => r.isActive)).toHaveLength(1);
  });

  it("completing a cycle rolls open issues forward and activates the next one", async () => {
    vi.setSystemTime(new Date("2026-10-14T12:00:00Z"));
    const t = await mkTeam({ cycleAutoEnabled: true });
    await tickCycleSchedule();
    const [c1, c2] = await teamCycles(t.id);
    const [open] = await db
      .insert(issues)
      .values({
        workspaceId: wsId,
        teamId: t.id,
        key: `${t.key}-1`,
        number: 1,
        title: "carry me",
        state: "todo",
        cycleId: c1!.id,
      })
      .returning();

    vi.setSystemTime(new Date("2026-10-19T00:00:30Z")); // next Monday
    await sweepExpiredCycles();
    await tickCycleSchedule();

    const [moved] = await db.select().from(issues).where(eq(issues.id, open!.id));
    expect(moved!.cycleId).toBe(c2!.id);
    const rows = await teamCycles(t.id);
    expect(rows.find((r) => r.id === c1!.id)!.isActive).toBe(false);
    expect(rows.find((r) => r.id === c2!.id)!.isActive).toBe(true);
    // keep-ahead refilled to two upcoming
    expect(rows.filter((r) => r.startsAt > new Date()).length).toBe(2);
  });
});
