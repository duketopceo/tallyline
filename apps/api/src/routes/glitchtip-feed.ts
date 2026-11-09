// GlitchTip pull side: connection (admin), per-project mapping (admin), and the
// cached error feed (any member or agent key that can read the project).
// The token is accepted on PUT only and never returned.
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { actorFromHeaders } from "../lib/actor.js";
import { HttpError } from "../lib/errors.js";
import { createKeyedLimiter } from "../lib/rate-limit.js";
import {
  connectionView,
  createTicketFromError,
  getConnection,
  getIssueDetail,
  getLink,
  listIssues,
  projectErrorHealth,
  removeConnection,
  removeLink,
  saveConnection,
  saveLink,
  syncLink,
  workspaceErrorHealth,
} from "../services/glitchtip-sync.js";
import { requireRole } from "../services/members.js";
import { findProject } from "./project-updates.js";
import { requireWorkspace } from "./workspaces.js";

const connectionSchema = z.object({
  baseUrl: z.string().trim().min(1).max(500),
  /** omit to keep the saved token */
  token: z.string().trim().min(1).max(500).optional(),
});

const linkSchema = z.object({
  orgSlug: z.string().trim().min(1).max(100),
  projectSlug: z.string().trim().min(1).max(100),
});

const listQuery = z.object({
  status: z.enum(["unresolved", "resolved", "all"]).default("unresolved"),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

// a manual sync is one outbound call per click: keep a stuck script off GlitchTip
export const glitchtipSyncLimiter = createKeyedLimiter(6, 60_000, { prefix: "glitchtip-sync" });

export const glitchtipFeedRoutes = new Hono()
  .get("/workspaces/:ws/glitchtip/connection", async (c) => {
    const ws = await requireWorkspace(c);
    requireRole(c, "admin");
    const row = await getConnection(ws.id);
    return c.json({ connection: row ? connectionView(row) : null });
  })
  .put("/workspaces/:ws/glitchtip/connection", zValidator("json", connectionSchema), async (c) => {
    const ws = await requireWorkspace(c);
    requireRole(c, "admin");
    const row = await saveConnection(ws.id, actorFromHeaders(c), c.req.valid("json"));
    return c.json({ connection: connectionView(row) });
  })
  .delete("/workspaces/:ws/glitchtip/connection", async (c) => {
    const ws = await requireWorkspace(c);
    requireRole(c, "admin");
    if (!(await removeConnection(ws.id, actorFromHeaders(c)))) {
      throw new HttpError(404, "NOT_FOUND", "GlitchTip is not connected");
    }
    return c.json({ ok: true });
  })
  .get("/workspaces/:ws/glitchtip/health", async (c) => {
    const ws = await requireWorkspace(c);
    return c.json({ projects: await workspaceErrorHealth(ws.id) });
  })
  .get("/workspaces/:ws/projects/:id/glitchtip", async (c) => {
    const ws = await requireWorkspace(c);
    const project = await findProject(ws.id, c.req.param("id"));
    return c.json({ errors: await projectErrorHealth(ws.id, project.id) });
  })
  .put("/workspaces/:ws/projects/:id/glitchtip", zValidator("json", linkSchema), async (c) => {
    const ws = await requireWorkspace(c);
    requireRole(c, "admin");
    const project = await findProject(ws.id, c.req.param("id"));
    await saveLink(ws.id, actorFromHeaders(c), project.id, c.req.valid("json"));
    return c.json({ errors: await projectErrorHealth(ws.id, project.id) });
  })
  .delete("/workspaces/:ws/projects/:id/glitchtip", async (c) => {
    const ws = await requireWorkspace(c);
    requireRole(c, "admin");
    const project = await findProject(ws.id, c.req.param("id"));
    if (!(await removeLink(ws.id, actorFromHeaders(c), project.id))) {
      throw new HttpError(404, "NOT_FOUND", "this project is not mapped to a GlitchTip project");
    }
    return c.json({ ok: true });
  })
  .post("/workspaces/:ws/projects/:id/glitchtip/sync", async (c) => {
    const ws = await requireWorkspace(c);
    const project = await findProject(ws.id, c.req.param("id"));
    const link = await getLink(ws.id, project.id);
    if (!link) throw new HttpError(404, "NOT_FOUND", "this project is not mapped to a GlitchTip project");
    const limited = await glitchtipSyncLimiter.hit(c, ws.id);
    if (limited) return limited;
    const result = await syncLink(link.id);
    // a GlitchTip failure is an answer, not a server error: `sync` carries it
    return c.json({ sync: result, errors: await projectErrorHealth(ws.id, project.id) });
  })
  .get("/workspaces/:ws/projects/:id/glitchtip/issues", zValidator("query", listQuery), async (c) => {
    const ws = await requireWorkspace(c);
    const project = await findProject(ws.id, c.req.param("id"));
    const q = c.req.valid("query");
    return c.json({ issues: await listIssues(ws.id, project.id, q) });
  })
  .get("/workspaces/:ws/projects/:id/glitchtip/issues/:issueId", async (c) => {
    const ws = await requireWorkspace(c);
    const project = await findProject(ws.id, c.req.param("id"));
    return c.json({ issue: await getIssueDetail(ws.id, project.id, c.req.param("issueId")) });
  })
  .post("/workspaces/:ws/projects/:id/glitchtip/issues/:issueId/ticket", async (c) => {
    const ws = await requireWorkspace(c);
    const project = await findProject(ws.id, c.req.param("id"));
    const r = await createTicketFromError(ws.id, project.id, c.req.param("issueId"), actorFromHeaders(c));
    return c.json({ ticket: r.issue }, r.created ? 201 : 200);
  });
