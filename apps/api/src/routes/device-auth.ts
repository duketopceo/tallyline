import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { config_ } from "../env.js";
import { apiError } from "../lib/errors.js";
import {
  authLimiter,
  clientIp,
  createKeyedLimiter,
  createRateLimiter,
} from "../lib/rate-limit.js";
import {
  DeviceAuthError,
  decide,
  lookupPending,
  pollDeviceAuthorization,
  startDeviceAuthorization,
} from "../services/device-auth.js";
import { requireRole } from "../services/members.js";
import { isCookieSession, requireVerifiedEmail } from "./auth.js";
import { requireWorkspace } from "./workspaces.js";

const startSchema = z.object({ clientName: z.string().max(200).optional() });
const pollSchema = z.object({ deviceCode: z.string().min(16).max(256) });
const decideSchema = z.object({
  decision: z.enum(["approve", "deny"]),
  scopes: z.array(z.enum(["read", "write"])).min(1).default(["read", "write"]),
});

function fail(c: Parameters<typeof apiError>[0], e: unknown) {
  if (e instanceof DeviceAuthError) return apiError(c, e.status, e.code, e.message);
  throw e;
}

// Unauthenticated half: the CLI starts a handshake and polls it. Mounted
// before requireSession under /v1/auth.
export const deviceAuthPublicRoutes = (() => {
  // polling is expected every few seconds, so it gets the general per-IP
  // budget; starting a handshake gets the tight credential-guessing one
  const pollLimiter = createRateLimiter(config_.rateLimitPerMin, { prefix: "device-poll" });
  return new Hono()
    .post("/device/code", authLimiter, zValidator("json", startSchema), async (c) => {
      try {
        const body = c.req.valid("json");
        const started = await startDeviceAuthorization({
          clientName: body.clientName,
          requestIp: clientIp(c),
        });
        const verificationUri = `${config_.webUrl}/device`;
        return c.json(
          {
            device_code: started.deviceCode,
            user_code: started.userCode,
            verification_uri: verificationUri,
            verification_uri_complete: `${verificationUri}?code=${encodeURIComponent(started.userCode)}`,
            expires_in: started.expiresIn,
            interval: started.interval,
          },
          200,
        );
      } catch (e) {
        return fail(c, e);
      }
    })
    .post("/device/token", pollLimiter, zValidator("json", pollSchema), async (c) => {
      // RFC 8628 §3.5 shape: 200 with a token, or 400 with a plain error code
      const result = await pollDeviceAuthorization(c.req.valid("json").deviceCode);
      c.header("Cache-Control", "no-store");
      if (result.kind === "token") {
        return c.json({
          access_token: result.token,
          token_type: "Bearer",
          scope: result.scopes.join(" "),
        });
      }
      return c.json(
        { error: result.error, ...(result.interval ? { interval: result.interval } : {}) },
        400,
      );
    });
})();

// A wrong code costs the approver a request from the shared per-user budget:
// codes carry ~38 bits, so guessing is not worth it, but we do not rely on that.
const approveLimiter = createKeyedLimiter(30, 600_000, { prefix: "device-approve" });

// Human half: a signed-in browser session approves or denies a code. Same
// bar as minting a token in Settings: cookie session, verified email, admin.
export const deviceAuthWorkspaceRoutes = new Hono()
  .get("/workspaces/:ws/device/:userCode", async (c) => {
    const session = c.get("session");
    if (!isCookieSession(c) || !session) {
      return apiError(c, 403, "FORBIDDEN", "device approval requires a human session");
    }
    await requireWorkspace(c);
    requireRole(c, "admin");
    const limited = await approveLimiter.hit(c, session.userId);
    if (limited) return limited;
    try {
      const v = await lookupPending(c.req.param("userCode"));
      return c.json({
        clientName: v.clientName,
        requestIp: v.requestIp,
        requestedAt: v.requestedAt.toISOString(),
        expiresAt: v.expiresAt.toISOString(),
      });
    } catch (e) {
      return fail(c, e);
    }
  })
  .post("/workspaces/:ws/device/:userCode", zValidator("json", decideSchema), async (c) => {
    const session = c.get("session");
    if (!isCookieSession(c) || !session) {
      return apiError(c, 403, "FORBIDDEN", "device approval requires a human session");
    }
    const ws = await requireWorkspace(c);
    requireRole(c, "admin");
    await requireVerifiedEmail(c);
    const limited = await approveLimiter.hit(c, session.userId);
    if (limited) return limited;
    const body = c.req.valid("json");
    try {
      await decide({
        userCode: c.req.param("userCode"),
        decision: body.decision,
        userId: session.userId,
        workspaceId: ws.id,
        scopes: body.scopes,
      });
      return c.json({ ok: true, decision: body.decision });
    } catch (e) {
      return fail(c, e);
    }
  });
