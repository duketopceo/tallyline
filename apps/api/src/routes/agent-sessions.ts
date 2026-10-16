import { zValidator } from "@hono/zod-validator";
import { and, desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { agentActivityInputSchema } from "@tallyline/types";
import { db } from "../db/client.js";
import { agentSessions, issues } from "../db/schema.js";
import { HttpError } from "../lib/errors.js";
import {
  getSession,
  listActivities,
  postActivity,
  SessionTransitionError,
  setSessionPlan,
} from "../services/agent-sessions.js";
import { requireWorkspace } from "./workspaces.js";

// ── Agent session routes (plan L1) ───────────────────────────────
// Agent keys see and write only their own sessions. Human sessions can
// read any session in the workspace and post `prompt` activities (the
// elicitation reply path, L3 extends it with comment linkage).

const planPatchSchema = z
  .object({
    plan: z.record(z.string(), z.unknown()).optional(),
    pullRequests: z.array(z.url()).max(50).optional(),
  })
  .refine((v) => v.plan !== undefined || v.pullRequests !== undefined, {
    message: "patch body must set plan or pullRequests",
  });

async function requireSession(
  c: {
    req: { param: (k: string) => string };
    get: (k: "agentAuth") => { agentId: string } | null;
  },
  wsId: string,
) {
  const session = await getSession(c.req.param("id"));
  if (!session || session.workspaceId !== wsId) {
    throw new HttpError(404, "NOT_FOUND", "session not found");
  }
  const agent = c.get("agentAuth");
  if (agent && agent.agentId !== session.agentId) {
    throw new HttpError(403, "FORBIDDEN", "agent keys see only their own sessions");
  }
  return session;
}

export const agentSessionRoutes = new Hono()
  // list sessions on an issue, newest first
  .get("/workspaces/:ws/issues/:key/agent-sessions", async (c) => {
    const ws = await requireWorkspace(c);
    const agent = c.get("agentAuth");
    const [issue] = await db
      .select({ id: issues.id })
      .from(issues)
      .where(and(eq(issues.workspaceId, ws.id), eq(issues.key, c.req.param("key"))))
      .limit(1);
    if (!issue) throw new HttpError(404, "NOT_FOUND", "issue not found");
    const where = agent
      ? and(eq(agentSessions.issueId, issue.id), eq(agentSessions.agentId, agent.agentId))
      : eq(agentSessions.issueId, issue.id);
    const rows = await db
      .select()
      .from(agentSessions)
      .where(where)
      .orderBy(desc(agentSessions.createdAt));
    return c.json({ sessions: rows });
  })
  // one session with its activity log
  .get("/workspaces/:ws/agent-sessions/:id", async (c) => {
    const ws = await requireWorkspace(c);
    const session = await requireSession(c, ws.id);
    const activities = await listActivities(session.id);
    return c.json({ session, activities });
  })
  // append a typed activity; the transition table decides the status
  .post(
    "/workspaces/:ws/agent-sessions/:id/activities",
    zValidator("json", agentActivityInputSchema),
    async (c) => {
      const ws = await requireWorkspace(c);
      const session = await requireSession(c, ws.id);
      const agent = c.get("agentAuth");
      const humanSession = c.get("session");
      const body = c.req.valid("json");
      // humans and system may only speak to the agent through `prompt`
      // or a stop signal; everything else is the agent's voice
      if (!agent && body.content.type !== "prompt" && body.signal !== "stop") {
        throw new HttpError(
          403,
          "FORBIDDEN",
          "only agent keys may post non-prompt activities",
        );
      }
      const actor = agent
        ? { actorType: "agent" as const, actorId: agent.agentId }
        : humanSession
          ? { actorType: "human" as const, actorId: humanSession.userId }
          : { actorType: "system" as const, actorId: null };
      try {
        const result = await postActivity(session.id, body, actor);
        if (!result) throw new HttpError(404, "NOT_FOUND", "session not found");
        return c.json(result, 201);
      } catch (err) {
        if (err instanceof SessionTransitionError) {
          throw new HttpError(409, "INVALID_TRANSITION", err.message);
        }
        throw err;
      }
    },
  )
  // plan and pull-request links (L8 widens this)
  .patch(
    "/workspaces/:ws/agent-sessions/:id",
    zValidator("json", planPatchSchema),
    async (c) => {
      const ws = await requireWorkspace(c);
      const session = await requireSession(c, ws.id);
      const body = c.req.valid("json");
      const row = await setSessionPlan(session.id, {
        ...(body.plan !== undefined ? { plan: body.plan } : {}),
        ...(body.pullRequests !== undefined
          ? { pullRequests: body.pullRequests }
          : {}),
      });
      return c.json({ session: row });
    },
  );
