import { zValidator } from "@hono/zod-validator";
import type { Context } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import { apiError, HttpError } from "../lib/errors.js";
import { issueReporterHandle, reportUrl } from "../services/reporters.js";
import { listSupportIssues, SUPPORT_KINDS } from "../services/support.js";
import { requireRole } from "../services/members.js";
import { isCookieSession } from "./auth.js";
import { findIssue } from "./issues/shared.js";
import { requireWorkspace } from "./workspaces.js";

// Helpdesk (plan 2026-11-03 U6). Session-guarded reads over intake-origin
// issues, plus the one write staff need: minting a fresh reporter link to
// paste into a reply. Nothing here can post a report or read another
// workspace — every query is scoped by requireWorkspace.

const listQuerySchema = z.object({
  kind: z.enum(SUPPORT_KINDS).optional(),
  project: z.uuid().optional(),
});

// A reporter link is a capability URL for an outside person. Minting one is
// the same kind of decision as issuing an intake key: a human member, not an
// agent credential acting on its own.
function requireHelpdeskUser(c: Context): void {
  if (c.get("agentAuth")) {
    throw new HttpError(
      403,
      "FORBIDDEN_AGENT",
      "agent credentials cannot mint reporter links",
    );
  }
  if (!isCookieSession(c)) {
    throw new HttpError(
      403,
      "FORBIDDEN",
      "reporter links require a human session",
    );
  }
}

export const supportRoutes = new Hono()
  .get(
    "/workspaces/:ws/support",
    zValidator("query", listQuerySchema),
    async (c) => {
      const ws = await requireWorkspace(c);
      const q = c.req.valid("query");
      const list = await listSupportIssues(ws.id, {
        ...(q.kind ? { kind: q.kind } : {}),
        ...(q.project ? { projectId: q.project } : {}),
      });
      return c.json(list);
    },
  )
  // Shareable reporter handle for one report. Only intake issues have a
  // reporter to share it with; anything else is a 404, not a new handle.
  .post("/workspaces/:ws/support/:key/handle", async (c) => {
    const ws = await requireWorkspace(c);
    requireRole(c, "member");
    requireHelpdeskUser(c);
    const issue = await findIssue(ws.id, c.req.param("key"));
    if (issue.source !== "intake") {
      return apiError(c, 404, "NOT_FOUND", "report not found");
    }
    // a fresh handle: the link the reporter first received was shown once at
    // report time, and only its hash is stored, so staff get their own
    const { token, expiresAt } = await issueReporterHandle({
      workspaceId: ws.id,
      issueId: issue.id,
    });
    return c.json({ url: reportUrl(token), expiresAt: expiresAt.toISOString() });
  });
