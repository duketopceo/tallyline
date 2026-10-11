import { and, asc, eq, gt, inArray, isNull, lt, ne, notInArray } from "drizzle-orm";
import { TERMINAL_STATES } from "@tallyline/types";
import { db } from "../db/client.js";
import {
  cycleVelocity,
  cycles,
  events,
  issues,
  teams,
  workspaces,
} from "../db/schema.js";
import { HttpError } from "../lib/errors.js";
import { clock } from "./clock.js";

export interface CycleCompletion {
  cycle: typeof cycles.$inferSelect;
  movedIssues: number;
  destination: "next_cycle" | "backlog" | "unscheduled";
}

// Completes a cycle: clears active, rolls open issues to the team's next
// cycle (or unschedules/resets to backlog per team policy), emits one
// `rolled_over` audit event per moved issue plus a cycle-level `completed`
// event, and records the velocity snapshot. Idempotent — the completed-event
// check makes re-runs safe (sweep + manual + retries share this path).
export async function completeCycle(
  workspaceId: string,
  cycleId: string,
  actor: { type: "human" | "agent" | "system"; id: string | null },
): Promise<CycleCompletion> {
  const [cycle] = await db
    .select()
    .from(cycles)
    .where(and(eq(cycles.id, cycleId), eq(cycles.workspaceId, workspaceId)));
  if (!cycle) throw new HttpError(404, "NOT_FOUND", "cycle not found");
  const [team] = await db
    .select()
    .from(teams)
    .where(and(eq(teams.id, cycle.teamId), eq(teams.workspaceId, workspaceId)));
  if (!team) throw new HttpError(404, "NOT_FOUND", "team not found");

  // idempotency: a completed cycle already has its feed event — retries and
  // sweep/manual overlap must not append duplicates
  const [done] = await db
    .select({ id: events.id })
    .from(events)
    .where(
      and(
        eq(events.entityType, "cycle"),
        eq(events.entityId, cycle.id),
        eq(events.action, "completed"),
      ),
    )
    .limit(1);
  if (done) {
    throw new HttpError(409, "ALREADY_COMPLETED", "cycle already completed");
  }

  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(cycles)
      .set({ isActive: false })
      .where(eq(cycles.id, cycle.id))
      .returning();

    const open = await tx
      .select({
        id: issues.id,
        key: issues.key,
        state: issues.state,
        estimate: issues.estimate,
      })
      .from(issues)
      .where(
        and(
          eq(issues.workspaceId, workspaceId),
          eq(issues.cycleId, cycle.id),
          notInArray(issues.state, [...TERMINAL_STATES]),
        ),
      );

    // "next cycle" is strictly the team's next cycle by start time —
    // completing early still lands issues in the following window.
    const [next] = await tx
      .select({ id: cycles.id })
      .from(cycles)
      .where(
        and(
          eq(cycles.workspaceId, workspaceId),
          eq(cycles.teamId, team.id),
          gt(cycles.startsAt, cycle.startsAt),
          ne(cycles.id, cycle.id),
        ),
      )
      .orderBy(asc(cycles.startsAt))
      .limit(1);

    const destination =
      team.rolloverBehavior === "next_cycle"
        ? next
          ? ("next_cycle" as const)
          : ("unscheduled" as const)
        : ("backlog" as const);

    if (open.length > 0) {
      const ids = open.map((i) => i.id);
      if (destination === "next_cycle") {
        await tx
          .update(issues)
          .set({ cycleId: next!.id, updatedAt: clock.now() })
          .where(inArray(issues.id, ids));
      } else {
        await tx
          .update(issues)
          .set({
            cycleId: null,
            updatedAt: clock.now(),
            // "backlog" rollover literally returns work to the backlog;
            // "unscheduled" just drops the cycle pointer
            ...(destination === "backlog"
              ? { state: "backlog" as const }
              : {}),
          })
          .where(inArray(issues.id, ids));
      }
      // per-issue audit: each moved issue carries its own rollover event
      await tx.insert(events).values(
        open.map((i) => ({
          workspaceId,
          entityType: "issue",
          entityId: i.id,
          action: "rolled_over",
          actorType: actor.type,
          actorId: actor.id,
          before: { key: i.key, cycleId: cycle.id, state: i.state },
          after: {
            key: i.key,
            cycleId: destination === "next_cycle" ? next!.id : null,
            state:
              destination === "backlog" ? ("backlog" as const) : i.state,
          },
        })),
      );
    }

    await tx.insert(events).values({
      workspaceId,
      entityType: "cycle",
      entityId: cycle.id,
      action: "completed",
      actorType: actor.type,
      actorId: actor.id,
      after: {
        number: cycle.number,
        movedIssues: open.length,
        destination,
      },
    });

    // velocity snapshot — the queryable shape Insights reads
    const all = await tx
      .select({ state: issues.state, estimate: issues.estimate })
      .from(issues)
      .where(
        and(eq(issues.workspaceId, workspaceId), eq(issues.cycleId, cycle.id)),
      );
    // every `open` issue left this cycle in the rollover (all destinations);
    // the snapshot = terminal rows still pointing at the cycle + everything
    // that was open at completion time
    const rows = [
      ...all,
      ...open.map((i) => ({ state: i.state, estimate: i.estimate })),
    ];
    const doneRows = rows.filter((r) =>
      (TERMINAL_STATES as readonly string[]).includes(r.state),
    );
    const estimateOf = (list: typeof rows) =>
      list.reduce((sum, r) => sum + (r.estimate ?? 0), 0);
    await tx.insert(cycleVelocity).values({
      workspaceId,
      teamId: team.id,
      cycleId: cycle.id,
      issueCount: rows.length,
      doneCount: doneRows.length,
      estimateDone: estimateOf(doneRows),
      estimateTotal: estimateOf(rows),
    });

    return {
      cycle: updated!,
      movedIssues: open.length,
      destination,
    };
  });
}

// Sweeper: completes active cycles whose window has closed. Runs on the API
// interval alongside the webhook sweeper — idempotent by completeCycle.
export async function sweepExpiredCycles(now = clock.now()): Promise<number> {
  const expired = await db
    .select({ id: cycles.id, workspaceId: cycles.workspaceId })
    .from(cycles)
    .innerJoin(workspaces, eq(workspaces.id, cycles.workspaceId))
    // a workspace pending deletion is frozen: no unattended writes
    .where(and(eq(cycles.isActive, true), lt(cycles.endsAt, now), isNull(workspaces.deletedAt)));
  let completed = 0;
  for (const c of expired) {
    try {
      await completeCycle(c.workspaceId, c.id, { type: "system", id: null });
      completed++;
    } catch (e) {
      // ALREADY_COMPLETED means a manual complete raced the sweep — fine
      if (!(e instanceof HttpError && e.status === 409)) throw e;
    }
  }
  return completed;
}
