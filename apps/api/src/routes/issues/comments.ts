// Issue comments and the per-issue event feed.
import { zValidator } from "@hono/zod-validator";
import { and, asc, desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../../db/client.js";
import { agents, agentSessions, comments, events, users, workspaceMembers } from "../../db/schema.js";
import { actorFromHeaders } from "../../lib/actor.js";
import { postActivity } from "../../services/agent-sessions.js";
import { createDispatch } from "../../services/dispatch.js";
import { assertWithinLimit } from "../../services/entitlements.js";
import { mirrorIssueComment } from "../../services/github-sync.js";
import { notifyUsers } from "../../services/notifications.js";
import { queueDeliveries } from "../../services/outbound.js";
import { requireWorkspace } from "../workspaces.js";
import { track } from "../../services/background.js";
import { commentSchema, findIssue, slack, validateAgentActor } from "./shared.js";

export const commentRoutes = new Hono()
  .post(
    "/workspaces/:ws/issues/:key/comments",
    zValidator("json", commentSchema),
    async (c) => {
      const ws = await requireWorkspace(c);
      const issue = await findIssue(ws.id, c.req.param("key"));
      const actor = actorFromHeaders(c);
      await validateAgentActor(ws.id, actor);
      const body = c.req.valid("json");

      // a mention starts a run: refuse before the comment (or anything else)
      // is written, so a 402 leaves no half-applied state
      const mentioned = new Set(
        [...body.body.matchAll(/@([a-z0-9][a-z0-9_-]*)/gi)].map((m) =>
          m[1]!.toLowerCase(),
        ),
      );
      let mentionedAgents: (typeof agents.$inferSelect)[] = [];
      if (mentioned.size > 0) {
        const wsAgents = await db
          .select()
          .from(agents)
          .where(eq(agents.workspaceId, ws.id));
        mentionedAgents = wsAgents.filter((a) =>
          mentioned.has(a.name.toLowerCase()),
        );
        if (mentionedAgents.length > 0) {
          await assertWithinLimit("agent_runs", ws.id, mentionedAgents.length);
        }
      }

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
      track(
        mirrorIssueComment({
          issueId: issue.id,
          body: comment!.body,
          via: comment!.via,
        }),
      );

      // @mentions split two ways: an agent name creates a dispatch; a
      // member name creates a notification. The same token can hit both —
      // dispatch and inbox are independent effects.
      if (mentioned.size > 0) {
        for (const agent of mentionedAgents) {
          await createDispatch({
            workspaceId: ws.id,
            issueId: issue.id,
            agentId: agent.id,
            trigger: "mention",
            commentBody: body.body,
          });
        }
        const wsMembers = await db
          .select({ id: users.id, name: users.name })
          .from(workspaceMembers)
          .innerJoin(users, eq(users.id, workspaceMembers.userId))
          .where(eq(workspaceMembers.workspaceId, ws.id));
        const memberIds = wsMembers
          .filter((m) => {
            const name = m.name.toLowerCase();
            return (
              mentioned.has(name) ||
              mentioned.has(name.replace(/\s+/g, "-")) ||
              mentioned.has(name.replace(/\s+/g, "")) ||
              mentioned.has(name.split(/\s+/)[0] ?? "")
            );
          })
          .map((m) => m.id);
        if (memberIds.length > 0) {
          await notifyUsers(ws.id, memberIds, {
            kind: "mention",
            issueId: issue.id,
            actor,
          });
        }
      }

      // plan L3: when a human comments on an issue with an awaitingInput
      // agent session, resume the session with a prompt activity.
      if (actor.type === "human") {
        const waitingSessions = await db
          .select({ id: agentSessions.id })
          .from(agentSessions)
          .where(
            and(
              eq(agentSessions.workspaceId, ws.id),
              eq(agentSessions.issueId, issue.id),
              eq(agentSessions.status, "awaitingInput"),
            ),
          )
          .orderBy(desc(agentSessions.createdAt));
        for (const s of waitingSessions) {
          await postActivity(
            s.id,
            { content: { type: "prompt", body: comment!.body } },
            { actorType: "human", actorId: actor.id },
          );
        }
      }

      // slack mirror — best-effort, slack-originated bodies skip themselves
      slack.mirrorComment(issue.id, body.body).catch(() => {});

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
;
