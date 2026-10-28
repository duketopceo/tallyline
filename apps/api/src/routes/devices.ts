import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { config_ } from "../env.js";
import { apiError } from "../lib/errors.js";
import { authLimiter, createKeyedLimiter } from "../lib/rate-limit.js";
import {
  DeviceError,
  deviceForToken,
  listDevices,
  mintPairingCode,
  redeemPairingCode,
  revokeDevice,
  rotateDevice,
} from "../services/devices.js";
import { requireRole } from "../services/members.js";
import { isCookieSession, requireVerifiedEmail } from "./auth.js";
import { requireWorkspace } from "./workspaces.js";

const redeemSchema = z.object({
  code: z.string().min(16).max(128),
  deviceName: z.string().trim().min(1).max(80),
  platform: z.enum(["ios", "android", "other"]).default("other"),
});

function fail(c: Parameters<typeof apiError>[0], e: unknown) {
  if (e instanceof DeviceError) return apiError(c, e.status, e.code, e.message);
  throw e;
}

/** the token id behind a PAT session ("pat:<id>"), or null for anything else */
function patTokenId(c: Parameters<typeof apiError>[0]): string | null {
  const id = c.get("session")?.sessionId;
  return id?.startsWith("pat:") ? id.slice(4) : null;
}

// Unauthenticated half: the phone trades a scanned code for its credential.
// Codes carry ~144 bits, so guessing is hopeless; the per-IP credential budget
// is belt and braces. Mounted before requireSession under /v1/auth.
export const devicePublicRoutes = new Hono().post(
  "/pair/redeem",
  authLimiter,
  zValidator("json", redeemSchema),
  async (c) => {
    const body = c.req.valid("json");
    try {
      const r = await redeemPairingCode(body);
      c.header("Cache-Control", "no-store");
      return c.json({
        token: r.token,
        tokenType: "Bearer",
        expiresAt: r.expiresAt.toISOString(),
        scopes: r.scopes,
        deviceId: r.deviceId,
        server: config_.apiBaseUrl,
        workspace: r.workspace,
      });
    } catch (e) {
      return fail(c, e);
    }
  },
);

export const pairMintLimiter = createKeyedLimiter(10, 600_000, { prefix: "pair-mint" });

// Human half: a signed-in browser session mints codes and manages its own
// devices. A paired phone can rotate or sign itself out, nothing more:
// delegated credentials and agent keys can't mint or enumerate devices.
export const deviceRoutes = new Hono()
  .post("/workspaces/:ws/devices/pairing", async (c) => {
    const session = c.get("session");
    if (!isCookieSession(c) || !session) {
      return apiError(c, 403, "FORBIDDEN", "pairing a device requires a signed-in person");
    }
    const ws = await requireWorkspace(c);
    requireRole(c, "member");
    await requireVerifiedEmail(c);
    const limited = await pairMintLimiter.hit(c, session.userId);
    if (limited) return limited;
    try {
      const m = await mintPairingCode(ws.id, session.userId);
      const url = new URL("tallyline://pair");
      url.searchParams.set("server", config_.apiBaseUrl);
      url.searchParams.set("code", m.code);
      c.header("Cache-Control", "no-store");
      return c.json(
        { code: m.code, expiresAt: m.expiresAt.toISOString(), expiresIn: m.expiresIn, pairingUrl: url.toString() },
        201,
      );
    } catch (e) {
      return fail(c, e);
    }
  })
  .get("/workspaces/:ws/devices", async (c) => {
    const session = c.get("session");
    if (!isCookieSession(c) || !session) {
      return apiError(c, 403, "FORBIDDEN", "requires a signed-in person");
    }
    const ws = await requireWorkspace(c);
    return c.json({ devices: await listDevices(ws.id, session.userId, null) });
  })
  // the paired phone itself ("current" is registered before ":id")
  .post("/workspaces/:ws/devices/current/rotate", async (c) => {
    const tokenId = patTokenId(c);
    const session = c.get("session");
    if (!tokenId || !session) {
      return apiError(c, 403, "FORBIDDEN", "only a paired device can rotate its own credential");
    }
    const ws = await requireWorkspace(c);
    try {
      const r = await rotateDevice(ws.id, session.userId, tokenId);
      c.header("Cache-Control", "no-store");
      return c.json({ token: r.token, tokenType: "Bearer", expiresAt: r.expiresAt.toISOString(), scopes: r.scopes });
    } catch (e) {
      return fail(c, e);
    }
  })
  .delete("/workspaces/:ws/devices/current", async (c) => {
    const tokenId = patTokenId(c);
    const session = c.get("session");
    if (!tokenId || !session) {
      return apiError(c, 403, "FORBIDDEN", "only a paired device can sign itself out");
    }
    const ws = await requireWorkspace(c);
    const d = await deviceForToken(ws.id, session.userId, tokenId);
    if (!d) return apiError(c, 404, "NOT_A_DEVICE", "this credential isn't a paired device");
    await revokeDevice(ws.id, session.userId, d.id);
    return c.json({ ok: true });
  })
  .delete("/workspaces/:ws/devices/:id", async (c) => {
    const session = c.get("session");
    if (!isCookieSession(c) || !session) {
      return apiError(c, 403, "FORBIDDEN", "requires a signed-in person");
    }
    const ws = await requireWorkspace(c);
    const id = c.req.param("id");
    if (!z.uuid().safeParse(id).success) return apiError(c, 404, "NOT_FOUND", "device not found");
    const ok = await revokeDevice(ws.id, session.userId, id);
    if (!ok) return apiError(c, 404, "NOT_FOUND", "device not found");
    return c.json({ ok: true });
  });
