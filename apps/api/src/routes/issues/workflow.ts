// Triage and review decision endpoints — model proposes, humans decide.
import { zValidator } from "@hono/zod-validator";
import { desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { db } from "../../db/client.js";
import { comments, dispatches } from "../../db/schema.js";
import { actorFromHeaders } from "../../lib/actor.js";
import { HttpError } from "../../lib/errors.js";
import { createDispatch } from "../../services/dispatch.js";
import { transitionIssue } from "../../services/issues.js";
import { requireHumanReviewer } from "../../services/members.js";
import { requireWorkspace } from "../workspaces.js";
import { findIssue } from "./shared.js";

export const workflowRoutes = new Hono()
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
      requireHumanReviewer(c);
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

      // send back: to in_progress, feedback on the thread re-dispatch
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
;
