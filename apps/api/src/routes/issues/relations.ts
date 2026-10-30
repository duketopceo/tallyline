// Issue relations (plan L5) — typed edges between issues (blocks, relates,
// duplicates) with cycle guards on blocking relationships.
import { zValidator } from "@hono/zod-validator";
import { and, asc, eq, or } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { db } from "../../db/client.js";
import {
  events,
  issueRelations,
  issueRelationTypes,
  issues,
} from "../../db/schema.js";
import { actorFromHeaders } from "../../lib/actor.js";
import { HttpError } from "../../lib/errors.js";
import { requireWorkspace } from "../workspaces.js";
import { findIssue } from "./shared.js";

export const relationRoutes = new Hono()
  // ── Plan L5: Issue relations ───────────────────────────────────
  .get("/workspaces/:ws/issues/:key/relations", async (c) => {
    const ws = await requireWorkspace(c);
    const issue = await findIssue(ws.id, c.req.param("key"));
    const rows = await db
      .select()
      .from(issueRelations)
      .where(
        and(
          eq(issueRelations.workspaceId, ws.id),
          or(
            eq(issueRelations.sourceIssueId, issue.id),
            eq(issueRelations.targetIssueId, issue.id),
          ),
        ),
      )
      .orderBy(asc(issueRelations.createdAt));
    return c.json({ relations: rows });
  })
  .post(
    "/workspaces/:ws/issues/:key/relations",
    zValidator(
      "json",
      z
        .object({
          targetIssueId: z.uuid().optional(),
          targetIssueKey: z.string().min(1).max(32).optional(),
          targetKey: z.string().min(1).max(32).optional(),
          relationType: z.enum(issueRelationTypes),
        })
        .refine(
          (v) => Boolean(v.targetIssueId || v.targetIssueKey || v.targetKey),
          { message: "targetIssueId or targetIssueKey is required" },
        ),
    ),
    async (c) => {
      const ws = await requireWorkspace(c);
      const actor = actorFromHeaders(c);
      const issue = await findIssue(ws.id, c.req.param("key"));
      const body = c.req.valid("json");

      if (body.targetIssueId && body.targetIssueId === issue.id) {
        throw new HttpError(
          409,
          "SELF_RELATION",
          "an issue cannot relate to itself",
        );
      }
      const targetKey = body.targetIssueKey ?? body.targetKey;
      if (targetKey && targetKey === issue.key) {
        throw new HttpError(
          409,
          "SELF_RELATION",
          "an issue cannot relate to itself",
        );
      }

      let target: typeof issues.$inferSelect | undefined;
      if (body.targetIssueId) {
        const [found] = await db
          .select()
          .from(issues)
          .where(
            and(
              eq(issues.id, body.targetIssueId),
              eq(issues.workspaceId, ws.id),
            ),
          );
        if (!found) {
          // same answer as an unknown key: another workspace's issue ids
          // must not be distinguishable from ids that don't exist
          throw new HttpError(404, "NOT_FOUND", "target issue not found");
        }
        target = found;
      } else if (targetKey) {
        target = await findIssue(ws.id, targetKey);
      }

      if (!target || target.id === issue.id) {
        throw new HttpError(
          409,
          "SELF_RELATION",
          "an issue cannot relate to itself",
        );
      }

      if (body.relationType === "blocks") {
        const blockEdges = await db
          .select({
            sourceIssueId: issueRelations.sourceIssueId,
            targetIssueId: issueRelations.targetIssueId,
          })
          .from(issueRelations)
          .where(
            and(
              eq(issueRelations.workspaceId, ws.id),
              eq(issueRelations.relationType, "blocks"),
            ),
          );
        const adj = new Map<string, string[]>();
        for (const e of blockEdges) {
          const list = adj.get(e.sourceIssueId) ?? [];
          list.push(e.targetIssueId);
          adj.set(e.sourceIssueId, list);
        }
        const visited = new Set<string>([target.id]);
        const queue: string[] = [target.id];
        while (queue.length > 0) {
          const cur = queue.shift()!;
          if (cur === issue.id) {
            throw new HttpError(
              409,
              "BLOCKS_CYCLE",
              "blocks relation would create a cycle",
            );
          }
          for (const nxt of adj.get(cur) ?? []) {
            if (!visited.has(nxt)) {
              visited.add(nxt);
              queue.push(nxt);
            }
          }
        }
      }

      await db
        .insert(issueRelations)
        .values({
          workspaceId: ws.id,
          sourceIssueId: issue.id,
          targetIssueId: target.id,
          relationType: body.relationType,
        })
        .onConflictDoNothing();

      const [row] = await db
        .select()
        .from(issueRelations)
        .where(
          and(
            eq(issueRelations.workspaceId, ws.id),
            eq(issueRelations.sourceIssueId, issue.id),
            eq(issueRelations.targetIssueId, target.id),
            eq(issueRelations.relationType, body.relationType),
          ),
        );

      if (body.relationType === "duplicate" && issue.state !== "duplicate") {
        await db
          .update(issues)
          .set({ state: "duplicate" })
          .where(and(eq(issues.id, issue.id), eq(issues.workspaceId, ws.id)));
        await db.insert(events).values({
          workspaceId: ws.id,
          entityType: "issue",
          entityId: issue.id,
          action: "state_changed",
          actorType: actor.type,
          actorId: actor.id,
          before: { state: issue.state },
          after: { state: "duplicate", duplicateOf: target.key },
        });
      }

      await db.insert(events).values({
        workspaceId: ws.id,
        entityType: "issue",
        entityId: issue.id,
        action: "relation_created",
        actorType: actor.type,
        actorId: actor.id,
        after: {
          relationId: row!.id,
          targetIssueId: target.id,
          relationType: body.relationType,
        },
      });

      return c.json({ ...row!, relation: row! }, 201);
    },
  )
  .delete("/workspaces/:ws/issues/:key/relations/:rid", async (c) => {
    const ws = await requireWorkspace(c);
    const actor = actorFromHeaders(c);
    const issue = await findIssue(ws.id, c.req.param("key"));
    const rid = c.req.param("rid");
    const [deleted] = await db
      .delete(issueRelations)
      .where(
        and(
          eq(issueRelations.id, rid),
          eq(issueRelations.workspaceId, ws.id),
          or(
            eq(issueRelations.sourceIssueId, issue.id),
            eq(issueRelations.targetIssueId, issue.id),
          ),
        ),
      )
      .returning({ id: issueRelations.id });
    if (!deleted) {
      throw new HttpError(404, "NOT_FOUND", "relation not found");
    }
    await db.insert(events).values({
      workspaceId: ws.id,
      entityType: "issue",
      entityId: issue.id,
      action: "relation_deleted",
      actorType: actor.type,
      actorId: actor.id,
      after: { relationId: deleted.id },
    });
    return c.json({ ok: true });
  });
