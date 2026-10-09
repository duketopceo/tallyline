import { zValidator } from "@hono/zod-validator";
import {
  and,
  asc,
  desc,
  eq,
  ilike,
  inArray,
  lt,
  or,
  type SQL,
} from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import {
  ISSUE_SOURCES,
  ISSUE_STATES,
  PRIORITIES,
  type IssueState,
} from "@docketry/types";
import { db } from "../db/client.js";
import {
  agents,
  comments,
  cycles,
  dispatches,
  events,
  issueLabels,
  issues,
  labels,
  teams,
  users,
} from "../db/schema.js";
import { actorFromHeaders } from "../lib/actor.js";
import { apiError, HttpError } from "../lib/errors.js";
import { decodeCursor, encodeCursor } from "../lib/pagination.js";
import { createDispatch } from "../services/dispatch.js";
import {
  mirrorIssueComment,
  mirrorIssueLabels,
} from "../services/github-sync.js";
import { createIssue, transitionIssue, type Actor } from "../services/issues.js";
import { queueDeliveries } from "../services/outbound.js";
import { requireWorkspace } from "./workspaces.js";

const createSchema = z.object({
  teamKey: z.string().min(1).max(6).optional(),
  title: z.string().min(1).max(500),
  description: z.string().max(50_000).optional(),
  priority: z.enum(PRIORITIES).optional(),
  source: z.enum(ISSUE_SOURCES).optional(),
  state: z.enum(["triage", "backlog"]).default("backlog"),
  assigneeType: z.enum(["human", "agent"]).optional(),
  assigneeId: z.uuid().optional(),
  cycleId: z.uuid().optional(),
  projectId: z.uuid().optional(),
  parentId: z.uuid().optional(),
  labelIds: z.array(z.uuid()).max(10).optional(),
});

const patchSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  description: z.string().max(50_000).nullable().optional(),
  state: z.enum(ISSUE_STATES).optional(),
  priority: z.enum(PRIORITIES).optional(),
  estimate: z.number().int().nonnegative().nullable().optional(),
  dueDate: z.iso.datetime().nullable().optional(),
  assigneeType: z.enum(["human", "agent"]).nullable().optional(),
  assigneeId: z.uuid().nullable().optional(),
  cycleId: z.uuid().nullable().optional(),
  projectId: z.uuid().nullable().optional(),
  parentId: z.uuid().nullable().optional(),
});

const listQuerySchema = z.object({
  state: z
    .string()
    .transform((s) => s.split(","))
    .pipe(z.array(z.enum(ISSUE_STATES)))
    .optional(),
  priority: z
    .string()
    .transform((s) => s.split(","))
    .pipe(z.array(z.enum(PRIORITIES)))
    .optional(),
  team: z.string().optional(),
  assignee: z.uuid().optional(),
  cycle: z.uuid().optional(),
  label: z.uuid().optional(),
  source: z.enum(ISSUE_SOURCES).optional(),
  search: z.string().max(200).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const commentSchema = z.object({
  body: z.string().min(1).max(50_000),
});

// An `x-actor-id` header claiming an agent actor must name a real agent in
// this workspace — otherwise any session could forge agent provenance.
async function validateAgentActor(
  workspaceId: string,
  actor: Actor,
): Promise<void> {
  if (actor.type !== "agent" || !actor.id) return;
  const [a] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.id, actor.id), eq(agents.workspaceId, workspaceId)));
  if (!a) {
    throw new HttpError(422, "INVALID_ACTOR", "x-actor-id is not an agent in this workspace");
  }
}

async function validateAssignee(
  workspaceId: string,
  type: "human" | "agent",
  id: string,
): Promise<void> {
  if (type === "agent") {
    const [a] = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.id, id), eq(agents.workspaceId, workspaceId)));
    if (!a)
      throw new HttpError(422, "INVALID_ASSIGNEE", "agent not in workspace");
  } else {
    const [u] = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.id, id), eq(users.workspaceId, workspaceId)));
    if (!u)
      throw new HttpError(422, "INVALID_ASSIGNEE", "user not in workspace");
  }
}

// A cycle assignment is only meaningful inside the issue's own team —
// cross-team or foreign-workspace cycle ids are rejected, not silently kept.
async function validateCycle(
  workspaceId: string,
  teamId: string,
  cycleId: string,
): Promise<void> {
  const [cycle] = await db
    .select({ teamId: cycles.teamId })
    .from(cycles)
    .where(and(eq(cycles.id, cycleId), eq(cycles.workspaceId, workspaceId)));
  if (!cycle) {
    throw new HttpError(422, "INVALID_CYCLE", "cycle not in workspace");
  }
  if (cycle.teamId !== teamId) {
    throw new HttpError(
      422,
      "INVALID_CYCLE",
      "cycle belongs to a different team",
    );
  }
}

export const issueRoutes = new Hono()
  .post(
    "/workspaces/:ws/issues",
    zValidator("json", createSchema),
    async (c) => {
      const ws = await requireWorkspace(c);
      const body = c.req.valid("json");
      const actor = actorFromHeaders(c);
      await validateAgentActor(ws.id, actor);

      const [team] = body.teamKey
        ? await db
            .select()
            .from(teams)
            .where(
              and(eq(teams.workspaceId, ws.id), eq(teams.key, body.teamKey)),
            )
        : await db
            .select()
            .from(teams)
            .where(eq(teams.workspaceId, ws.id))
            .orderBy(teams.createdAt)
            .limit(1);
      if (!team) throw new HttpError(404, "NOT_FOUND", "team not found");
      if (body.cycleId) await validateCycle(ws.id, team.id, body.cycleId);

      const issue = await createIssue({
        workspaceId: ws.id,
        teamId: team.id,
        title: body.title,
        ...(body.description !== undefined
          ? { description: body.description }
          : {}),
        ...(body.source !== undefined ? { source: body.source } : {}),
        state: body.state,
        creator: actor,
      });

      if (body.assigneeId && body.assigneeType) {
        await validateAssignee(ws.id, body.assigneeType, body.assigneeId);
      }
      if (body.labelIds?.length) {
        await setIssueLabels(issue.id, ws.id, body.labelIds);
      }
      let result = issue;
      if (
        body.priority !== undefined ||
        body.assigneeId !== undefined ||
        body.cycleId !== undefined ||
        body.projectId !== undefined ||
        body.parentId !== undefined
      ) {
        const [updated] = await db
          .update(issues)
          .set({
            ...(body.priority !== undefined
              ? { priority: body.priority }
              : {}),
            ...(body.assigneeType !== undefined
              ? { assigneeType: body.assigneeType }
              : {}),
            ...(body.assigneeId !== undefined
              ? { assigneeId: body.assigneeId }
              : {}),
            ...(body.cycleId !== undefined ? { cycleId: body.cycleId } : {}),
            ...(body.projectId !== undefined
              ? { projectId: body.projectId }
              : {}),
            ...(body.parentId !== undefined
              ? { parentId: body.parentId }
              : {}),
          })
          .where(eq(issues.id, issue.id))
          .returning();
        if (updated) result = updated;
      }

      return c.json(result, 201);
    },
  )
  .get(
    "/workspaces/:ws/issues",
    zValidator("query", listQuerySchema),
    async (c) => {
      const ws = await requireWorkspace(c);
      const q = c.req.valid("query");

      const filters: SQL[] = [eq(issues.workspaceId, ws.id)];
      if (q.state?.length) filters.push(inArray(issues.state, q.state));
      if (q.priority?.length)
        filters.push(inArray(issues.priority, q.priority));
      if (q.assignee) filters.push(eq(issues.assigneeId, q.assignee));
      if (q.cycle) filters.push(eq(issues.cycleId, q.cycle));
      if (q.source) filters.push(eq(issues.source, q.source));
      if (q.search) filters.push(ilike(issues.title, `%${q.search}%`));
      if (q.team) {
        const [team] = await db
          .select({ id: teams.id })
          .from(teams)
          .where(
            and(eq(teams.workspaceId, ws.id), eq(teams.key, q.team)),
          );
        if (!team) return apiError(c, 404, "NOT_FOUND", "team not found");
        filters.push(eq(issues.teamId, team.id));
      }
      if (q.label) {
        filters.push(
          inArray(
            issues.id,
            db
              .select({ id: issueLabels.issueId })
              .from(issueLabels)
              .where(eq(issueLabels.labelId, q.label)),
          ),
        );
      }
      if (q.cursor) {
        const cur = decodeCursor(q.cursor);
        if (!cur) {
          return apiError(c, 400, "BAD_CURSOR", "invalid cursor");
        }
        filters.push(
          or(
            lt(issues.createdAt, new Date(cur.createdAt)),
            and(
              eq(issues.createdAt, new Date(cur.createdAt)),
              lt(issues.id, cur.id),
            ),
          )!,
        );
      }

      const rows = await db
        .select()
        .from(issues)
        .where(and(...filters))
        .orderBy(desc(issues.createdAt), desc(issues.id))
        .limit(q.limit + 1);

      const hasMore = rows.length > q.limit;
      const page = hasMore ? rows.slice(0, q.limit) : rows;
      const last = page.at(-1);
      return c.json({
        issues: page,
        nextCursor:
          hasMore && last
            ? encodeCursor({
                createdAt: last.createdAt.toISOString(),
                id: last.id,
              })
            : null,
      });
    },
  )
  .get("/workspaces/:ws/issues/:key", async (c) => {
    const ws = await requireWorkspace(c);
    const issue = await findIssue(ws.id, c.req.param("key"));
    const children = await db
      .select({ id: issues.id, key: issues.key, title: issues.title })
      .from(issues)
      .where(
        and(
          eq(issues.workspaceId, ws.id),
          eq(issues.parentId, issue.id),
        ),
      );
    const issueLabelRows = await db
      .select({ id: labels.id, name: labels.name, color: labels.color })
      .from(labels)
      .innerJoin(
        issueLabels,
        and(
          eq(issueLabels.labelId, labels.id),
          eq(issueLabels.issueId, issue.id),
        ),
      );
    return c.json({ ...issue, children, labels: issueLabelRows });
  })
  .patch(
    "/workspaces/:ws/issues/:key",
    zValidator("json", patchSchema),
    async (c) => {
      const ws = await requireWorkspace(c);
      const key = c.req.param("key");
      const body = c.req.valid("json");
      const actor = actorFromHeaders(c);

      // Validate mutations before committing any of them — a 422 must not
      // leave a half-applied patch (e.g. state moved, cycle rejected).
      if (body.assigneeId && body.assigneeType) {
        await validateAssignee(ws.id, body.assigneeType, body.assigneeId);
      }
      if (body.cycleId) {
        const issue = await findIssue(ws.id, key);
        await validateCycle(ws.id, issue.teamId, body.cycleId);
      }
      if (body.state !== undefined) {
        await transitionIssue(ws.id, key, body.state as IssueState, actor);
      }

      const fields: Partial<typeof issues.$inferInsert> = {};
      if (body.title !== undefined) fields.title = body.title;
      if (body.description !== undefined)
        fields.description = body.description;
      if (body.priority !== undefined) fields.priority = body.priority;
      if (body.estimate !== undefined) fields.estimate = body.estimate;
      if (body.dueDate !== undefined)
        fields.dueDate = body.dueDate ? new Date(body.dueDate) : null;
      if (body.assigneeType !== undefined)
        fields.assigneeType = body.assigneeType;
      if (body.assigneeId !== undefined) fields.assigneeId = body.assigneeId;
      if (body.cycleId !== undefined) fields.cycleId = body.cycleId;
      if (body.projectId !== undefined) fields.projectId = body.projectId;
      if (body.parentId !== undefined) fields.parentId = body.parentId;

      let issue;
      if (Object.keys(fields).length > 0) {
        fields.updatedAt = new Date();
        [issue] = await db
          .update(issues)
          .set(fields)
          .where(
            and(eq(issues.workspaceId, ws.id), eq(issues.key, key)),
          )
          .returning();
      } else {
        issue = await findIssue(ws.id, key);
      }
      if (body.assigneeType === "agent" && body.assigneeId && issue) {
        await createDispatch({
          workspaceId: ws.id,
          issueId: issue.id,
          agentId: body.assigneeId,
          trigger: "assign",
        });
      }
      return c.json(issue);
    },
  )
  .post(
    "/workspaces/:ws/issues/:key/comments",
    zValidator("json", commentSchema),
    async (c) => {
      const ws = await requireWorkspace(c);
      const issue = await findIssue(ws.id, c.req.param("key"));
      const actor = actorFromHeaders(c);
      await validateAgentActor(ws.id, actor);
      const body = c.req.valid("json");

      const [comment] = await db
        .insert(comments)
        .values({
          workspaceId: ws.id,
          issueId: issue.id,
          actorType: actor.type,
          actorId: actor.id,
          body: body.body,
        })
        .returning();

      await db.insert(events).values({
        workspaceId: ws.id,
        entityType: "issue",
        entityId: issue.id,
        action: "commented",
        actorType: actor.type,
        actorId: actor.id,
        after: { commentId: comment!.id },
      });
      await queueDeliveries({
        workspaceId: ws.id,
        entityType: "issue",
        entityId: issue.id,
        action: "commented",
        actorType: actor.type,
        actorId: actor.id,
        after: { commentId: comment!.id },
        issueKey: issue.key,
      });
      // best-effort GitHub mirror — never blocks; via=github comments
      // (inbound-synced) skip inside (#60)
      void mirrorIssueComment({
        issueId: issue.id,
        body: comment!.body,
        via: comment!.via,
      });

      // @agent mentions → dispatch intents (one per agent per comment)
      const mentioned = new Set(
        [...body.body.matchAll(/@([a-z0-9][a-z0-9_-]*)/gi)].map((m) =>
          m[1]!.toLowerCase(),
        ),
      );
      if (mentioned.size > 0) {
        const wsAgents = await db
          .select()
          .from(agents)
          .where(eq(agents.workspaceId, ws.id));
        for (const agent of wsAgents) {
          if (!mentioned.has(agent.name.toLowerCase())) continue;
          await createDispatch({
            workspaceId: ws.id,
            issueId: issue.id,
            agentId: agent.id,
            trigger: "mention",
            commentBody: body.body,
          });
        }
      }

      return c.json(comment, 201);
    },
  )
  .get("/workspaces/:ws/issues/:key/comments", async (c) => {
    const ws = await requireWorkspace(c);
    const issue = await findIssue(ws.id, c.req.param("key"));
    const rows = await db
      .select()
      .from(comments)
      .where(eq(comments.issueId, issue.id))
      .orderBy(asc(comments.createdAt));
    return c.json({ comments: rows });
  })
  .get("/workspaces/:ws/issues/:key/events", async (c) => {
    const ws = await requireWorkspace(c);
    const issue = await findIssue(ws.id, c.req.param("key"));
    const rows = await db
      .select()
      .from(events)
      .where(
        and(
          eq(events.workspaceId, ws.id),
          eq(events.entityId, issue.id),
        ),
      )
      .orderBy(asc(events.createdAt));
    return c.json({ events: rows });
  })
  .post(
    "/workspaces/:ws/issues/:key/triage",
    zValidator(
      "json",
      z.object({ action: z.enum(["accept", "decline"]) }),
    ),
    async (c) => {
      const ws = await requireWorkspace(c);
      const actor = actorFromHeaders(c);
      const { action } = c.req.valid("json");
      const issue = await findIssue(ws.id, c.req.param("key"));
      if (issue.state !== "triage") {
        throw new HttpError(
          409,
          "NOT_IN_TRIAGE",
          `issue ${issue.key} is in '${issue.state}', not triage`,
        );
      }
      const updated = await transitionIssue(
        ws.id,
        issue.key,
        action === "accept" ? "backlog" : "canceled",
        actor,
      );
      return c.json(updated);
    },
  )
  .post(
    "/workspaces/:ws/issues/:key/review",
    zValidator(
      "json",
      z.object({
        action: z.enum(["approve", "send_back"]),
        feedback: z.string().max(5_000).optional(),
      }),
    ),
    async (c) => {
      const ws = await requireWorkspace(c);
      const actor = actorFromHeaders(c);
      const { action, feedback } = c.req.valid("json");
      const issue = await findIssue(ws.id, c.req.param("key"));
      if (issue.state !== "in_review") {
        throw new HttpError(
          409,
          "NOT_IN_REVIEW",
          `issue ${issue.key} is in '${issue.state}', not in_review`,
        );
      }

      if (action === "approve") {
        const updated = await transitionIssue(ws.id, issue.key, "done", actor);
        await db.insert(comments).values({
          workspaceId: ws.id,
          issueId: issue.id,
          actorType: actor.type,
          actorId: actor.id,
          body: "review approved ✓",
        });
        return c.json(updated);
      }

      // send back: to in_progress, feedback on the thread, and re-dispatch
      // to the agent that ran the last session
      if (!feedback?.trim()) {
        throw new HttpError(422, "FEEDBACK_REQUIRED", "send_back requires feedback");
      }
      const [last] = await db
        .select({ agentId: dispatches.agentId })
        .from(dispatches)
        .where(eq(dispatches.issueId, issue.id))
        .orderBy(desc(dispatches.createdAt))
        .limit(1);
      const updated = await transitionIssue(
        ws.id,
        issue.key,
        "in_progress",
        actor,
      );
      await db.insert(comments).values({
        workspaceId: ws.id,
        issueId: issue.id,
        actorType: actor.type,
        actorId: actor.id,
        body: `sent back for changes: ${feedback}`,
      });
      if (last) {
        await createDispatch({
          workspaceId: ws.id,
          issueId: issue.id,
          agentId: last.agentId,
          trigger: "mention",
          commentBody: `review feedback: ${feedback}`,
        });
      }
      return c.json(updated);
    },
  )
  .post(
    "/workspaces/:ws/labels",
    zValidator(
      "json",
      z.object({
        name: z.string().min(1).max(60),
        color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
        teamKey: z.string().optional(),
      }),
    ),
    async (c) => {
      const ws = await requireWorkspace(c);
      const body = c.req.valid("json");
      const [label] = await db
        .insert(labels)
        .values({ workspaceId: ws.id, name: body.name, color: body.color })
        .returning();
      return c.json(label, 201);
    },
  )
  .get("/workspaces/:ws/labels", async (c) => {
    const ws = await requireWorkspace(c);
    const rows = await db
      .select()
      .from(labels)
      .where(eq(labels.workspaceId, ws.id));
    return c.json({ labels: rows });
  });

async function findIssue(workspaceId: string, key: string) {
  const [issue] = await db
    .select()
    .from(issues)
    .where(and(eq(issues.workspaceId, workspaceId), eq(issues.key, key)));
  if (!issue) throw new HttpError(404, "NOT_FOUND", `issue ${key} not found`);
  return issue;
}

async function setIssueLabels(
  issueId: string,
  workspaceId: string,
  labelIds: string[],
) {
  const valid = await db
    .select({ id: labels.id })
    .from(labels)
    .where(
      and(eq(labels.workspaceId, workspaceId), inArray(labels.id, labelIds)),
    );
  await db
    .insert(issueLabels)
    .values(valid.map((l) => ({ issueId, labelId: l.id })));
  // best-effort GitHub mirror — no-ops for unlinked issues (#60)
  if (valid.length > 0) void mirrorIssueLabels(issueId);
}
