import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { hashInviteToken } from "../auth/invite-token.js";
import { AppleAuthError, verifyAppleIdentityToken } from "../auth/apple-identity.js";
import { config_ } from "../env.js";
import { apiError } from "../lib/errors.js";
import { authLimiter } from "../lib/rate-limit.js";
import { DeviceError, mintDeviceCredential } from "../services/devices.js";
import { resolveIdentity } from "../services/identity.js";

function appleAudiences(): string[] {
  const ids = [...config_.appleBundleIds];
  if (config_.appleClientId) ids.push(config_.appleClientId);
  return [...new Set(ids)];
}

export function appleSiwaConfigured(): boolean {
  return appleAudiences().length > 0;
}

/**
 * Native SIWA: phone posts Apple's identity token + raw nonce; we verify JWKS,
 * resolveIdentity, mint the same device PAT pairing uses.
 */
export const appleAuthRoutes = new Hono().post(
  "/apple",
  authLimiter,
  zValidator(
    "json",
    z.object({
      identityToken: z.string().min(20),
      rawNonce: z.string().min(8).max(256),
      deviceName: z.string().trim().min(1).max(80),
      platform: z.enum(["ios", "android", "other"]).default("ios"),
      /** optional raw invite token (hashed server-side before resolveIdentity) */
      invite: z.string().optional(),
    }),
  ),
  async (c) => {
    if (!appleSiwaConfigured()) {
      return apiError(c, 503, "APPLE_NOT_CONFIGURED", "Sign in with Apple is not configured on this server");
    }
    const body = c.req.valid("json");
    let claims;
    try {
      claims = await verifyAppleIdentityToken(body.identityToken, {
        audiences: appleAudiences(),
        rawNonce: body.rawNonce,
      });
    } catch (e) {
      if (e instanceof AppleAuthError) {
        return apiError(c, 401, "INVALID_APPLE_TOKEN", e.code);
      }
      throw e;
    }

    const inviteHash = body.invite ? hashInviteToken(body.invite) : null;

    const resolved = await resolveIdentity(
      {
        subject: claims.subject,
        email: claims.email,
        emailVerified: claims.emailVerified,
        name: null,
        avatarUrl: null,
        hd: null,
      },
      { providerKey: "apple", inviteHash },
    );

    if (resolved.kind === "error") {
      return apiError(c, 403, resolved.code, resolved.code.toLowerCase().replaceAll("_", " "));
    }
    if (resolved.kind === "pending-bootstrap") {
      return apiError(
        c,
        409,
        "BOOTSTRAP_REQUIRED",
        "create the first workspace on the web, then sign in with Apple again",
      );
    }
    if (resolved.kind === "pending-link") {
      return apiError(
        c,
        409,
        "LINK_REQUIRED",
        "sign in on the web once to link this Apple ID to your account",
      );
    }

    try {
      const r = await mintDeviceCredential({
        userId: resolved.userId,
        workspaceId: resolved.workspaceId,
        deviceName: body.deviceName,
        platform: body.platform,
        eventAction: "device_signed_in",
      });
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
      if (e instanceof DeviceError) return apiError(c, e.status, e.code, e.message);
      throw e;
    }
  },
);
