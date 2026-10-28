import { zValidator } from "@hono/zod-validator";
import { and, asc, desc, eq, inArray, ne, notInArray, or, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { db } from "../db/client.js";
import {
  cycles,
  issues,
  projectMilestones,
  projects,
  teams,
  views,
} from "../db/schema.js";
import { actorFromHeaders } from "../lib/actor.js";
import { apiError, HttpError } from "../lib/errors.js";
import { completeCycle } from "../services/cycles.js";
import { computeInsights } from "../services/insights.js";
import { requireWorkspace } from "./workspaces.js";
import { clock } from "../services/clock.js";

const PROJECT_STATUSES = [
  "backlog",
  "planned",
  "started",
  "paused",
  "completed",
  "canceled",
] as const;

const projectCreateSchema = z
  .object({
    name: z.string().min(1).max(200),
    description: z.string().max(10_000).optional(),
    status: z.enum(PROJECT_STATUSES).default("planned"),
    teamKey: z.string().min(1).max(6).optional(),
    startDate: z.iso.datetime().optional(),
    targetDate: z.iso.datetime().optional(),
  })
  .refine(
    (v) =>
      !v.startDate ||
      !v.targetDate ||
      new Date(v.targetDate) > new Date(v.startDate),
    { message: "targetDate must be after startDate" },
  );

const projectPatchSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(10_000).nullable().optional(),
  status: z.enum(PROJECT_STATUSES).optional(),
  startDate: z.iso.datetime().nullable().optional(),
  targetDate: z.iso.datetime().nullable().optional(),
});

const milestoneCreateSchema = z.object({
  title: z.string().min(1).max(200),
  targetDate: z.iso.datetime().optional(),
  sortOrder: z.number().optional(),
  done: z.boolean().default(false),
});

const milestonePatchSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  targetDate: z.iso.datetime().nullable().optional(),
  sortOrder: z.number().optional(),
  done: z.boolean().optional(),
});

const cycleCreateSchema = z
  .object({
    teamKey: z.string().min(1).max(6),
    name: z.string().max(120).optional(),
    startsAt: z.iso.datetime(),
    endsAt: z.iso.datetime(),
    isActive: z.boolean().default(false),
  })
  .refine((v) => new Date(v.endsAt) > new Date(v.startsAt), {
    message: "endsAt must be after startsAt",
  });

const cyclePatchSchema = z.object({
  name: z.string().max(120).nullable().optional(),
  startsAt: z.iso.datetime().optional(),
  endsAt: z.iso.datetime().optional(),
  isActive: z.boolean().optional(),
});

const cycleQuerySchema = z.object({
  team: z.string().optional(),
  active: z
    .string()
    .transform((v) => v === "true" || v === "1")
    .optional(),
});

const viewCreateSchema = z.object({
  name: z.string().min(1).max(120),
  filters: z.record(z.string(), z.unknown()),
  shared: z.boolean().default(false),
});

const viewPatchSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  filters: z.record(z.string(), z.unknown()).optional(),
  shared: z.boolean().optional(),
});

async function findProject(workspaceId: string, id: string) {
  const [row] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, id), eq(projects.workspaceId, workspaceId)));
  if (!row) throw new HttpError(404, "NOT_FOUND", "project not found");
  return row;
}

// Milestone progress counts the issues linked to the milestone (U16), not the
// project's issues. Canceled and duplicate issues are out of the denominator.
async function withProgress<T extends { id: string }>(
  rows: T[],
): Promise<(T & { progress: { total: number; done: number } })[]> {
  const counts = rows.length
    ? await db
        .select({
          id: issues.milestoneId,
          total: sql<number>`count(*)::int`,
          done: sql<number>`count(*) filter (where ${issues.state} = 'done')::int`,
        })
        .from(issues)
        .where(
          and(
            inArray(issues.milestoneId, rows.map((r) => r.id)),
            notInArray(issues.state, ["canceled", "duplicate"]),
          ),
        )
        .groupBy(issues.milestoneId)
    : [];
  const byId = new Map(counts.map((c) => [c.id, c]));
  return rows.map((r) => ({
    ...r,
    progress: { total: byId.get(r.id)?.total ?? 0, done: byId.get(r.id)?.done ?? 0 },
  }));
}

async function findMilestone(
  workspaceId: string,
  projectId: string,
  id: string,
) {
  const [row] = await db
    .select()
    .from(projectMilestones)
    .where(
      and(
        eq(projectMilestones.id, id),
        eq(projectMilestones.projectId, projectId),
        eq(projectMilestones.workspaceId, workspaceId),
      ),
    );
  if (!row) throw new HttpError(404, "NOT_FOUND", "milestone not found");
  return row;
}

async function findCycle(workspaceId: string, id: string) {
  const [row] = await db
    .select()
    .from(cycles)
    .where(and(eq(cycles.id, id), eq(cycles.workspaceId, workspaceId)));
  if (!row) throw new HttpError(404, "NOT_FOUND", "cycle not found");
  return row;
}

async function findView(workspaceId: string, id: string) {
  const [row] = await db
    .select()
    .from(views)
    .where(and(eq(views.id, id), eq(views.workspaceId, workspaceId)));
  if (!row) throw new HttpError(404, "NOT_FOUND", "view not found");
  return row;
}

async function teamForKey(workspaceId: string, key: string) {
  const [team] = await db
    .select()
    .from(teams)
    .where(and(eq(teams.workspaceId, workspaceId), eq(teams.key, key)));
  if (!team) throw new HttpError(404, "NOT_FOUND", `team ${key} not found`);
  return team;
}

type DbTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

// One active cycle per team: before flagging a cycle active, clear the flag
// on every other cycle of the same team. Runs inside the caller's tx so the
// partial unique index never sees two active rows.
async function deactivateOtherCycles(
  tx: DbTx,
  teamId: string,
  keepId?: string,
) {
  const cond = [eq(cycles.teamId, teamId), eq(cycles.isActive, true)];
  if (keepId) cond.push(ne(cycles.id, keepId));
  await tx.update(cycles).set({ isActive: false }).where(and(...cond));
}

// Concurrent activations of the same team's cycles can both pass
// deactivateOtherCycles under READ COMMITTED; the loser then trips
// cycles_one_active_per_team. Surface that as a conflict, not a 500.
async function withActiveRaceConflict<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (
      e instanceof Error &&
      "code" in e &&
      (e as { code?: string }).code === "23505" &&
      e.message.includes("cycles_one_active_per_team")
    ) {
      throw new HttpError(
        409,
        "ACTIVE_CYCLE_CONFLICT",
        "another cycle was activated concurrently — retry",
      );
    }
    throw e;
  }
}

export const resourceRoutes = new Hono()
  // ── Projects ─────────────────────────────────────────────
  .get("/workspaces/:ws/projects", async (c) => {
    const ws = await requireWorkspace(c);
    const rows = await db
      .select()
      .from(projects)
      .where(eq(projects.workspaceId, ws.id))
      .orderBy(asc(projects.createdAt));
    return c.json({ projects: rows });
  })
  .post(
    "/workspaces/:ws/projects",
    zValidator("json", projectCreateSchema),
    async (c) => {
      const ws = await requireWorkspace(c);
      const body = c.req.valid("json");
      let teamId: string | null = null;
      if (body.teamKey) teamId = (await teamForKey(ws.id, body.teamKey)).id;
      const [project] = await db
        .insert(projects)
        .values({
          workspaceId: ws.id,
          teamId,
          name: body.name,
          status: body.status,
          ...(body.description !== undefined
            ? { description: body.description }
            : {}),
          ...(body.startDate !== undefined
            ? { startDate: new Date(body.startDate) }
            : {}),
          ...(body.targetDate !== undefined
            ? { targetDate: new Date(body.targetDate) }
            : {}),
        })
        .returning();
      return c.json(project, 201);
    },
  )
  .patch(
    "/workspaces/:ws/projects/:id",
    zValidator("json", projectPatchSchema),
    async (c) => {
      const ws = await requireWorkspace(c);
      const project = await findProject(ws.id, c.req.param("id"));
      const body = c.req.valid("json");
      // merged window check — patching one end can't invert the span
      const startDate =
        body.startDate !== undefined
          ? body.startDate === null
            ? null
            : new Date(body.startDate)
          : project.startDate;
      const targetDate =
        body.targetDate !== undefined
          ? body.targetDate === null
            ? null
            : new Date(body.targetDate)
          : project.targetDate;
      if (startDate && targetDate && targetDate <= startDate) {
        throw new HttpError(
          422,
          "INVALID_WINDOW",
          "targetDate must be after startDate",
        );
      }
      const [updated] = await db
        .update(projects)
        .set({
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.description !== undefined
            ? { description: body.description }
            : {}),
          ...(body.status !== undefined ? { status: body.status } : {}),
          ...(body.startDate !== undefined ? { startDate } : {}),
          ...(body.targetDate !== undefined ? { targetDate } : {}),
        })
        .where(eq(projects.id, project.id))
        .returning();
      return c.json(updated);
    },
  )
  .delete("/workspaces/:ws/projects/:id", async (c) => {
    const ws = await requireWorkspace(c);
    const project = await findProject(ws.id, c.req.param("id"));
    await db.transaction(async (tx) => {
      // issues.project_id has no ON DELETE rule — unassign before delete;
      // project_milestones cascade with the project row
      await tx
        .update(issues)
        .set({ projectId: null, updatedAt: clock.now() })
        .where(eq(issues.projectId, project.id));
      await tx.delete(projects).where(eq(projects.id, project.id));
    });
    return c.json({ ok: true });
  })
  // ── Project milestones ───────────────────────────────────
  .get("/workspaces/:ws/milestones", async (c) => {
    // flat list — the roadmap pulls every milestone in one request
    const ws = await requireWorkspace(c);
    const rows = await db
      .select()
      .from(projectMilestones)
      .where(eq(projectMilestones.workspaceId, ws.id))
      .orderBy(asc(projectMilestones.sortOrder), asc(projectMilestones.createdAt));
    return c.json({ milestones: await withProgress(rows) });
  })
  .get("/workspaces/:ws/projects/:id/milestones", async (c) => {
    const ws = await requireWorkspace(c);
    const project = await findProject(ws.id, c.req.param("id"));
    const rows = await db
      .select()
      .from(projectMilestones)
      .where(eq(projectMilestones.projectId, project.id))
      .orderBy(asc(projectMilestones.sortOrder), asc(projectMilestones.createdAt));
    return c.json({ milestones: await withProgress(rows) });
  })
  .post(
    "/workspaces/:ws/projects/:id/milestones",
    zValidator("json", milestoneCreateSchema),
    async (c) => {
      const ws = await requireWorkspace(c);
      const project = await findProject(ws.id, c.req.param("id"));
      const body = c.req.valid("json");
      const [milestone] = await db
        .insert(projectMilestones)
        .values({
          workspaceId: ws.id,
          projectId: project.id,
          title: body.title,
          ...(body.targetDate !== undefined
            ? { targetDate: new Date(body.targetDate) }
            : {}),
          ...(body.sortOrder !== undefined
            ? { sortOrder: body.sortOrder }
            : {}),
          done: body.done,
        })
        .returning();
      return c.json(milestone, 201);
    },
  )
  .patch(
    "/workspaces/:ws/projects/:id/milestones/:mid",
    zValidator("json", milestonePatchSchema),
    async (c) => {
      const ws = await requireWorkspace(c);
      const project = await findProject(ws.id, c.req.param("id"));
      const milestone = await findMilestone(
        ws.id,
        project.id,
        c.req.param("mid"),
      );
      const body = c.req.valid("json");
      const [updated] = await db
        .update(projectMilestones)
        .set({
          ...(body.title !== undefined ? { title: body.title } : {}),
          ...(body.targetDate !== undefined
            ? {
                targetDate:
                  body.targetDate === null
                    ? null
                    : new Date(body.targetDate),
              }
            : {}),
          ...(body.sortOrder !== undefined
            ? { sortOrder: body.sortOrder }
            : {}),
          ...(body.done !== undefined ? { done: body.done } : {}),
        })
        .where(eq(projectMilestones.id, milestone.id))
        .returning();
      return c.json(updated);
    },
  )
  .delete(
    "/workspaces/:ws/projects/:id/milestones/:mid",
    async (c) => {
      const ws = await requireWorkspace(c);
      const project = await findProject(ws.id, c.req.param("id"));
      const milestone = await findMilestone(
        ws.id,
        project.id,
        c.req.param("mid"),
      );
      await db
        .delete(projectMilestones)
        .where(eq(projectMilestones.id, milestone.id));
      return c.json({ ok: true });
    },
  )
  // ── Cycles ───────────────────────────────────────────────
  .get(
    "/workspaces/:ws/cycles",
    zValidator("query", cycleQuerySchema),
    async (c) => {
      const ws = await requireWorkspace(c);
      const q = c.req.valid("query");
      const filters = [eq(cycles.workspaceId, ws.id)];
      if (q.team)
        filters.push(
          eq(cycles.teamId, (await teamForKey(ws.id, q.team)).id),
        );
      // `active` is the team's flagged current cycle, not a date-window
      // probe — the flag is what the Cycle view and rollover act on.
      if (q.active) filters.push(eq(cycles.isActive, true));
      const rows = await db
        .select()
        .from(cycles)
        .where(and(...filters))
        .orderBy(asc(cycles.startsAt));
      return c.json({ cycles: rows });
    },
  )
  .post(
    "/workspaces/:ws/cycles",
    zValidator("json", cycleCreateSchema),
    async (c) => {
      const ws = await requireWorkspace(c);
      const body = c.req.valid("json");
      const team = await teamForKey(ws.id, body.teamKey);
      const cycle = await withActiveRaceConflict(() =>
        db.transaction(async (tx) => {
        if (body.isActive) await deactivateOtherCycles(tx, team.id);
        const [latest] = await tx
          .select({ number: cycles.number })
          .from(cycles)
          .where(eq(cycles.teamId, team.id))
          .orderBy(desc(cycles.number))
          .limit(1);
        const number = (latest?.number ?? 0) + 1;
        const [created] = await tx
          .insert(cycles)
          .values({
            workspaceId: ws.id,
            teamId: team.id,
            number,
            ...(body.name !== undefined ? { name: body.name } : {}),
            startsAt: new Date(body.startsAt),
            endsAt: new Date(body.endsAt),
            isActive: body.isActive,
          })
          .returning();
        return created!;
        }),
      );
      return c.json(cycle, 201);
    },
  )
  .get("/workspaces/:ws/cycles/:id", async (c) => {
    const ws = await requireWorkspace(c);
    return c.json(await findCycle(ws.id, c.req.param("id")));
  })
  .patch(
    "/workspaces/:ws/cycles/:id",
    zValidator("json", cyclePatchSchema),
    async (c) => {
      const ws = await requireWorkspace(c);
      const cycle = await findCycle(ws.id, c.req.param("id"));
      const body = c.req.valid("json");
      const startsAt =
        body.startsAt !== undefined
          ? new Date(body.startsAt)
          : cycle.startsAt;
      const endsAt =
        body.endsAt !== undefined ? new Date(body.endsAt) : cycle.endsAt;
      if (endsAt <= startsAt) {
        throw new HttpError(
          422,
          "INVALID_WINDOW",
          "endsAt must be after startsAt",
        );
      }
      const updated = await withActiveRaceConflict(() =>
        db.transaction(async (tx) => {
        // activating a cycle demotes the team's previous active one — the
        // partial unique index backstops this if the ordering is ever lost
        if (body.isActive === true) {
          await deactivateOtherCycles(tx, cycle.teamId, cycle.id);
        }
        const [row] = await tx
          .update(cycles)
          .set({
            ...(body.name !== undefined ? { name: body.name } : {}),
            ...(body.startsAt !== undefined ? { startsAt } : {}),
            ...(body.endsAt !== undefined ? { endsAt } : {}),
            ...(body.isActive !== undefined
              ? { isActive: body.isActive }
              : {}),
          })
          .where(eq(cycles.id, cycle.id))
          .returning();
        return row!;
        }),
      );
      return c.json(updated);
    },
  )
  .post("/workspaces/:ws/cycles/:id/complete", async (c) => {
    const ws = await requireWorkspace(c);
    const actor = actorFromHeaders(c);
    const result = await completeCycle(ws.id, c.req.param("id"), actor);
    return c.json(result);
  })
  .delete("/workspaces/:ws/cycles/:id", async (c) => {
    const ws = await requireWorkspace(c);
    const cycle = await findCycle(ws.id, c.req.param("id"));
    await db.transaction(async (tx) => {
      // issues.cycle_id has no ON DELETE rule — unassign before delete
      await tx
        .update(issues)
        .set({ cycleId: null, updatedAt: clock.now() })
        .where(eq(issues.cycleId, cycle.id));
      await tx.delete(cycles).where(eq(cycles.id, cycle.id));
    });
    return c.json({ ok: true });
  })
  // ── Views (saved filters) ────────────────────────────────
  .get("/workspaces/:ws/views", async (c) => {
    const ws = await requireWorkspace(c);
    const session = c.get("session");
    if (!session) {
      return apiError(c, 403, "FORBIDDEN", "views require a user identity");
    }
    const rows = await db
      .select()
      .from(views)
      .where(
        and(
          eq(views.workspaceId, ws.id),
          or(eq(views.ownerId, session.userId), eq(views.shared, true)),
        ),
      )
      .orderBy(asc(views.createdAt));
    return c.json({ views: rows });
  })
  .post(
    "/workspaces/:ws/views",
    zValidator("json", viewCreateSchema),
    async (c) => {
      const ws = await requireWorkspace(c);
      const session = c.get("session");
      if (!session) {
        return apiError(c, 403, "FORBIDDEN", "views require a user identity");
      }
      const body = c.req.valid("json");
      const [view] = await db
        .insert(views)
        .values({
          workspaceId: ws.id,
          ownerId: session.userId,
          name: body.name,
          filters: body.filters,
          shared: body.shared,
        })
        .returning();
      return c.json(view, 201);
    },
  )
  .patch(
    "/workspaces/:ws/views/:id",
    zValidator("json", viewPatchSchema),
    async (c) => {
      const ws = await requireWorkspace(c);
      const session = c.get("session");
      const view = await findView(ws.id, c.req.param("id"));
      if (!session || view.ownerId !== session.userId) {
        return apiError(c, 403, "FORBIDDEN", "only the owner can edit a view");
      }
      const body = c.req.valid("json");
      const [updated] = await db
        .update(views)
        .set({
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.filters !== undefined ? { filters: body.filters } : {}),
          ...(body.shared !== undefined ? { shared: body.shared } : {}),
        })
        .where(eq(views.id, view.id))
        .returning();
      return c.json(updated);
    },
  )
  .delete("/workspaces/:ws/views/:id", async (c) => {
    const ws = await requireWorkspace(c);
    const session = c.get("session");
    const view = await findView(ws.id, c.req.param("id"));
    if (!session || view.ownerId !== session.userId) {
      return apiError(c, 403, "FORBIDDEN", "only the owner can delete a view");
    }
    await db.delete(views).where(eq(views.id, view.id));
    return c.json({ ok: true });
  })

  // ── Insights ─────────────────────────────────────────────
  .get("/workspaces/:ws/insights", async (c) => {
    const ws = await requireWorkspace(c);
    return c.json(await computeInsights(ws.id));
  });
