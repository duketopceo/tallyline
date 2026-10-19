// Issue create, list, detail and patch — the core CRUD surface.
import { zValidator } from "@hono/zod-validator";
import { and, desc, eq, ilike, inArray, lt, or, type SQL } from "drizzle-orm";
import { Hono } from "hono";
import type { IssueState } from "@tallyline/types";
import { db } from "../../db/client.js";
import { issueLabels, issues, labels, projects, teams } from "../../db/schema.js";
import { actorFromHeaders } from "../../lib/actor.js";
import { apiError, HttpError } from "../../lib/errors.js";
import { llmEnabled } from "../../services/llm.js";
import { decodeCursor, encodeCursor } from "../../lib/pagination.js";
import { createDispatch } from "../../services/dispatch.js";
import { createIssue, transitionIssue } from "../../services/issues.js";
import { notifyUsers } from "../../services/notifications.js";
import { requireHumanReviewer, requireRole } from "../../services/members.js";
import { requireWorkspace } from "../workspaces.js";
import { clock } from "../../services/clock.js";
import { assist, BULK_MAX, bulkSchema, createSchema, findIssue, listQuerySchema, patchSchema, replaceIssueLabels, setIssueLabels, slack, validateAgentActor, validateAssignee, validateCycle, validateMilestone, validateParent, validateProject } from "./shared.js";

export const coreIssueRoutes = new Hono()
  .post(
    "/workspaces/:ws/issues/bulk",
    zValidator("json", bulkSchema),
    async (c) => {
      const ws = await requireWorkspace(c);
      requireRole(c, "admin");
      const body = c.req.valid("json");
      const ids = [...new Set(body.ids)];
      if (ids.length > BULK_MAX) {
        throw new HttpError(422, "TOO_MANY", `at most ${BULK_MAX} issues per call`);
      }
      // every id must be in this workspace, or nothing changes
      const rows = await db
        .select({ id: issues.id, teamId: issues.teamId })
        .from(issues)
        .where(and(eq(issues.workspaceId, ws.id), inArray(issues.id, ids)));
      if (rows.length !== ids.length) {
        throw new HttpError(404, "NOT_FOUND", "issue not found");
      }
      if (body.projectId) {
        const [p] = await db
          .select({ teamId: projects.teamId })
          .from(projects)
          .where(and(eq(projects.id, body.projectId), eq(projects.workspaceId, ws.id)));
        if (!p) throw new HttpError(422, "INVALID_PROJECT", "project not in workspace");
        if (p.teamId !== null && rows.some((r) => r.teamId !== p.teamId)) {
          throw new HttpError(422, "INVALID_PROJECT", "project belongs to a different team");
        }
      }
      const labelIds = [...new Set(body.addLabelIds ?? [])];
      if (labelIds.length) {
        const found = await db
          .select({ id: labels.id })
          .from(labels)
          .where(and(eq(labels.workspaceId, ws.id), inArray(labels.id, labelIds)));
        if (found.length !== labelIds.length) {
          throw new HttpError(422, "INVALID_LABELS", "label id not in workspace");
        }
      }
      await db.transaction(async (tx) => {
        if (body.projectId !== undefined) {
          await tx
            .update(issues)
            .set({ projectId: body.projectId, updatedAt: clock.now() })
            .where(and(eq(issues.workspaceId, ws.id), inArray(issues.id, ids)));
        }
        if (labelIds.length) {
          await tx
            .insert(issueLabels)
            .values(ids.flatMap((issueId) => labelIds.map((labelId) => ({ issueId, labelId }))))
            .onConflictDoNothing();
        }
      });
      return c.json({ updated: ids.length });
    },
  )
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
      if (body.projectId)
        await validateProject(ws.id, team.id, body.projectId);
      if (body.milestoneId)
        await validateMilestone(ws.id, body.projectId ?? null, body.milestoneId);
      if (body.parentId) await validateParent(ws.id, body.parentId);
      // validate before creating: a 422 must not leave an orphan issue behind
      if (body.assigneeId && body.assigneeType) {
        await validateAssignee(ws.id, body.assigneeType, body.assigneeId);
      }

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

      if (body.labelIds?.length) {
        await setIssueLabels(issue.id, ws.id, body.labelIds);
      }
      let result = issue;
      if (
        body.priority !== undefined ||
        body.assigneeId !== undefined ||
        body.cycleId !== undefined ||
        body.projectId !== undefined ||
        body.milestoneId !== undefined ||
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
            ...(body.milestoneId !== undefined
              ? { milestoneId: body.milestoneId }
              : {}),
            ...(body.parentId !== undefined
              ? { parentId: body.parentId }
              : {}),
          })
          .where(eq(issues.id, issue.id))
          .returning();
        if (updated) result = updated;
      }

      // create-time human assignment → inbox row (agent assignment at
      // create does NOT dispatch — dispatch is PATCH/mention only)
      if (body.assigneeType === "human" && body.assigneeId) {
        await notifyUsers(ws.id, [body.assigneeId], {
          kind: "assigned",
          issueId: result.id,
          actor,
        });
      }

      // `?dupCheck=1` runs semantic duplicate detection on the way out —
      // opt-in per request, LLM-disabled workspaces just get the issue back
      if (c.req.query("dupCheck") && llmEnabled()) {
        try {
          const possibleDuplicates = await assist.checkDuplicates(
            ws.id,
            body.title,
            body.description,
          );
          return c.json({ ...result, possibleDuplicates }, 201);
        } catch {
          // dup detection is advisory — never fail the create over it
        }
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
      if (q.project) filters.push(eq(issues.projectId, q.project));
      if (q.milestone) filters.push(eq(issues.milestoneId, q.milestone));
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
      // one batched label read per page — rows render chips without N+1
      const pageIds = page.map((i) => i.id);
      const labelRows = pageIds.length
        ? await db
            .select({
              issueId: issueLabels.issueId,
              id: labels.id,
              name: labels.name,
              color: labels.color,
            })
            .from(issueLabels)
            .innerJoin(labels, eq(labels.id, issueLabels.labelId))
            .where(inArray(issueLabels.issueId, pageIds))
        : [];
      const labelsByIssue = new Map<
        string,
        { id: string; name: string; color: string }[]
      >();
      for (const l of labelRows) {
        const arr = labelsByIssue.get(l.issueId) ?? [];
        arr.push({ id: l.id, name: l.name, color: l.color });
        labelsByIssue.set(l.issueId, arr);
      }
      return c.json({
        issues: page.map((i) => ({
          ...i,
          labels: labelsByIssue.get(i.id) ?? [],
        })),
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
      if (body.parentId) await validateParent(ws.id, body.parentId, key);
      if (body.labelIds?.length) {
        const found = await db
          .select({ id: labels.id })
          .from(labels)
          .where(
            and(
              eq(labels.workspaceId, ws.id),
              inArray(labels.id, body.labelIds),
            ),
          );
        if (found.length !== new Set(body.labelIds).size) {
          throw new HttpError(
            422,
            "INVALID_LABELS",
            "label id not in workspace",
          );
        }
      }
      // an explicit milestone change; a project move without one drops a
      // milestone that no longer matches the project (below)
      let clearMilestone = false;
      if (body.cycleId || body.projectId !== undefined || body.milestoneId) {
        const issue = await findIssue(ws.id, key);
        if (body.cycleId)
          await validateCycle(ws.id, issue.teamId, body.cycleId);
        if (body.projectId)
          await validateProject(ws.id, issue.teamId, body.projectId);
        const project =
          body.projectId !== undefined ? body.projectId : issue.projectId;
        if (body.milestoneId) {
          await validateMilestone(ws.id, project, body.milestoneId);
        } else if (
          body.milestoneId === undefined &&
          body.projectId !== undefined &&
          body.projectId !== issue.projectId
        ) {
          clearMilestone = true;
        }
      }
      if (body.state !== undefined) {
        // approving (-> done) or sending back (-> in_progress) a review item
        // is a human decision; agents may only move work INTO in_review
        if (c.get("agentAuth")) {
          const current = await findIssue(ws.id, key);
          if (
            current.state === "in_review" &&
            (body.state === "done" || body.state === "in_progress")
          ) {
            requireHumanReviewer(c);
          }
        }
        await transitionIssue(ws.id, key, body.state as IssueState, actor);
        // terminal transition → resolution reply in the linked slack thread
        if (["done", "canceled", "duplicate"].includes(body.state)) {
          const updated = await findIssue(ws.id, key);
          slack.notifyResolution(updated.id, body.state, actor).catch(() => {});
        }
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
      if (body.milestoneId !== undefined) fields.milestoneId = body.milestoneId;
      else if (clearMilestone) fields.milestoneId = null;
      if (body.parentId !== undefined) fields.parentId = body.parentId;

      // prior assignee for the change-detection below — one extra read only
      // when the patch touches assignment
      const prevAssignee =
        body.assigneeId !== undefined || body.assigneeType !== undefined
          ? await db
              .select({
                assigneeType: issues.assigneeType,
                assigneeId: issues.assigneeId,
              })
              .from(issues)
              .where(
                and(
                  eq(issues.workspaceId, ws.id),
                  eq(issues.key, key),
                ),
              )
              .then((r) => r[0] ?? null)
          : null;

      let issue;
      if (Object.keys(fields).length > 0) {
        fields.updatedAt = clock.now();
        [issue] = await db
          .update(issues)
          .set(fields)
          .where(
            and(eq(issues.workspaceId, ws.id), eq(issues.key, key)),
          )
          .returning();
        // no row matched: unknown key (or another tenant's) is a 404, never a
        // 200 with an empty body
        if (!issue) issue = await findIssue(ws.id, key);
      } else {
        issue = await findIssue(ws.id, key);
      }
      if (body.labelIds !== undefined && issue) {
        await replaceIssueLabels(issue.id, ws.id, body.labelIds);
      }
      if (body.assigneeType === "agent" && body.assigneeId && issue) {
        await createDispatch({
          workspaceId: ws.id,
          issueId: issue.id,
          agentId: body.assigneeId,
          trigger: "assign",
        });
      }
      // human assignment change → inbox row (re-assigning the same person
      // doesn't re-notify)
      if (
        body.assigneeType === "human" &&
        body.assigneeId &&
        issue &&
        prevAssignee?.assigneeId !== body.assigneeId
      ) {
        await notifyUsers(ws.id, [body.assigneeId], {
          kind: "assigned",
          issueId: issue.id,
          actor,
        });
      }
      return c.json(issue);
    },
  )
;
