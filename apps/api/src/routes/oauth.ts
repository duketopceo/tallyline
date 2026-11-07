import { zValidator } from "@hono/zod-validator";
import { eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { z } from "zod";
import {
  clearOAuthState,
  hashOpaque,
  issueOAuthState,
  readOAuthState,
  safeReturnTo,
} from "../auth/oauth-state.js";
import { getProvider, resolveProviders } from "../auth/providers/registry.js";
import type { IdentityResult } from "../auth/providers/types.js";
import { db, pool } from "../db/client.js";
import {
  authIdentities,
  oauthCodes,
  users,
  workspaces,
} from "../db/schema.js";
import { config_ } from "../env.js";
import { apiError } from "../lib/errors.js";
import { authLimiter } from "../lib/rate-limit.js";
import {
  createSession,
  SESSION_COOKIE,
  sessionFromToken,
  verifyPassword,
} from "../services/auth.js";
import { resolveIdentity } from "../services/identity.js";
import { membershipsFor } from "../services/members.js";
import { setSessionCookie } from "./auth.js";
import { clock } from "../services/clock.js";

// auth-scoped limiter (R16a): the global middleware skips /v1/auth/*, so
// the tight ceilings live inside the routers that serve it

// purpose-scoped code TTLs (KTD5): login codes are machine-redeemed in
// seconds; pending codes bound a human-in-the-loop step
const TTL_LOGIN_MS = 60_000;
const TTL_PENDING_MS = 600_000;

function redirectToWeb(c: Parameters<typeof apiError>[0], path: string) {
  c.header("cache-control", "no-store");
  return c.redirect(`${config_.webUrl}${path}`, 302);
}

function webError(c: Parameters<typeof apiError>[0], code: string) {
  return redirectToWeb(c, `/login?error=${code.toLowerCase()}`);
}

async function mintCode(opts: {
  purpose: "login" | "pending-bootstrap" | "pending-link";
  userId?: string | null;
  workspaceId?: string | null;
  context: Record<string, unknown>;
}) {
  const code = crypto.randomUUID() + crypto.randomUUID().replaceAll("-", "");
  const ttl = opts.purpose === "login" ? TTL_LOGIN_MS : TTL_PENDING_MS;
  await db.insert(oauthCodes).values({
    codeHash: hashOpaque(code),
    purpose: opts.purpose,
    userId: opts.userId ?? null,
    workspaceId: opts.workspaceId ?? null,
    context: opts.context,
    expiresAt: new Date(clock.ms() + ttl),
  });
  return code;
}

// atomic claim — returns the row iff it was still live (KTD5: claim at
// completion, after purpose dispatch, never on discovery reads)
async function claimCode(codeHash: string) {
  const [row] = await db
    .update(oauthCodes)
    .set({ usedAt: clock.now() })
    .where(
      sql`${oauthCodes.codeHash} = ${codeHash}
          AND ${oauthCodes.usedAt} IS NULL
          AND ${oauthCodes.expiresAt} > now()`,
    )
    .returning();
  return row ?? null;
}

export const oauthRoutes = new Hono()
  // public discovery — what the login page renders
  .get("/methods", async (c) => {
    const providers = await resolveProviders();
    return c.json({
      password: !config_.authDisablePassword,
      providers: providers.map((p) => ({
        key: p.key,
        type: p.type,
        label: p.label,
      })),
    });
  })
  // leg 1: issue state cookies, 302 to the provider authorize URL
  .get("/oauth/:provider/start", async (c) => {
    const provider = await getProvider(c.req.param("provider"));
    if (!provider) return webError(c, "provider_not_found");
    const q = c.req.query();
    const { state, nonce, codeVerifier, codeChallenge } = issueOAuthState(c, {
      returnTo: q.return_to,
      inviteToken: q.invite,
      loginNonce: q.login_nonce,
    });
    void codeVerifier; // carried by cookie, not the URL
    const url = await provider.authorizeUrl({
      redirectUri: `${config_.apiBaseUrl}/v1/auth/oauth/${provider.key}/callback`,
      state,
      nonce,
      codeChallenge,
    });
    return c.redirect(url, 302);
  })
  // leg 2 (form_post providers, i.e. Apple): the provider POSTs code/state
  // cross-site, so no state cookie rides along. Bounce to the GET leg with a
  // top-level 303; the Lax state cookie is sent there and the usual checks run.
  .post("/oauth/:provider/callback", async (c) => {
    const form = await c.req.parseBody().catch(() => ({}) as Record<string, string | File>);
    const u = new URL(`${config_.apiBaseUrl}/v1/auth/oauth/${c.req.param("provider")}/callback`);
    for (const k of ["code", "state", "error"]) {
      const v = form[k];
      if (typeof v === "string" && v.length < 4096) u.searchParams.set(k, v);
    }
    c.header("cache-control", "no-store");
    return c.redirect(u.toString(), 303);
  })
  // leg 2: provider lands here; verify state, exchange, resolve, mint code
  .get("/oauth/:provider/callback", async (c) => {
    const provider = await getProvider(c.req.param("provider"));
    const fail = (code: string) => {
      clearOAuthState(c);
      return webError(c, code);
    };
    if (!provider) return fail("provider_not_found");
    const q = c.req.query();
    if (q.error) return fail("denied");
    const { payload, nonce, codeVerifier } = readOAuthState(c);
    if (!payload || payload.state !== q.state || !q.code) {
      return fail("state");
    }
    let result: IdentityResult;
    try {
      result = await provider.exchange({
        code: q.code,
        redirectUri: `${config_.apiBaseUrl}/v1/auth/oauth/${provider.key}/callback`,
        codeVerifier,
        nonce,
      });
    } catch {
      return fail("exchange");
    }
    let resolved;
    try {
      resolved = await resolveIdentity(result, {
        providerKey: provider.key,
        inviteHash: payload.inviteHash,
      });
    } catch {
      return fail("resolve");
    }
    clearOAuthState(c);
    const baseCtx = {
      return_to: payload.returnTo,
      invite_hash: payload.inviteHash,
      login_nonce_hash: payload.loginNonce ? hashOpaque(payload.loginNonce) : null,
    };
    if (resolved.kind === "error") return webError(c, resolved.code);
    if (resolved.kind === "pending-bootstrap") {
      const code = await mintCode({
        purpose: "pending-bootstrap",
        context: {
          ...baseCtx,
          pending_email: resolved.pendingEmail,
          provider_key: provider.key,
          provider_subject: result.subject,
          name: result.name,
          avatar_url: result.avatarUrl,
          email_verified: result.emailVerified,
        },
      });
      return redirectToWeb(c, `/api/auth/callback?code=${code}`);
    }
    if (resolved.kind === "pending-link") {
      const code = await mintCode({
        purpose: "pending-link",
        context: {
          ...baseCtx,
          pending_email: resolved.pendingEmail,
          link_provider_key: provider.key,
          link_provider_label: provider.label,
          link_subject: resolved.linkSubject,
          link_email_verified: result.emailVerified,
        },
      });
      return redirectToWeb(c, `/api/auth/callback?code=${code}`);
    }
    const code = await mintCode({
      purpose: "login",
      userId: resolved.userId,
      workspaceId: resolved.workspaceId,
      context: baseCtx,
    });
    return redirectToWeb(c, `/api/auth/callback?code=${code}`);
  })
  // leg 3: web bridge exchanges the one-time code for a session
  .post(
    "/oauth/exchange",
    authLimiter,
    zValidator(
      "json",
      z.object({
        code: z.string().min(1),
        login_nonce: z.string().optional(),
        bootstrap: z
          .object({
            workspaceSlug: z.string().min(2).max(48).regex(/^[a-z0-9-]+$/),
            workspaceName: z.string().min(1).max(120),
            teamKey: z.string().min(1).max(6).regex(/^[A-Z][A-Z0-9]*$/).default("DOK"),
          })
          .optional(),
      }),
    ),
    async (c) => {
      const body = c.req.valid("json");
      c.header("cache-control", "no-store");
      const codeHash = hashOpaque(body.code);
      const [row] = await db
        .select()
        .from(oauthCodes)
        .where(eq(oauthCodes.codeHash, codeHash));
      if (!row || row.usedAt || row.expiresAt < clock.now()) {
        return apiError(c, 410, "CODE_GONE", "code expired or already used");
      }
      const ctx = (row.context ?? {}) as Record<string, unknown>;
      const nonceHash = ctx.login_nonce_hash as string | null;
      if (nonceHash && hashOpaque(body.login_nonce ?? "") !== nonceHash) {
        return apiError(c, 403, "BAD_NONCE", "login nonce mismatch");
      }
      const returnTo = safeReturnTo(ctx.return_to as string | undefined);

      if (row.purpose === "login") {
        const claimed = await claimCode(codeHash);
        if (!claimed) return apiError(c, 410, "CODE_GONE", "code expired or already used");
        const token = await createSession(claimed.userId!, claimed.workspaceId!);
        setSessionCookie(c, token);
        const [u] = await db.select().from(users).where(eq(users.id, claimed.userId!));
        const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, claimed.workspaceId!));
        const memberships = await membershipsFor(claimed.userId!);
        return c.json({
          purpose: "login",
          returnTo,
          user: { id: u!.id, email: u!.email, name: u!.name },
          workspaceSlug: ws!.slug,
          memberships,
        });
      }

      if (row.purpose === "pending-bootstrap") {
        if (!body.bootstrap) {
          // discovery read — the code must stay live until the form POSTs
          return c.json({ purpose: "pending-bootstrap", returnTo });
        }
        // serialized with /v1/auth/bootstrap — the second concurrent
        // first-login loses the zero-workspace check and falls through
        // to the normal JIT path instead of double-bootstrapping
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          await client.query(
            "SELECT pg_advisory_xact_lock(hashtext('tallyline-bootstrap')::bigint)",
          );
          const existing = await client.query("SELECT id FROM workspaces LIMIT 1");
          if (existing.rowCount! > 0) {
            await client.query("ROLLBACK");
            return apiError(c, 409, "BOOTSTRAP_CLOSED", "workspace already exists — sign in normally");
          }
          const claimed = await claimCode(codeHash);
          if (!claimed) {
            await client.query("ROLLBACK");
            return apiError(c, 410, "CODE_GONE", "code expired or already used");
          }
          const [ws] = (await client.query(
            "INSERT INTO workspaces (slug, name) VALUES ($1, $2) RETURNING id, slug, name",
            [body.bootstrap.workspaceSlug, body.bootstrap.workspaceName],
          )).rows;
          await client.query(
            "INSERT INTO teams (workspace_id, key, name) VALUES ($1, $2, 'Tallyline')",
            [ws.id, body.bootstrap.teamKey],
          );
          const pendingEmail = ctx.pending_email as string | null;
          const [u] = (await client.query(
            `INSERT INTO users (email, name) VALUES ($1, $2) RETURNING id, email, name`,
            [pendingEmail ?? `${ctx.provider_key}-${ctx.provider_subject}@sso.local`,
             (ctx.name as string | null) ?? pendingEmail ?? "sso user"],
          )).rows;
          await client.query(
            `INSERT INTO auth_identities (user_id, provider_key, provider_subject, email, email_verified)
             VALUES ($1, $2, $3, $4, $5)`,
            [u.id, ctx.provider_key, ctx.provider_subject, pendingEmail, ctx.email_verified === true],
          );
          await client.query(
            "INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'owner')",
            [ws.id, u.id],
          );
          // consume the invite if the first login carried one
          if (ctx.invite_hash) {
            await client.query(
              `UPDATE invites SET accepted_at = now(), accepted_by = $1
               WHERE token_hash = $2 AND accepted_at IS NULL`,
              [u.id, ctx.invite_hash],
            );
          }
          await client.query("COMMIT");
          const token = await createSession(u.id, ws.id);
          setSessionCookie(c, token);
          const memberships = await membershipsFor(u.id);
          return c.json({
            purpose: "login",
            returnTo,
            user: { id: u.id, email: u.email, name: u.name },
            workspaceSlug: ws.slug,
            memberships,
          });
        } catch (e) {
          await client.query("ROLLBACK").catch(() => {});
          throw e;
        } finally {
          client.release();
        }
      }

      // pending-link: discovery read returns the link context unclaimed;
      // /oauth/link performs the claim on successful proof
      return c.json(
        {
          purpose: "pending-link",
          returnTo,
          context: {
            pendingEmail: ctx.pending_email,
            linkProviderKey: ctx.link_provider_key,
            linkProviderLabel: ctx.link_provider_label,
          },
        },
        409,
      );
    },
  )
  // pending-link completion: prove control of the matched account per ITS
  // credential state (password when set, else a live session), then write
  // the identity row. The link token never mints a session itself (R13).
  .post(
    "/oauth/link",
    authLimiter,
    zValidator(
      "json",
      z.object({
        code: z.string().min(1),
        password: z.string().optional(),
      }),
    ),
    async (c) => {
      const body = c.req.valid("json");
      c.header("cache-control", "no-store");
      const codeHash = hashOpaque(body.code);
      const [row] = await db
        .select()
        .from(oauthCodes)
        .where(eq(oauthCodes.codeHash, codeHash));
      if (!row || row.purpose !== "pending-link" || row.usedAt || row.expiresAt < clock.now()) {
        return apiError(c, 410, "CODE_GONE", "code expired or already used");
      }
      const ctx = (row.context ?? {}) as Record<string, unknown>;
      const pendingEmail = ctx.pending_email as string;
      const [u] = await db
        .select()
        .from(users)
        .where(sql`lower(btrim(${users.email})) = ${pendingEmail.trim().toLowerCase()}`);
      if (!u) return apiError(c, 410, "CODE_GONE", "account no longer exists");

      // authenticate per the account's own credential state (R13)
      if (u.passwordHash) {
        if (!body.password || !verifyPassword(body.password, u.passwordHash)) {
          return apiError(c, 401, "BAD_CREDENTIALS", "invalid password");
        }
      } else {
        const token = getCookie(c, SESSION_COOKIE);
        const session = token ? await sessionFromToken(token) : null;
        if (!session || session.userId !== u.id) {
          return apiError(c, 401, "REAUTH_REQUIRED", "sign in to link this identity");
        }
      }

      const claimed = await claimCode(codeHash);
      if (!claimed) return apiError(c, 410, "CODE_GONE", "code expired or already used");
      await db.insert(authIdentities).values({
        userId: u.id,
        providerKey: ctx.link_provider_key as string,
        providerSubject: ctx.link_subject as string,
        email: pendingEmail,
        emailVerified: ctx.link_email_verified === true,
      }).onConflictDoNothing();
      return c.json({ ok: true });
    },
  );

export { mintCode };
