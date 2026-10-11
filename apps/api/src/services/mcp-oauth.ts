import {
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import {
  agents,
  events,
  oauthClients,
  oauthGrants,
  oauthRequests,
  oauthTokens,
  users,
  workspaceMembers,
  workspaces,
} from "../db/schema.js";
import { config_ } from "../env.js";
import { safeGetText } from "../lib/net-guard.js";
import { clock } from "./clock.js";
import { memberOf } from "./members.js";

// Tallyline as the OAuth 2.1 authorization server for its own remote MCP
// endpoint (PLAN-011). Public clients only (PKCE S256, no client secret).
// Spec basis: MCP authorization, protocol revision 2026-07-28 (current);
// the AS surface is unchanged from 2025-11-25.

export const ISSUER = config_.apiBaseUrl;
export const RESOURCE = config_.mcpResourceUrl;
export const SUPPORTED_SCOPES = ["read", "write"] as const;
export type OAuthScope = (typeof SUPPORTED_SCOPES)[number];

export const CODE_TTL_MS = 60_000;
export const ACCESS_TTL_S = 60 * 60;
export const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const REQUEST_TTL_MS = 10 * 60 * 1000;
const CIMD_TTL_MIN_MS = 60_000;
const CIMD_TTL_MAX_MS = 24 * 60 * 60 * 1000;
const CIMD_MAX_BYTES = 5 * 1024;

export const CODE_PREFIX = "tly_oac_";
export const ACCESS_PREFIX = "tly_oat_";
export const REFRESH_PREFIX = "tly_ort_";

export function isOAuthAccessToken(t: string | null | undefined): t is string {
  return !!t && t.startsWith(ACCESS_PREFIX);
}

/** RFC 6749 error carried through the endpoints. */
export class OAuthError extends Error {
  constructor(
    readonly error: string,
    readonly description: string,
    readonly status: 400 | 401 | 403 | 404 | 410 | 500 = 400,
  ) {
    super(description);
    this.name = "OAuthError";
  }
}

export function hashSecret(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function mint(prefix: string): string {
  return `${prefix}${randomBytes(32).toString("base64url")}`;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

// ── internal-call credential ────────────────────────────────────────────
// The MCP endpoint dispatches tool calls into the API in-process using the
// caller's OAuth token. Only that dispatch may present an OAuth access token
// to /v1/* — a token presented straight to /v1 is refused (audience binding:
// these tokens are for the MCP resource, not the REST API).
export const INTERNAL_HEADER = "x-tallyline-mcp-internal";
const internalSecret = randomBytes(32).toString("base64url");
export const internalHeaderValue = internalSecret;
export function isInternalCall(value: string | undefined | null): boolean {
  return !!value && safeEqual(value, internalSecret);
}

// ── audit ───────────────────────────────────────────────────────────────

async function audit(opts: {
  workspaceId: string;
  action: string;
  grantId: string;
  userId?: string | null;
  after?: Record<string, unknown>;
}): Promise<void> {
  await db.insert(events).values({
    workspaceId: opts.workspaceId,
    entityType: "oauth_grant",
    entityId: opts.grantId,
    action: opts.action,
    actorType: opts.userId ? "human" : "system",
    actorId: opts.userId ?? null,
    after: opts.after ?? null,
  });
}

// ── scopes / resources ──────────────────────────────────────────────────

export function normalizeResource(resource: string): string {
  return resource.replace(/\/+$/, "");
}

export function resourceMatches(resource: string | undefined | null): boolean {
  return !!resource && normalizeResource(resource) === RESOURCE;
}

/**
 * Parse an OAuth `scope` string. Unknown scopes are an error; offline_access
 * is accepted and ignored (refresh tokens are always issued). `write` implies
 * `read`.
 */
export function parseScopes(raw: string | undefined | null): OAuthScope[] {
  const parts = (raw ?? "").split(/\s+/).filter(Boolean);
  const out = new Set<OAuthScope>();
  for (const p of parts) {
    if (p === "offline_access") continue;
    if (p !== "read" && p !== "write") {
      throw new OAuthError("invalid_scope", `unsupported scope '${p}'`);
    }
    out.add(p);
  }
  if (out.size === 0) return [...SUPPORTED_SCOPES];
  if (out.has("write")) out.add("read");
  return SUPPORTED_SCOPES.filter((s) => out.has(s));
}

// ── redirect URIs ───────────────────────────────────────────────────────

function parseUrl(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

function isLoopbackHost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
}

/** https, or http on a loopback host (RFC 8252 native apps). No fragments or userinfo. */
export function validRedirectUri(raw: string): boolean {
  if (raw.length > 2048 || raw.includes("#")) return false;
  const u = parseUrl(raw);
  if (!u || u.username || u.password) return false;
  if (u.protocol === "https:") return true;
  return u.protocol === "http:" && isLoopbackHost(u.hostname);
}

/**
 * Exact string match against the registered allowlist. The one RFC 8252
 * §7.3 exception: a registered loopback URI WITHOUT a port matches the same
 * loopback host/path on any port (Claude Code declares http://localhost/callback
 * and http://127.0.0.1/callback).
 */
export function redirectUriAllowed(registered: string[], requested: string): boolean {
  if (registered.includes(requested)) return true;
  const req = parseUrl(requested);
  if (!req || req.protocol !== "http:" || !isLoopbackHost(req.hostname)) return false;
  return registered.some((r) => {
    const reg = parseUrl(r);
    return (
      !!reg &&
      reg.protocol === "http:" &&
      isLoopbackHost(reg.hostname) &&
      reg.port === "" &&
      reg.hostname === req.hostname &&
      reg.pathname === req.pathname &&
      reg.search === req.search
    );
  });
}

// ── clients: DCR + Client ID Metadata Documents ─────────────────────────

export interface OAuthClient {
  clientId: string;
  kind: "dcr" | "cimd";
  name: string;
  redirectUris: string[];
}

export interface RegistrationInput {
  client_name?: unknown;
  redirect_uris?: unknown;
  token_endpoint_auth_method?: unknown;
  grant_types?: unknown;
  response_types?: unknown;
  client_uri?: unknown;
}

function cleanName(v: unknown, fallback: string): string {
  const s = typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, " ").trim() : "";
  return (s || fallback).slice(0, 100);
}

function metaError(msg: string): never {
  throw new OAuthError("invalid_client_metadata", msg);
}

function validateRedirectList(v: unknown): string[] {
  if (!Array.isArray(v) || v.length === 0 || v.length > 10) {
    metaError("redirect_uris must be an array of 1-10 URIs");
  }
  for (const u of v) {
    if (typeof u !== "string" || !validRedirectUri(u)) {
      metaError("redirect_uris must be https URIs or http loopback URIs without fragments");
    }
  }
  return [...new Set(v as string[])];
}

function validateGrantMetadata(input: RegistrationInput): void {
  const method = input.token_endpoint_auth_method;
  if (method !== undefined && method !== "none") {
    metaError("only token_endpoint_auth_method=none (public client + PKCE) is supported");
  }
  const grants = input.grant_types;
  if (grants !== undefined) {
    if (
      !Array.isArray(grants) ||
      !grants.every((g) => g === "authorization_code" || g === "refresh_token")
    ) {
      metaError("grant_types may only contain authorization_code and refresh_token");
    }
  }
  const types = input.response_types;
  if (types !== undefined) {
    if (!Array.isArray(types) || !types.every((t) => t === "code")) {
      metaError("response_types may only contain code");
    }
  }
}

/** RFC 7591 dynamic client registration (public clients only). */
export async function registerClient(input: RegistrationInput) {
  const redirectUris = validateRedirectList(input.redirect_uris);
  validateGrantMetadata(input);
  const name = cleanName(input.client_name, "MCP client");
  const clientId = `tly_cli_${randomBytes(16).toString("base64url")}`;
  await db.insert(oauthClients).values({
    clientId,
    kind: "dcr",
    name,
    redirectUris,
  });
  return {
    client_id: clientId,
    client_id_issued_at: Math.floor(clock.ms() / 1000),
    client_name: name,
    redirect_uris: redirectUris,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  };
}

type MetadataFetcher = (
  url: string,
) => Promise<{ status: number; body: string; cacheControl: string | null }>;

let fetchMetadata: MetadataFetcher = (url) =>
  safeGetText(url, { timeoutMs: 5000, maxBytes: CIMD_MAX_BYTES });

/** test hook: replace the CIMD fetcher (production uses the SSRF-guarded GET) */
export function setClientMetadataFetcher(fn: MetadataFetcher | null): void {
  fetchMetadata =
    fn ?? ((url) => safeGetText(url, { timeoutMs: 5000, maxBytes: CIMD_MAX_BYTES }));
}

function isMetadataClientId(clientId: string): boolean {
  return clientId.startsWith("https://");
}

function cimdTtlMs(cacheControl: string | null): number {
  const m = cacheControl ? /max-age=(\d+)/i.exec(cacheControl) : null;
  const ms = m ? Number(m[1]) * 1000 : 60 * 60 * 1000;
  return Math.min(CIMD_TTL_MAX_MS, Math.max(CIMD_TTL_MIN_MS, ms));
}

async function loadCimd(clientId: string): Promise<OAuthClient> {
  const u = parseUrl(clientId);
  if (
    !u ||
    u.protocol !== "https:" ||
    u.pathname === "/" ||
    u.username ||
    u.password ||
    u.hash ||
    clientId.length > 1024 ||
    // WHATWG URL normalizes dot segments away, so inspect the raw string
    /\/\.\.?(\/|$|\?)/.test(clientId.slice(8))
  ) {
    throw new OAuthError("invalid_client", "client_id metadata URL is not acceptable");
  }
  let res;
  try {
    res = await fetchMetadata(clientId);
  } catch (err) {
    throw new OAuthError(
      "invalid_client",
      `could not fetch client metadata: ${err instanceof Error ? err.message : "error"}`,
    );
  }
  if (res.status !== 200) {
    throw new OAuthError("invalid_client", `client metadata returned HTTP ${res.status}`);
  }
  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(res.body) as Record<string, unknown>;
  } catch {
    throw new OAuthError("invalid_client", "client metadata is not valid JSON");
  }
  if (!doc || typeof doc !== "object" || doc.client_id !== clientId) {
    throw new OAuthError("invalid_client", "client metadata client_id does not match its URL");
  }
  let redirectUris: string[];
  try {
    redirectUris = validateRedirectList(doc.redirect_uris);
    // token_endpoint_auth_method is not enforced: this AS never authenticates
    // clients, every client is public and PKCE-bound
    const { grant_types, response_types } = doc;
    validateGrantMetadata({ grant_types, response_types });
  } catch (err) {
    if (err instanceof OAuthError) {
      throw new OAuthError("invalid_client", err.description);
    }
    throw err;
  }
  const name = cleanName(doc.client_name, u.hostname);
  const expiresAt = new Date(clock.ms() + cimdTtlMs(res.cacheControl));
  await db
    .insert(oauthClients)
    .values({
      clientId,
      kind: "cimd",
      name,
      redirectUris,
      clientUri: typeof doc.client_uri === "string" ? doc.client_uri.slice(0, 1024) : null,
      expiresAt,
    })
    .onConflictDoUpdate({
      target: oauthClients.clientId,
      set: { name, redirectUris, expiresAt },
    });
  return { clientId, kind: "cimd", name, redirectUris };
}

export async function resolveClient(clientId: string): Promise<OAuthClient> {
  if (!clientId || clientId.length > 1024) {
    throw new OAuthError("invalid_client", "unknown client_id", 401);
  }
  const [row] = await db
    .select()
    .from(oauthClients)
    .where(eq(oauthClients.clientId, clientId));
  if (row && (!row.expiresAt || row.expiresAt.getTime() > clock.ms())) {
    return {
      clientId: row.clientId,
      kind: row.kind,
      name: row.name,
      redirectUris: row.redirectUris,
    };
  }
  if (isMetadataClientId(clientId)) return loadCimd(clientId);
  throw new OAuthError("invalid_client", "unknown client_id", 401);
}

// ── authorization request → consent ─────────────────────────────────────

export interface AuthorizeParams {
  clientId: string;
  redirectUri: string;
  scopes: OAuthScope[];
  state: string | undefined;
  codeChallenge: string;
  resource: string;
}

const CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;

export function assertChallenge(challenge: string | undefined, method: string | undefined) {
  if (method !== "S256") {
    throw new OAuthError("invalid_request", "code_challenge_method must be S256");
  }
  if (!challenge || !CHALLENGE_RE.test(challenge)) {
    throw new OAuthError("invalid_request", "code_challenge must be a base64url SHA-256 (43 chars)");
  }
}

export async function createAuthRequest(p: AuthorizeParams): Promise<string> {
  const [row] = await db
    .insert(oauthRequests)
    .values({
      clientId: p.clientId,
      redirectUri: p.redirectUri,
      scopes: p.scopes,
      state: p.state ?? null,
      codeChallenge: p.codeChallenge,
      resource: p.resource,
      expiresAt: new Date(clock.ms() + REQUEST_TTL_MS),
    })
    .returning({ id: oauthRequests.id });
  return row!.id;
}

/** Build the client redirect (RFC 6749 §4.1.2 + RFC 9207 iss). */
export function clientRedirect(
  redirectUri: string,
  params: Record<string, string | undefined>,
): string {
  const u = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) u.searchParams.set(k, v);
  }
  u.searchParams.set("iss", ISSUER);
  return u.toString();
}

async function liveRequest(id: string) {
  const [req] = await db
    .select()
    .from(oauthRequests)
    .where(
      and(
        eq(oauthRequests.id, id),
        isNull(oauthRequests.decidedAt),
        gt(oauthRequests.expiresAt, clock.now()),
      ),
    );
  return req ?? null;
}

export interface ConsentView {
  requestId: string;
  csrf: string;
  client: { id: string; name: string; kind: "dcr" | "cimd" };
  redirectUri: string;
  redirectHost: string;
  loopbackOnly: boolean;
  scopes: OAuthScope[];
  resource: string;
  workspaces: { slug: string; name: string; role: string }[];
  /** false until the account's email is confirmed; approval is refused then */
  emailVerified: boolean;
  /** why approval is unavailable, shown on the consent page; null when it is available */
  unavailableReason: string | null;
}

export const EMAIL_UNVERIFIED_MESSAGE =
  "confirm your email first — use the link we sent, or resend it from Settings > Account";

export async function consentView(requestId: string, userId: string): Promise<ConsentView> {
  const req = await liveRequest(requestId);
  if (!req) throw new OAuthError("invalid_request", "authorization request expired or already used", 404);
  const client = await resolveClient(req.clientId).catch(() => null);
  if (!client) throw new OAuthError("invalid_client", "client no longer available", 404);
  const csrf = randomBytes(24).toString("base64url");
  await db
    .update(oauthRequests)
    .set({ csrfHash: hashSecret(csrf), userId })
    .where(eq(oauthRequests.id, req.id));
  const rows = await db
    .select({
      slug: workspaces.slug,
      name: workspaces.name,
      role: workspaceMembers.role,
    })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
    .where(and(eq(workspaceMembers.userId, userId), isNull(workspaces.deletedAt)))
    .orderBy(workspaceMembers.createdAt);
  const [acct] = await db.select({ at: users.emailVerifiedAt }).from(users).where(eq(users.id, userId));
  const emailVerified = Boolean(acct?.at);
  const redirect = new URL(req.redirectUri);
  return {
    requestId: req.id,
    csrf,
    client: { id: client.clientId, name: client.name, kind: client.kind },
    redirectUri: req.redirectUri,
    redirectHost: redirect.host,
    loopbackOnly: client.redirectUris.every((r) => {
      const p = parseUrl(r);
      return !!p && isLoopbackHost(p.hostname);
    }),
    scopes: req.scopes as OAuthScope[],
    resource: req.resource,
    workspaces: rows,
    emailVerified,
    unavailableReason: emailVerified ? null : EMAIL_UNVERIFIED_MESSAGE,
  };
}

async function connectorAgent(workspaceId: string, clientName: string, user: { id: string; name: string }) {
  const base = `${clientName} via MCP (${user.name})`.slice(0, 110);
  for (const name of [base, `${base} ${user.id.slice(0, 6)}`]) {
    await db
      .insert(agents)
      .values({
        workspaceId,
        name,
        harness: "mcp-connector",
        capabilities: ["mcp"],
      })
      .onConflictDoNothing();
    const [row] = await db
      .select()
      .from(agents)
      .where(and(eq(agents.workspaceId, workspaceId), eq(agents.name, name)));
    if (row && row.harness === "mcp-connector") return row;
  }
  throw new OAuthError("server_error", "could not allocate connector identity", 500);
}

export interface DecisionInput {
  approve: boolean;
  workspaceSlug?: string;
  scopes?: string[];
  csrf: string;
}

/** Record the consent decision; returns the URL to send the browser to. */
export async function decideConsent(
  requestId: string,
  user: { id: string; name: string },
  input: DecisionInput,
): Promise<string> {
  const req = await liveRequest(requestId);
  if (!req) throw new OAuthError("invalid_request", "authorization request expired or already used", 404);
  if (!req.csrfHash || !req.userId || req.userId !== user.id || !safeEqual(req.csrfHash, hashSecret(input.csrf))) {
    throw new OAuthError("invalid_request", "consent token mismatch — reload the consent page", 403);
  }
  // single-use: claim the request before acting on it
  const [claimed] = await db
    .update(oauthRequests)
    .set({ decidedAt: clock.now() })
    .where(and(eq(oauthRequests.id, req.id), isNull(oauthRequests.decidedAt)))
    .returning({ id: oauthRequests.id });
  if (!claimed) throw new OAuthError("invalid_request", "authorization request already used", 404);

  if (!input.approve) {
    return clientRedirect(req.redirectUri, {
      error: "access_denied",
      error_description: "the user denied the request",
      state: req.state ?? undefined,
    });
  }

  if (!input.workspaceSlug) throw new OAuthError("invalid_request", "choose a workspace");
  const [ws] = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.slug, input.workspaceSlug));
  const member = ws ? await memberOf(user.id, ws.id) : null;
  if (!ws || !member) {
    throw new OAuthError("access_denied", "not a member of that workspace", 403);
  }
  if (ws.deletedAt) {
    throw new OAuthError(
      "access_denied",
      "that workspace is scheduled for deletion — restore it before connecting an app",
      410,
    );
  }
  const requested = req.scopes as OAuthScope[];
  const chosen = parseScopes((input.scopes ?? requested).join(" "));
  if (!chosen.every((s) => requested.includes(s))) {
    throw new OAuthError("invalid_scope", "cannot grant scopes the client did not request");
  }

  const [client] = await db
    .select({ name: oauthClients.name })
    .from(oauthClients)
    .where(eq(oauthClients.clientId, req.clientId));
  const clientName = client?.name ?? "MCP client";

  const agent = await connectorAgent(ws.id, clientName, user);
  // one live grant per (user, workspace, client): re-consent replaces scopes
  const [existing] = await db
    .select()
    .from(oauthGrants)
    .where(
      and(
        eq(oauthGrants.userId, user.id),
        eq(oauthGrants.workspaceId, ws.id),
        eq(oauthGrants.clientId, req.clientId),
        isNull(oauthGrants.revokedAt),
      ),
    );
  let grantId: string;
  if (existing) {
    grantId = existing.id;
    await db
      .update(oauthGrants)
      .set({ scopes: chosen, clientName, agentId: agent.id })
      .where(eq(oauthGrants.id, existing.id));
  } else {
    const [g] = await db
      .insert(oauthGrants)
      .values({
        userId: user.id,
        workspaceId: ws.id,
        agentId: agent.id,
        clientId: req.clientId,
        clientName,
        scopes: chosen,
        resource: req.resource,
      })
      .returning({ id: oauthGrants.id });
    grantId = g!.id;
  }
  await audit({
    workspaceId: ws.id,
    action: existing ? "oauth.grant.updated" : "oauth.grant.created",
    grantId,
    userId: user.id,
    after: { client: clientName, clientId: req.clientId, scopes: chosen },
  });

  const code = mint(CODE_PREFIX);
  await db.insert(oauthTokens).values({
    grantId,
    kind: "code",
    tokenHash: hashSecret(code),
    scopes: chosen,
    resource: req.resource,
    codeChallenge: req.codeChallenge,
    redirectUri: req.redirectUri,
    expiresAt: new Date(clock.ms() + CODE_TTL_MS),
  });
  return clientRedirect(req.redirectUri, { code, state: req.state ?? undefined });
}

// ── token endpoint ──────────────────────────────────────────────────────

export interface TokenResponse {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope: string;
}

async function issuePair(
  grantId: string,
  scopes: string[],
  resource: string,
): Promise<TokenResponse> {
  const access = mint(ACCESS_PREFIX);
  const refresh = mint(REFRESH_PREFIX);
  await db.insert(oauthTokens).values([
    {
      grantId,
      kind: "access",
      tokenHash: hashSecret(access),
      scopes,
      resource,
      expiresAt: new Date(clock.ms() + ACCESS_TTL_S * 1000),
    },
    {
      grantId,
      kind: "refresh",
      tokenHash: hashSecret(refresh),
      scopes,
      resource,
      expiresAt: new Date(clock.ms() + REFRESH_TTL_MS),
    },
  ]);
  return {
    access_token: access,
    token_type: "Bearer",
    expires_in: ACCESS_TTL_S,
    refresh_token: refresh,
    scope: scopes.join(" "),
  };
}

export async function revokeGrantById(
  grantId: string,
  reason: string,
  userId: string | null = null,
): Promise<boolean> {
  const now = clock.now();
  const [g] = await db
    .update(oauthGrants)
    .set({ revokedAt: now })
    .where(and(eq(oauthGrants.id, grantId), isNull(oauthGrants.revokedAt)))
    .returning();
  await db
    .update(oauthTokens)
    .set({ revokedAt: now })
    .where(and(eq(oauthTokens.grantId, grantId), isNull(oauthTokens.revokedAt)));
  if (g) {
    await audit({
      workspaceId: g.workspaceId,
      action: "oauth.grant.revoked",
      grantId,
      userId,
      after: { reason },
    });
  }
  return !!g;
}

function pkceOk(verifier: string, challenge: string): boolean {
  if (!/^[A-Za-z0-9\-._~]{43,128}$/.test(verifier)) return false;
  const computed = createHash("sha256").update(verifier).digest("base64url");
  return safeEqual(computed, challenge);
}

export async function exchangeCode(p: {
  code: string;
  clientId: string;
  redirectUri: string | undefined;
  verifier: string | undefined;
  resource: string | undefined;
}): Promise<TokenResponse> {
  if (!p.code || !p.verifier) {
    throw new OAuthError("invalid_request", "code and code_verifier are required");
  }
  const hash = hashSecret(p.code);
  const [row] = await db.select().from(oauthTokens).where(eq(oauthTokens.tokenHash, hash));
  if (!row || row.kind !== "code") throw new OAuthError("invalid_grant", "invalid authorization code");
  // replay of an already-redeemed code: RFC 6749 §4.1.2 / OAuth 2.1 — revoke
  // everything issued from it
  if (row.redeemedAt) {
    await revokeGrantById(row.grantId, "authorization code replayed");
    throw new OAuthError("invalid_grant", "authorization code already used");
  }
  // single attempt: claim the code before verifying so a wrong verifier burns it
  const [claimed] = await db
    .update(oauthTokens)
    .set({ usedAt: clock.now() })
    .where(and(eq(oauthTokens.id, row.id), isNull(oauthTokens.usedAt)))
    .returning({ id: oauthTokens.id });
  if (!claimed) throw new OAuthError("invalid_grant", "authorization code already used");
  if (row.expiresAt.getTime() <= clock.ms()) {
    throw new OAuthError("invalid_grant", "authorization code expired");
  }
  const [grant] = await db.select().from(oauthGrants).where(eq(oauthGrants.id, row.grantId));
  if (!grant || grant.revokedAt) throw new OAuthError("invalid_grant", "grant revoked");
  if (grant.clientId !== p.clientId) {
    throw new OAuthError("invalid_grant", "code was issued to a different client");
  }
  if (!p.redirectUri || p.redirectUri !== row.redirectUri) {
    throw new OAuthError("invalid_grant", "redirect_uri does not match the authorization request");
  }
  if (!row.codeChallenge || !pkceOk(p.verifier, row.codeChallenge)) {
    throw new OAuthError("invalid_grant", "PKCE verification failed");
  }
  if (p.resource !== undefined && normalizeResource(p.resource) !== normalizeResource(row.resource)) {
    throw new OAuthError("invalid_target", "resource does not match the authorization request");
  }
  await db
    .update(oauthTokens)
    .set({ redeemedAt: clock.now() })
    .where(eq(oauthTokens.id, row.id));
  const pair = await issuePair(grant.id, grant.scopes, row.resource);
  await audit({
    workspaceId: grant.workspaceId,
    action: "oauth.token.issued",
    grantId: grant.id,
    userId: grant.userId,
  });
  return pair;
}

export async function refreshTokens(p: {
  refreshToken: string;
  clientId: string;
  scope: string | undefined;
  resource: string | undefined;
}): Promise<TokenResponse> {
  if (!p.refreshToken) throw new OAuthError("invalid_request", "refresh_token is required");
  const [row] = await db
    .select()
    .from(oauthTokens)
    .where(eq(oauthTokens.tokenHash, hashSecret(p.refreshToken)));
  if (!row || row.kind !== "refresh") throw new OAuthError("invalid_grant", "invalid refresh token");
  const [grant] = await db.select().from(oauthGrants).where(eq(oauthGrants.id, row.grantId));
  if (!grant || grant.revokedAt || row.revokedAt) {
    throw new OAuthError("invalid_grant", "refresh token revoked");
  }
  if (grant.clientId !== p.clientId) {
    throw new OAuthError("invalid_grant", "refresh token was issued to a different client");
  }
  // rotation: a refresh token is single-use; seeing a used one again means it
  // leaked — kill the grant
  if (row.usedAt) {
    await revokeGrantById(grant.id, "refresh token reuse detected");
    throw new OAuthError("invalid_grant", "refresh token already used");
  }
  if (row.expiresAt.getTime() <= clock.ms()) {
    throw new OAuthError("invalid_grant", "refresh token expired");
  }
  if (p.resource !== undefined && normalizeResource(p.resource) !== normalizeResource(row.resource)) {
    throw new OAuthError("invalid_target", "resource does not match the grant");
  }
  let scopes = grant.scopes;
  if (p.scope) {
    const asked = parseScopes(p.scope);
    if (!asked.every((s) => grant.scopes.includes(s))) {
      throw new OAuthError("invalid_scope", "cannot widen scopes on refresh");
    }
    scopes = asked;
  }
  const [claimed] = await db
    .update(oauthTokens)
    .set({ usedAt: clock.now() })
    .where(and(eq(oauthTokens.id, row.id), isNull(oauthTokens.usedAt)))
    .returning({ id: oauthTokens.id });
  if (!claimed) {
    await revokeGrantById(grant.id, "refresh token reuse detected");
    throw new OAuthError("invalid_grant", "refresh token already used");
  }
  // a member removed from the workspace cannot keep refreshing
  if (!(await memberOf(grant.userId, grant.workspaceId))) {
    await revokeGrantById(grant.id, "user no longer a member");
    throw new OAuthError("invalid_grant", "grant no longer valid");
  }
  return issuePair(grant.id, scopes, row.resource);
}

/** RFC 7009. Revoking a refresh token revokes the grant; an access token just itself. */
export async function revokePresentedToken(token: string, clientId: string | undefined): Promise<void> {
  const [row] = await db
    .select()
    .from(oauthTokens)
    .where(eq(oauthTokens.tokenHash, hashSecret(token)));
  if (!row || row.kind === "code") return;
  const [grant] = await db.select().from(oauthGrants).where(eq(oauthGrants.id, row.grantId));
  if (!grant || (clientId && grant.clientId !== clientId)) return;
  if (row.kind === "refresh") {
    await revokeGrantById(grant.id, "token revoked by client", grant.userId);
  } else {
    await db
      .update(oauthTokens)
      .set({ revokedAt: clock.now() })
      .where(and(eq(oauthTokens.id, row.id), isNull(oauthTokens.revokedAt)));
  }
}

// ── resource-server side: resolve an access token ───────────────────────

export interface OAuthAccess {
  tokenId: string;
  grantId: string;
  userId: string;
  userName: string;
  agentId: string;
  agentName: string;
  workspaceId: string;
  workspaceSlug: string;
  scopes: string[];
  clientName: string;
}

/**
 * Validate an access token for the MCP resource: unexpired, unrevoked, grant
 * live, issued for THIS resource, and the consenting user still a member of
 * the grant's workspace. Returns null for any failure (callers answer 401).
 */
export async function accessFromToken(token: string): Promise<OAuthAccess | null> {
  if (!isOAuthAccessToken(token)) return null;
  const [row] = await db
    .select({
      tokenId: oauthTokens.id,
      resource: oauthTokens.resource,
      scopes: oauthTokens.scopes,
      grantId: oauthGrants.id,
      userId: oauthGrants.userId,
      userName: users.name,
      agentId: oauthGrants.agentId,
      agentName: agents.name,
      workspaceId: oauthGrants.workspaceId,
      workspaceSlug: workspaces.slug,
      clientName: oauthGrants.clientName,
    })
    .from(oauthTokens)
    .innerJoin(oauthGrants, eq(oauthGrants.id, oauthTokens.grantId))
    .innerJoin(users, eq(users.id, oauthGrants.userId))
    .innerJoin(agents, eq(agents.id, oauthGrants.agentId))
    .innerJoin(workspaces, eq(workspaces.id, oauthGrants.workspaceId))
    .where(
      and(
        eq(oauthTokens.tokenHash, hashSecret(token)),
        eq(oauthTokens.kind, "access"),
        isNull(oauthTokens.revokedAt),
        isNull(oauthGrants.revokedAt),
        gt(oauthTokens.expiresAt, clock.now()),
      ),
    );
  if (!row) return null;
  if (normalizeResource(row.resource) !== RESOURCE) return null;
  if (!(await memberOf(row.userId, row.workspaceId))) return null;
  void db
    .update(oauthGrants)
    .set({ lastUsedAt: clock.now() })
    .where(eq(oauthGrants.id, row.grantId))
    .catch(() => undefined);
  return row;
}

// ── grant management (Agents & keys UI + API) ───────────────────────────

export async function listGrants(workspaceId: string, onlyUserId: string | null) {
  const rows = await db
    .select({
      id: oauthGrants.id,
      clientName: oauthGrants.clientName,
      clientId: oauthGrants.clientId,
      scopes: oauthGrants.scopes,
      agentId: oauthGrants.agentId,
      userId: oauthGrants.userId,
      userName: users.name,
      lastUsedAt: oauthGrants.lastUsedAt,
      createdAt: oauthGrants.createdAt,
    })
    .from(oauthGrants)
    .innerJoin(users, eq(users.id, oauthGrants.userId))
    .where(
      and(
        eq(oauthGrants.workspaceId, workspaceId),
        isNull(oauthGrants.revokedAt),
        onlyUserId ? eq(oauthGrants.userId, onlyUserId) : sql`true`,
      ),
    )
    .orderBy(oauthGrants.createdAt);
  return rows;
}

export async function grantInWorkspace(grantId: string, workspaceId: string) {
  const [g] = await db
    .select()
    .from(oauthGrants)
    .where(and(eq(oauthGrants.id, grantId), eq(oauthGrants.workspaceId, workspaceId)));
  return g ?? null;
}
