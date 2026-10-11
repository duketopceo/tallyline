import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { apiError } from "../lib/errors.js";
import { hasRole, requireRole } from "../services/members.js";
import {
  OAuthError,
  consentView,
  decideConsent,
  grantInWorkspace,
  listGrants,
  revokeGrantById,
} from "../services/mcp-oauth.js";
import { isCookieSession, requireVerifiedEmail } from "./auth.js";
import { requireWorkspace } from "./workspaces.js";

const decisionSchema = z.object({
  approve: z.boolean(),
  workspace: z.string().min(1).max(64).optional(),
  scopes: z.array(z.enum(["read", "write"])).max(2).optional(),
  csrf: z.string().min(1).max(256),
});

// Consent + grant management. Cookie sessions only: delegated credentials
// (PATs, OAuth tokens, agent keys) can neither approve connectors nor list
// or revoke them.
export const mcpOAuthAdminRoutes = new Hono()
  .get("/oauth/consent/:id", async (c) => {
    const session = c.get("session");
    if (!isCookieSession(c) || !session) {
      return apiError(c, 403, "FORBIDDEN", "consent requires a human session");
    }
    try {
      c.header("cache-control", "no-store");
      return c.json(await consentView(c.req.param("id"), session.userId));
    } catch (err) {
      if (err instanceof OAuthError) return apiError(c, err.status === 404 ? 404 : 400, "OAUTH_REQUEST", err.description);
      throw err;
    }
  })
  .post(
    "/oauth/consent/:id",
    zValidator("json", decisionSchema),
    async (c) => {
      const session = c.get("session");
      if (!isCookieSession(c) || !session) {
        return apiError(c, 403, "FORBIDDEN", "consent requires a human session");
      }
      const body = c.req.valid("json");
      // approving mints a long-lived credential (grant + connector agent), the
      // same as a PAT or agent key, so the verified-email gate applies here too.
      // Checked before the request is claimed or any row is written; denying
      // stays open so an unverified user can still decline a connector.
      if (body.approve) await requireVerifiedEmail(c);
      try {
        const redirectTo = await decideConsent(
          c.req.param("id"),
          { id: session.userId, name: session.name },
          {
            approve: body.approve,
            ...(body.workspace ? { workspaceSlug: body.workspace } : {}),
            ...(body.scopes ? { scopes: body.scopes } : {}),
            csrf: body.csrf,
          },
        );
        c.header("cache-control", "no-store");
        return c.json({ redirectTo });
      } catch (err) {
        if (err instanceof OAuthError) {
          return apiError(c, err.status === 404 ? 404 : err.status === 403 ? 403 : err.status === 410 ? 410 : 400, "OAUTH_REQUEST", err.description);
        }
        throw err;
      }
    },
  )
  .get("/workspaces/:ws/oauth/grants", async (c) => {
    const session = c.get("session");
    if (!isCookieSession(c) || !session) {
      return apiError(c, 403, "FORBIDDEN", "requires a human session");
    }
    const ws = await requireWorkspace(c);
    const admin = hasRole(c.get("memberRole"), "admin");
    const grants = await listGrants(ws.id, admin ? null : session.userId);
    return c.json({ grants });
  })
  .delete("/workspaces/:ws/oauth/grants/:id", async (c) => {
    const session = c.get("session");
    if (!isCookieSession(c) || !session) {
      return apiError(c, 403, "FORBIDDEN", "requires a human session");
    }
    const ws = await requireWorkspace(c);
    const grant = await grantInWorkspace(c.req.param("id"), ws.id);
    if (!grant || grant.revokedAt) return apiError(c, 404, "NOT_FOUND", "grant not found");
    if (grant.userId !== session.userId) requireRole(c, "admin");
    await revokeGrantById(grant.id, "revoked by user", session.userId);
    return c.json({ ok: true });
  });
