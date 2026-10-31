import { zValidator } from "@hono/zod-validator";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { db } from "../db/client.js";
import {
  agentSessions,
  agents,
  comments,
  dispatchEvents,
  dispatchEventKinds,
  dispatches,
  events,
  issues,
} from "../db/schema.js";
import { HttpError } from "../lib/errors.js";
import { queueDeliveries } from "../services/outbound.js";
import { requireWorkspace } from "./workspaces.js";
import { clock } from "../services/clock.js";

const reportSchema = z.object({
  outcome: z.enum(["completed", "failed"]),
  reason: z.string().max(500).optional(),
  branch: z
    .string()
    .max(200)
    .regex(/^[^\s~^:?*\[\]]+$/, "invalid branch name")
    .optional(),
  prUrl: z.url().optional(),
});

const sessionEventSchema = z.object({
  events: z
    .array(
      z.object({
        kind: z.enum(dispatchEventKinds),
        message: z.string().min(1).max(500),
      }),
    )
    .min(1)
    .max(50),
});

async function requireDispatch(c: {
  req: { param: (k: string) => string };
}) {
  const [dispatch] = await db
    .select()
    .from(dispatches)
    .where(eq(dispatches.id, c.req.param("id")))
    .limit(1);
  return dispatch;
}

export const dispatchRoutes = new Hono()
  // list dispatches — agent keys only see their own
  .get("/workspaces/:ws/dispatches", async (c) => {
    const ws = await requireWorkspace(c);
    const agent = c.get("agentAuth");
    const status = c.req.query("status");
    const agentId = c.req.query("agentId") ?? agent?.agentId;

    const filters = [eq(dispatches.workspaceId, ws.id)];
    if (agentId) filters.push(eq(dispatches.agentId, agentId));
    if (status) {
      filters.push(
        eq(
          dispatches.status,
          status as "queued" | "claimed" | "dispatch_failed" | "completed" | "canceled",
        ),
      );
    }
    const rows = await db
      .select({
        id: dispatches.id,
        status: dispatches.status,
        trigger: dispatches.trigger,
        adapter: dispatches.adapter,
        reason: dispatches.reason,
        commentBody: dispatches.commentBody,
        createdAt: dispatches.createdAt,
        updatedAt: dispatches.updatedAt,
        agentId: dispatches.agentId,
        agentName: agents.name,
        issueId: issues.id,
        issueKey: issues.key,
        issueTitle: issues.title,
      })
      .from(dispatches)
      .innerJoin(agents, eq(dispatches.agentId, agents.id))
      .innerJoin(issues, eq(dispatches.issueId, issues.id))
      .where(and(...filters))
      .orderBy(desc(dispatches.createdAt))
      .limit(100);
    return c.json({ dispatches: rows });
  })
  // review queue — in_review issues that have at least one dispatch,
  // with the agent + status of the most recent session
  .get("/workspaces/:ws/review-queue", async (c) => {
    const ws = await requireWorkspace(c);
    const rows = await db
      .select({
        id: issues.id,
        key: issues.key,
        title: issues.title,
        priority: issues.priority,
        updatedAt: issues.updatedAt,
        dispatchId: dispatches.id,
        dispatchStatus: dispatches.status,
        agentName: agents.name,
        sessionAt: dispatches.createdAt,
      })
      .from(issues)
      .innerJoin(dispatches, eq(dispatches.issueId, issues.id))
      .innerJoin(agents, eq(dispatches.agentId, agents.id))
      .where(and(eq(issues.workspaceId, ws.id), eq(issues.state, "in_review")))
      .orderBy(desc(dispatches.createdAt));
    // one row per issue — its most recent dispatch
    const byIssue = new Map<string, (typeof rows)[number]>();
    for (const r of rows) {
      if (!byIssue.has(r.id)) byIssue.set(r.id, r);
    }
    return c.json({ queue: [...byIssue.values()] });
  })
  // nav badge — same queue definition, count only (distinct in_review issues
  // that carry at least one dispatch)
  .get("/workspaces/:ws/review-queue/count", async (c) => {
    const ws = await requireWorkspace(c);
    const [row] = await db
      .select({ count: sql<number>`count(distinct ${issues.id})::int` })
      .from(issues)
      .innerJoin(
        dispatches,
        and(
          eq(dispatches.issueId, issues.id),
          // referentially redundant (a dispatch's workspace is its issue's)
          // but lets the planner probe dispatches(workspace_id, issue_id)
          eq(dispatches.workspaceId, ws.id),
        ),
      )
      .where(and(eq(issues.workspaceId, ws.id), eq(issues.state, "in_review")));
    return c.json({ count: row?.count ?? 0 });
  })
  // session lifecycle report — agent keys report only their own dispatches
  .post(
    "/workspaces/:ws/dispatches/:id/report",
    zValidator("json", reportSchema),
    async (c) => {
      const ws = await requireWorkspace(c);
      const agent = c.get("agentAuth");
      const body = c.req.valid("json");

      const [dispatch] = await db
        .select()
        .from(dispatches)
        .where(
          and(
            eq(dispatches.id, c.req.param("id")),
            eq(dispatches.workspaceId, ws.id),
          ),
        )
        .limit(1);
      if (!dispatch) {
        throw new HttpError(404, "NOT_FOUND", "dispatch not found");
      }
      if (agent && agent.agentId !== dispatch.agentId) {
        throw new HttpError(
          403,
          "FORBIDDEN",
          "agent keys may only report their own dispatches",
        );
      }

      const status = body.outcome === "completed" ? "completed" : "dispatch_failed";
      await db
        .update(dispatches)
        .set({
          status,
          reason: body.reason ?? null,
          updatedAt: clock.now(),
        })
        .where(eq(dispatches.id, dispatch.id));

      const detail = {
        dispatchId: dispatch.id,
        ...(body.branch ? { branch: body.branch } : {}),
        ...(body.prUrl ? { pr: body.prUrl } : {}),
        ...(body.reason ? { reason: body.reason } : {}),
      };
      const action =
        body.outcome === "completed" ? "dispatch_completed" : "dispatch_failed";
      await db.insert(events).values({
        workspaceId: ws.id,
        entityType: "issue",
        entityId: dispatch.issueId,
        action,
        actorType: agent ? "agent" : "system",
        actorId: agent?.agentId ?? null,
        after: detail,
      });
      await queueDeliveries({
        workspaceId: ws.id,
        entityType: "issue",
        entityId: dispatch.issueId,
        action,
        actorType: agent ? "agent" : "system",
        actorId: agent?.agentId ?? null,
        after: detail,
      });
      await db.insert(comments).values({
        workspaceId: ws.id,
        issueId: dispatch.issueId,
        actorType: agent ? "agent" : "system",
        actorId: agent?.agentId ?? null,
        body:
          body.outcome === "completed"
            ? `session completed${body.branch ? ` — branch \`${body.branch}\`` : ""}${body.prUrl ? ` — ${body.prUrl}` : ""}`
            : `session failed${body.reason ? `: ${body.reason}` : ""}`,
      });
      return c.json({ ok: true, status });
    },
  )
  // append session events — agent keys write only their own dispatch log
  .post(
    "/workspaces/:ws/dispatches/:id/events",
    zValidator("json", sessionEventSchema),
    async (c) => {
      const ws = await requireWorkspace(c);
      const agent = c.get("agentAuth");
      const dispatch = await requireDispatch(c);
      if (!dispatch || dispatch.workspaceId !== ws.id) {
        throw new HttpError(404, "NOT_FOUND", "dispatch not found");
      }
      if (agent && agent.agentId !== dispatch.agentId) {
        throw new HttpError(
          403,
          "FORBIDDEN",
          "agent keys may only append to their own session",
        );
      }
      const rows = c.req.valid("json").events.map((e) => ({
        dispatchId: dispatch.id,
        workspaceId: ws.id,
        kind: e.kind,
        message: e.message,
      }));
      const inserted = await db.insert(dispatchEvents).values(rows).returning();

      // one feed entry per append — SSE subscribers refresh the session log;
      // the log itself carries the full detail
      const latest = c.req.valid("json").events.at(-1)!;
      const detail = {
        dispatchId: dispatch.id,
        count: rows.length,
        kind: latest.kind,
        message: latest.message,
      };
      const actorType = agent ? "agent" : "system";
      const actorId = agent?.agentId ?? null;
      await db.insert(events).values({
        workspaceId: ws.id,
        entityType: "issue",
        entityId: dispatch.issueId,
        action: "session_update",
        actorType,
        actorId,
        after: detail,
      });
      await queueDeliveries({
        workspaceId: ws.id,
        entityType: "issue",
        entityId: dispatch.issueId,
        action: "session_update",
        actorType,
        actorId,
        after: detail,
      });
      return c.json({ events: inserted }, 201);
    },
  )
  // read one dispatch's session log
  .get("/workspaces/:ws/dispatches/:id/events", async (c) => {
    const ws = await requireWorkspace(c);
    const agent = c.get("agentAuth");
    const dispatch = await requireDispatch(c);
    if (!dispatch || dispatch.workspaceId !== ws.id) {
      throw new HttpError(404, "NOT_FOUND", "dispatch not found");
    }
    if (agent && agent.agentId !== dispatch.agentId) {
      throw new HttpError(403, "FORBIDDEN", "agent keys see only their own sessions");
    }
    const rows = await db
      .select()
      .from(dispatchEvents)
      .where(eq(dispatchEvents.dispatchId, dispatch.id))
      .orderBy(asc(dispatchEvents.id));
    return c.json({ events: rows });
  })
  // issue timeline view — every dispatch on the issue + its session log
  .get("/workspaces/:ws/issues/:key/sessions", async (c) => {
    const ws = await requireWorkspace(c);
    const [issue] = await db
      .select({ id: issues.id, key: issues.key })
      .from(issues)
      .where(and(eq(issues.workspaceId, ws.id), eq(issues.key, c.req.param("key"))))
      .limit(1);
    if (!issue) throw new HttpError(404, "NOT_FOUND", "issue not found");

    const runs = await db
      .select({
        id: dispatches.id,
        status: dispatches.status,
        trigger: dispatches.trigger,
        createdAt: dispatches.createdAt,
        agentId: dispatches.agentId,
        agentName: agents.name,
        sessionId: agentSessions.id,
        sessionStatus: agentSessions.status,
        sessionPullRequests: agentSessions.pullRequests,
      })
      .from(dispatches)
      .innerJoin(agents, eq(dispatches.agentId, agents.id))
      // U25: the agent session (if the agent opened one) carries the PRs it reported
      .leftJoin(agentSessions, eq(agentSessions.dispatchId, dispatches.id))
      .where(eq(dispatches.issueId, issue.id))
      .orderBy(desc(dispatches.createdAt));
    const runIds = runs.map((r) => r.id);
    const logs =
      runIds.length === 0
        ? []
        : await db
            .select()
            .from(dispatchEvents)
            .where(inArray(dispatchEvents.dispatchId, runIds))
            .orderBy(asc(dispatchEvents.id));
    const byDispatch = new Map<string, typeof logs>();
    for (const e of logs) {
      const list = byDispatch.get(e.dispatchId) ?? [];
      list.push(e);
      byDispatch.set(e.dispatchId, list);
    }
    return c.json({
      sessions: runs.map(({ sessionId, sessionStatus, sessionPullRequests, ...r }) => ({
        ...r,
        session: sessionId
          ? { id: sessionId, status: sessionStatus, pullRequests: sessionPullRequests ?? [] }
          : null,
        events: byDispatch.get(r.id) ?? [],
      })),
    });
  });
