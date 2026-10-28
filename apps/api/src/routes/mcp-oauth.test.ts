import { createHash, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { app } from "../index.js";
import { closeDb, db } from "../db/client.js";
import { runMigrations } from "../db/migrate.js";
import {
  agents,
  events,
  issues,
  oauthGrants,
  oauthTokens,
  teams,
  users,
  workspaceMembers,
  workspaces,
} from "../db/schema.js";
import { createRateLimiter } from "../lib/rate-limit.js";
import { createSession, hashPassword } from "../services/auth.js";
import {
  ACCESS_TTL_S,
  CODE_TTL_MS,
  INTERNAL_HEADER,
  ISSUER,
  RESOURCE,
  hashSecret,
  internalHeaderValue,
  isPrivateUseScheme,
  setClientMetadataFetcher,
  validRedirectUri,
} from "../services/mcp-oauth.js";
import { NOW, useFrozenClock } from "../../test/clock.js";
import { buildMcpOAuthRoutes, PRM_URL } from "./mcp-oauth.js";

useFrozenClock();

const REDIRECT = "https://claude.example/api/mcp/auth_callback";
const WEB = "http://localhost:3100";

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

let cookieA = ""; // owner of workspace A
let cookieMember = ""; // plain member of A
let cookieB = ""; // owner of workspace B only
let wsA = "";
let wsB = "";
let userA = "";

async function seedUser(email: string, name: string) {
  const [u] = await db
    .insert(users)
    .values({ email, name, passwordHash: hashPassword("password-1234") })
    .returning();
  return u!;
}

beforeAll(async () => {
  await runMigrations();
  const [a] = await db.insert(workspaces).values({ slug: "mcp-a", name: "Alpha" }).returning();
  const [b] = await db.insert(workspaces).values({ slug: "mcp-b", name: "Beta" }).returning();
  wsA = a!.id;
  wsB = b!.id;
  await db.insert(teams).values([
    { workspaceId: wsA, key: "AAA", name: "A team" },
    { workspaceId: wsB, key: "BBB", name: "B team" },
  ]);
  const ua = await seedUser("a@mcp.test", "Alice");
  const um = await seedUser("m@mcp.test", "Mallory Member");
  const ub = await seedUser("b@mcp.test", "Bob");
  userA = ua.id;
  await db.insert(workspaceMembers).values([
    { workspaceId: wsA, userId: ua.id, role: "owner" },
    { workspaceId: wsA, userId: um.id, role: "member" },
    { workspaceId: wsB, userId: ub.id, role: "owner" },
  ]);
  cookieA = `tly_session=${await createSession(ua.id, wsA)}`;
  cookieMember = `tly_session=${await createSession(um.id, wsA)}`;
  cookieB = `tly_session=${await createSession(ub.id, wsB)}`;
});

afterEach(() => {
  vi.setSystemTime(NOW);
  setClientMetadataFetcher(null);
});

afterAll(async () => {
  await closeDb();
});

const get = (path: string, init: RequestInit = {}) =>
  app.fetch(new Request(`http://api.test${path}`, init));

// test bodies are asserted field by field; a loose type keeps that readable
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

async function jsonOf(res: Response) {
  return (await res.json()) as Json;
}

async function register(redirectUris = [REDIRECT]) {
  const res = await get("/oauth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "Claude", redirect_uris: redirectUris }),
  });
  expect(res.status).toBe(201);
  return (await jsonOf(res)).client_id as string;
}

function authorizeUrl(clientId: string, challenge: string, extra: Record<string, string> = {}) {
  const q = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: RESOURCE,
    scope: "read write",
    state: "st-123",
    ...extra,
  });
  return `/oauth/authorize?${q}`;
}

async function startRequest(clientId: string, challenge: string, extra: Record<string, string> = {}) {
  const res = await get(authorizeUrl(clientId, challenge, extra));
  expect(res.status).toBe(302);
  const loc = new URL(res.headers.get("location")!);
  expect(loc.origin + loc.pathname).toBe(`${WEB}/oauth/consent`);
  return loc.searchParams.get("request")!;
}

async function view(requestId: string, cookie = cookieA) {
  const res = await get(`/v1/oauth/consent/${requestId}`, { headers: { cookie } });
  return { res, body: await jsonOf(res) };
}

async function decide(
  requestId: string,
  csrf: string,
  body: Record<string, unknown>,
  cookie = cookieA,
) {
  const res = await get(`/v1/oauth/consent/${requestId}`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ csrf, ...body }),
  });
  return { res, body: await jsonOf(res) };
}

async function tokenRequest(params: Record<string, string>) {
  const res = await get("/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  return { res, body: await jsonOf(res) };
}

interface Connected {
  clientId: string;
  verifier: string;
  code: string;
  requestId: string;
}

/** authorize + consent approve; returns the unredeemed code */
async function approve(opts: {
  workspace?: string;
  scopes?: string[];
  cookie?: string;
  clientId?: string;
} = {}): Promise<Connected> {
  const clientId = opts.clientId ?? (await register());
  const { verifier, challenge } = pkce();
  const requestId = await startRequest(clientId, challenge);
  const v = await view(requestId, opts.cookie);
  const d = await decide(
    requestId,
    v.body.csrf,
    { approve: true, workspace: opts.workspace ?? "mcp-a", scopes: opts.scopes ?? ["read", "write"] },
    opts.cookie,
  );
  expect(d.res.status).toBe(200);
  const redirect = new URL(d.body.redirectTo);
  expect(redirect.origin + redirect.pathname).toBe(REDIRECT);
  expect(redirect.searchParams.get("state")).toBe("st-123");
  expect(redirect.searchParams.get("iss")).toBe(ISSUER);
  return { clientId, verifier, code: redirect.searchParams.get("code")!, requestId };
}

async function redeem(c: Connected, over: Record<string, string> = {}) {
  return tokenRequest({
    grant_type: "authorization_code",
    code: c.code,
    client_id: c.clientId,
    redirect_uri: REDIRECT,
    code_verifier: c.verifier,
    resource: RESOURCE,
    ...over,
  });
}

async function connect(opts: Parameters<typeof approve>[0] = {}) {
  const c = await approve(opts);
  const t = await redeem(c);
  expect(t.res.status).toBe(200);
  return { ...c, tokens: t.body as { access_token: string; refresh_token: string; scope: string; expires_in: number } };
}

let rpcId = 0;
async function mcp(token: string | null, method: string, params: unknown = {}, headers: Record<string, string> = {}) {
  const res = await get("/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  const text = await res.text();
  let body: Json = {};
  try {
    body = JSON.parse(text);
  } catch {
    /* non-json */
  }
  return { res, body };
}

const INIT = {
  protocolVersion: "2025-11-25",
  capabilities: {},
  clientInfo: { name: "test", version: "0" },
};

describe("oauth discovery metadata", () => {
  it("serves RFC 9728 protected resource metadata at both well-known forms", async () => {
    for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
      const res = await get(path);
      expect(res.status).toBe(200);
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
      const body = await jsonOf(res);
      expect(body.resource).toBe(RESOURCE);
      expect(body.authorization_servers).toEqual([ISSUER]);
      expect(body.scopes_supported).toEqual(["read", "write"]);
    }
  });

  it("serves RFC 8414 metadata: S256-only PKCE, public clients, CIMD + DCR, RFC 9207 iss", async () => {
    const body = await jsonOf(await get("/.well-known/oauth-authorization-server"));
    expect(body.issuer).toBe(ISSUER);
    expect(body.code_challenge_methods_supported).toEqual(["S256"]);
    expect(body.token_endpoint_auth_methods_supported).toEqual(["none"]);
    expect(body.client_id_metadata_document_supported).toBe(true);
    expect(body.authorization_response_iss_parameter_supported).toBe(true);
    expect(body.grant_types_supported).toEqual(["authorization_code", "refresh_token"]);
    for (const k of ["authorization_endpoint", "token_endpoint", "registration_endpoint", "revocation_endpoint"]) {
      expect(String(body[k]).startsWith(ISSUER)).toBe(true);
    }
  });

  it("answers an unauthenticated /mcp call with 401 + resource_metadata challenge", async () => {
    const { res } = await mcp(null, "initialize", INIT);
    expect(res.status).toBe(401);
    const h = res.headers.get("www-authenticate")!;
    expect(h).toContain(`resource_metadata="${PRM_URL}"`);
    expect(h.startsWith("Bearer ")).toBe(true);
  });
});

describe("oauth dynamic client registration", () => {
  it("registers a public client", async () => {
    const res = await get("/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "Codex", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" }),
    });
    expect(res.status).toBe(201);
    const body = await jsonOf(res);
    expect(body.client_id).toMatch(/^tly_cli_/);
    expect(body.token_endpoint_auth_method).toBe("none");
    expect(body.client_secret).toBeUndefined();
  });

  it("rejects non-https non-loopback redirect URIs, fragments and client secrets", async () => {
    for (const body of [
      { redirect_uris: ["http://evil.example/cb"] },
      { redirect_uris: ["https://ok.example/cb#frag"] },
      { redirect_uris: ["javascript:alert(1)"] },
      { redirect_uris: ["data:text/html,hi"] },
      { redirect_uris: ["file:///etc/passwd"] },
      { redirect_uris: ["vbscript:x"] },
      { redirect_uris: ["myapp:/cb"] }, // no dot: not a reverse-domain scheme
      { redirect_uris: ["app.example.ios:/cb#frag"] },
      { redirect_uris: ["app.example.ios://user:pw@host/cb"] },
      { redirect_uris: [] },
      { redirect_uris: [REDIRECT], token_endpoint_auth_method: "client_secret_basic" },
      { redirect_uris: [REDIRECT], grant_types: ["password"] },
    ]) {
      const res = await get("/oauth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect((await jsonOf(res)).error).toBe("invalid_client_metadata");
    }
  });

  it("rate limits registration through the #93 limiter", async () => {
    const limited = new Hono().route(
      "/",
      buildMcpOAuthRoutes({ registerLimiter: createRateLimiter(2, { prefix: "t-reg" }) }),
    );
    const call = () =>
      limited.fetch(
        new Request("http://api.test/oauth/register", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ redirect_uris: [REDIRECT] }),
        }),
      );
    expect((await call()).status).toBe(201);
    expect((await call()).status).toBe(201);
    const third = await call();
    expect(third.status).toBe(429);
    expect(third.headers.get("retry-after")).toBeTruthy();
  });
});

describe("oauth authorize endpoint", () => {
  it("never redirects for an unknown client or unregistered redirect_uri (no open redirect)", async () => {
    const { challenge } = pkce();
    const unknown = await get(authorizeUrl("tly_cli_nope", challenge));
    expect(unknown.status).toBe(400);
    expect(unknown.headers.get("location")).toBeNull();

    const clientId = await register();
    for (const bad of [
      "https://evil.example/cb",
      `${REDIRECT}/extra`,
      `${REDIRECT}?x=1`,
      "https://claude.example/api/mcp/auth_callback.evil.example",
      "http://localhost:9999/cb",
    ]) {
      const res = await get(authorizeUrl(clientId, challenge, { redirect_uri: bad }));
      expect(res.status, bad).toBe(400);
      expect(res.headers.get("location"), bad).toBeNull();
    }
  });

  it("requires PKCE S256 — plain, missing and malformed challenges are rejected via redirect with iss", async () => {
    const clientId = await register();
    const { challenge } = pkce();
    for (const extra of [
      { code_challenge_method: "plain" },
      { code_challenge_method: "" },
      { code_challenge: "short" },
    ]) {
      const res = await get(authorizeUrl(clientId, challenge, extra));
      expect(res.status).toBe(302);
      const loc = new URL(res.headers.get("location")!);
      expect(loc.origin + loc.pathname).toBe(REDIRECT);
      expect(loc.searchParams.get("error")).toBe("invalid_request");
      expect(loc.searchParams.get("state")).toBe("st-123");
      expect(loc.searchParams.get("iss")).toBe(ISSUER);
    }
  });

  it("rejects a resource that is not this MCP server (invalid_target) and unknown scopes", async () => {
    const clientId = await register();
    const { challenge } = pkce();
    const wrong = await get(authorizeUrl(clientId, challenge, { resource: "https://other.example/mcp" }));
    expect(new URL(wrong.headers.get("location")!).searchParams.get("error")).toBe("invalid_target");
    const scope = await get(authorizeUrl(clientId, challenge, { scope: "admin" }));
    expect(new URL(scope.headers.get("location")!).searchParams.get("error")).toBe("invalid_scope");
    const type = await get(authorizeUrl(clientId, challenge, { response_type: "token" }));
    expect(new URL(type.headers.get("location")!).searchParams.get("error")).toBe("unsupported_response_type");
  });

  it("accepts RFC 8252 private-use schemes, matched exactly, and never loosens them", async () => {
    const native = "app.tallyline.ios:/oauth/callback";
    const clientId = await register([native]);
    const { challenge } = pkce();
    const ok = await get(authorizeUrl(clientId, challenge, { redirect_uri: native }));
    expect(ok.status).toBe(302);
    expect(ok.headers.get("location")).toContain("/oauth/consent");
    for (const other of [
      "app.tallyline.ios:/oauth/other",
      "app.tallyline.ios:/oauth/callback?x=1",
      "app.evil.ios:/oauth/callback",
    ]) {
      expect((await get(authorizeUrl(clientId, challenge, { redirect_uri: other }))).status, other).toBe(400);
    }
  });

  it("consent names the app scheme, not a host-looking suffix a malicious app could choose", async () => {
    const sneaky = "com.attacker.app://trusted.example/cb";
    const clientId = await register([sneaky, "app.tallyline.ios:/oauth/callback"]);
    const { challenge } = pkce();
    const a = await view(await startRequest(clientId, challenge, { redirect_uri: sneaky }));
    expect(a.body.redirectHost).toBe("com.attacker.app");
    const b = await view(await startRequest(clientId, challenge, { redirect_uri: "app.tallyline.ios:/oauth/callback" }));
    expect(b.body.redirectHost).toBe("app.tallyline.ios");
  });

  it("recognises reverse-domain private-use schemes only", async () => {
    expect(isPrivateUseScheme("app.tallyline.ios:")).toBe(true);
    expect(isPrivateUseScheme("javascript:")).toBe(false);
    expect(isPrivateUseScheme("http:")).toBe(false);
    expect(isPrivateUseScheme("com.example.app")).toBe(true);
    expect(validRedirectUri("com.example.app://callback")).toBe(true);
  });

  it("matches RFC 8252 loopback redirects without a registered port", async () => {
    const clientId = await register(["http://127.0.0.1/callback"]);
    const { challenge } = pkce();
    const ok = await get(authorizeUrl(clientId, challenge, { redirect_uri: "http://127.0.0.1:53124/callback" }));
    expect(ok.status).toBe(302);
    expect(ok.headers.get("location")).toContain("/oauth/consent");
    const wrongHost = await get(authorizeUrl(clientId, challenge, { redirect_uri: "http://localhost:53124/callback" }));
    expect(wrongHost.status).toBe(400);
    const wrongPath = await get(authorizeUrl(clientId, challenge, { redirect_uri: "http://127.0.0.1:53124/other" }));
    expect(wrongPath.status).toBe(400);
  });
});

describe("oauth client id metadata documents", () => {
  const CIMD = "https://client.example/oauth/metadata.json";
  const doc = (over: Record<string, unknown> = {}) =>
    JSON.stringify({
      client_id: CIMD,
      client_name: "Example Client",
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: "none",
      ...over,
    });

  it("resolves a CIMD client_id by fetching its document, and shows its name at consent", async () => {
    const fetcher = vi.fn(async () => ({ status: 200, body: doc(), cacheControl: "max-age=300" }));
    setClientMetadataFetcher(fetcher);
    const { challenge } = pkce();
    const requestId = await startRequest(CIMD, challenge);
    const v = await view(requestId);
    expect(v.body.client).toEqual({ id: CIMD, name: "Example Client", kind: "cimd" });
    expect(v.body.redirectHost).toBe("claude.example");
    // cached: a second authorize does not refetch
    await startRequest(CIMD, challenge);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("rejects documents whose client_id does not equal their URL, bad redirect URIs, non-200 and non-JSON", async () => {
    const { challenge } = pkce();
    const cases: Array<[string, { status: number; body: string }]> = [
      ["https://client.example/mismatch.json", { status: 200, body: doc() }],
      ["https://client.example/badredirect.json", { status: 200, body: JSON.stringify({ client_id: "https://client.example/badredirect.json", client_name: "x", redirect_uris: ["http://evil.example/cb"] }) }],
      ["https://client.example/missing.json", { status: 404, body: "" }],
      ["https://client.example/notjson.json", { status: 200, body: "<html>" }],
    ];
    for (const [url, resp] of cases) {
      setClientMetadataFetcher(async () => ({ ...resp, cacheControl: null }));
      const res = await get(authorizeUrl(url, challenge));
      expect(res.status, url).toBe(400);
      expect(res.headers.get("location"), url).toBeNull();
    }
  });

  it("refuses CIMD URLs without a path, over http, or with credentials before fetching anything", async () => {
    const fetcher = vi.fn();
    setClientMetadataFetcher(fetcher);
    const { challenge } = pkce();
    for (const url of ["https://client.example/", "https://user:pw@client.example/x.json", "https://client.example/a/../b.json"]) {
      const res = await get(authorizeUrl(url, challenge));
      expect(res.status, url).toBe(400);
    }
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("oauth consent screen API", () => {
  it("requires a human cookie session", async () => {
    const clientId = await register();
    const requestId = await startRequest(clientId, pkce().challenge);
    const anon = await get(`/v1/oauth/consent/${requestId}`);
    expect(anon.status).toBe(401);
  });

  it("lists the caller's workspaces and mints a CSRF token per view", async () => {
    const clientId = await register();
    const requestId = await startRequest(clientId, pkce().challenge);
    const v1 = await view(requestId);
    expect(v1.res.status).toBe(200);
    expect(v1.body.workspaces.map((w: { slug: string }) => w.slug)).toEqual(["mcp-a"]);
    expect(v1.body.scopes).toEqual(["read", "write"]);
    expect(v1.body.csrf).toBeTruthy();
    const v2 = await view(requestId);
    expect(v2.body.csrf).not.toBe(v1.body.csrf);
  });

  it("rejects a decision without the current CSRF token, or from a different user", async () => {
    const clientId = await register();
    const requestId = await startRequest(clientId, pkce().challenge);
    const v = await view(requestId);
    const stale = await decide(requestId, "not-the-token", { approve: true, workspace: "mcp-a" });
    expect(stale.res.status).toBe(403);
    const other = await decide(requestId, v.body.csrf, { approve: true, workspace: "mcp-a" }, cookieMember);
    expect(other.res.status).toBe(403);
    // the request survives failed attempts and can still be approved
    const ok = await decide(requestId, v.body.csrf, { approve: true, workspace: "mcp-a" });
    expect(ok.res.status).toBe(200);
  });

  it("is single use and cannot be redirected by the request body", async () => {
    const clientId = await register();
    const requestId = await startRequest(clientId, pkce().challenge);
    const v = await view(requestId);
    const d = await decide(requestId, v.body.csrf, {
      approve: true,
      workspace: "mcp-a",
      redirect_uri: "https://evil.example/steal",
      redirectUri: "https://evil.example/steal",
    });
    expect(d.res.status).toBe(200);
    expect(d.body.redirectTo.startsWith(REDIRECT)).toBe(true);
    const again = await decide(requestId, v.body.csrf, { approve: true, workspace: "mcp-a" });
    expect(again.res.status).toBe(404);
  });

  it("refuses a workspace the user is not a member of (cross-workspace denial at consent)", async () => {
    const clientId = await register();
    const requestId = await startRequest(clientId, pkce().challenge);
    const v = await view(requestId);
    const d = await decide(requestId, v.body.csrf, { approve: true, workspace: "mcp-b" });
    expect(d.res.status).toBe(403);
  });

  it("deny redirects with access_denied, state and iss, and issues nothing", async () => {
    const clientId = await register();
    const requestId = await startRequest(clientId, pkce().challenge);
    const v = await view(requestId);
    const d = await decide(requestId, v.body.csrf, { approve: false });
    const loc = new URL(d.body.redirectTo);
    expect(loc.searchParams.get("error")).toBe("access_denied");
    expect(loc.searchParams.get("state")).toBe("st-123");
    expect(loc.searchParams.get("iss")).toBe(ISSUER);
    expect(loc.searchParams.get("code")).toBeNull();
  });

  it("cannot grant scopes the client did not request", async () => {
    const clientId = await register();
    const requestId = await startRequest(clientId, pkce().challenge, { scope: "read" });
    const v = await view(requestId);
    const d = await decide(requestId, v.body.csrf, { approve: true, workspace: "mcp-a", scopes: ["read", "write"] });
    expect(d.res.status).toBe(400);
  });

  it("expires unanswered requests", async () => {
    const clientId = await register();
    const requestId = await startRequest(clientId, pkce().challenge);
    vi.setSystemTime(NOW + 11 * 60_000);
    const v = await view(requestId);
    expect(v.res.status).toBe(404);
  });
});

describe("oauth token endpoint", () => {
  it("completes the full authorization code + PKCE flow and stores tokens hashed", async () => {
    const c = await approve();
    const { res, body } = await redeem(c);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(body.token_type).toBe("Bearer");
    expect(body.expires_in).toBe(ACCESS_TTL_S);
    expect(body.scope).toBe("read write");
    expect(body.access_token).toMatch(/^tly_oat_/);
    expect(body.refresh_token).toMatch(/^tly_ort_/);
    // hashed at rest: the raw value is never in the table
    const rows = await db.select().from(oauthTokens);
    expect(rows.some((r) => r.tokenHash === hashSecret(body.access_token))).toBe(true);
    expect(rows.some((r) => r.tokenHash === body.access_token || r.tokenHash === body.refresh_token)).toBe(false);
    expect(rows.some((r) => r.tokenHash === c.code)).toBe(false);
  });

  it("rejects a wrong code_verifier and burns the code", async () => {
    const c = await approve();
    const bad = await redeem(c, { code_verifier: pkce().verifier });
    expect(bad.res.status).toBe(400);
    expect(bad.body.error).toBe("invalid_grant");
    // the correct verifier no longer works either: one attempt per code
    const retry = await redeem(c);
    expect(retry.body.error).toBe("invalid_grant");
  });

  it("rejects a missing verifier, a mismatched redirect_uri and a different client", async () => {
    const c = await approve();
    expect((await redeem(c, { code_verifier: "" })).body.error).toBe("invalid_request");
    const c2 = await approve();
    expect((await redeem(c2, { redirect_uri: "https://claude.example/other" })).body.error).toBe("invalid_grant");
    const c3 = await approve();
    const otherClient = await register();
    expect((await redeem(c3, { client_id: otherClient })).body.error).toBe("invalid_grant");
  });

  it("rejects a wrong resource at the token endpoint (invalid_target)", async () => {
    const c = await approve();
    const r = await redeem(c, { resource: "https://other.example/mcp" });
    expect(r.res.status).toBe(400);
    expect(r.body.error).toBe("invalid_target");
  });

  it("a replayed authorization code is refused and revokes the tokens it produced", async () => {
    const c = await approve();
    const first = await redeem(c);
    expect(first.res.status).toBe(200);
    const live = await mcp(first.body.access_token, "initialize", INIT);
    expect(live.res.status).toBe(200);
    const replay = await redeem(c);
    expect(replay.res.status).toBe(400);
    expect(replay.body.error).toBe("invalid_grant");
    const after = await mcp(first.body.access_token, "initialize", INIT);
    expect(after.res.status).toBe(401);
    const refresh = await tokenRequest({
      grant_type: "refresh_token",
      refresh_token: first.body.refresh_token,
      client_id: c.clientId,
    });
    expect(refresh.body.error).toBe("invalid_grant");
  });

  it("expires authorization codes after 60 seconds", async () => {
    const c = await approve();
    vi.setSystemTime(NOW + CODE_TTL_MS + 1000);
    const r = await redeem(c);
    expect(r.body.error).toBe("invalid_grant");
  });

  it("rotates refresh tokens and detects reuse of a rotated token", async () => {
    const t = await connect();
    const r1 = await tokenRequest({ grant_type: "refresh_token", refresh_token: t.tokens.refresh_token, client_id: t.clientId });
    expect(r1.res.status).toBe(200);
    expect(r1.body.refresh_token).not.toBe(t.tokens.refresh_token);
    expect(r1.body.access_token).not.toBe(t.tokens.access_token);
    expect((await mcp(r1.body.access_token, "initialize", INIT)).res.status).toBe(200);
    // replaying the old refresh token = leak signal: grant dies, new tokens too
    const reuse = await tokenRequest({ grant_type: "refresh_token", refresh_token: t.tokens.refresh_token, client_id: t.clientId });
    expect(reuse.body.error).toBe("invalid_grant");
    expect((await mcp(r1.body.access_token, "initialize", INIT)).res.status).toBe(401);
    const afterReuse = await tokenRequest({ grant_type: "refresh_token", refresh_token: r1.body.refresh_token, client_id: t.clientId });
    expect(afterReuse.body.error).toBe("invalid_grant");
  });

  it("refresh cannot widen scope but can narrow it", async () => {
    const t = await connect({ scopes: ["read"] });
    const widen = await tokenRequest({ grant_type: "refresh_token", refresh_token: t.tokens.refresh_token, client_id: t.clientId, scope: "read write" });
    expect(widen.body.error).toBe("invalid_scope");
    const t2 = await connect();
    const narrow = await tokenRequest({ grant_type: "refresh_token", refresh_token: t2.tokens.refresh_token, client_id: t2.clientId, scope: "read" });
    expect(narrow.res.status).toBe(200);
    expect(narrow.body.scope).toBe("read");
  });

  it("refresh tokens are bound to their client", async () => {
    const t = await connect();
    const other = await register();
    const r = await tokenRequest({ grant_type: "refresh_token", refresh_token: t.tokens.refresh_token, client_id: other });
    expect(r.body.error).toBe("invalid_grant");
  });

  it("rejects unsupported grant types and clients without credentials", async () => {
    const t = await tokenRequest({ grant_type: "password", client_id: await register() });
    expect(t.body.error).toBe("unsupported_grant_type");
    const none = await tokenRequest({ grant_type: "authorization_code" });
    expect(none.res.status).toBe(401);
  });

  it("revokes via RFC 7009 (refresh token kills the grant) and always answers 200", async () => {
    const t = await connect();
    const res = await get("/oauth/revoke", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: t.tokens.refresh_token, client_id: t.clientId }),
    });
    expect(res.status).toBe(200);
    expect((await mcp(t.tokens.access_token, "initialize", INIT)).res.status).toBe(401);
    const unknown = await get("/oauth/revoke", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: "tly_oat_unknown" }),
    });
    expect(unknown.status).toBe(200);
  });
});

describe("remote MCP endpoint over Streamable HTTP", () => {
  it("serves initialize + tools/list + a tool call with a valid token", async () => {
    const t = await connect();
    const init = await mcp(t.tokens.access_token, "initialize", INIT);
    expect(init.res.status).toBe(200);
    expect(init.body.result.serverInfo.name).toBe("tallyline");
    expect(init.body.result.protocolVersion).toBe("2025-11-25");

    const list = await mcp(t.tokens.access_token, "tools/list");
    expect(list.res.status).toBe(200);
    const names = (list.body.result.tools as { name: string }[]).map((x) => x.name);
    expect(names).toContain("create_issue");
    expect(names).toContain("whoami");
    expect(names.length).toBeGreaterThanOrEqual(16);

    const who = await mcp(t.tokens.access_token, "tools/call", { name: "whoami", arguments: {} });
    expect(who.res.status).toBe(200);
    const identity = JSON.parse(who.body.result.content[0].text);
    expect(identity.type).toBe("agent");
    expect(identity.workspaceSlug).toBe("mcp-a");
    expect(identity.name).toContain("Claude via MCP");
    expect(identity.scopes).toEqual(["read", "write"]);

    const created = await mcp(t.tokens.access_token, "tools/call", {
      name: "create_issue",
      arguments: { title: "from a connector" },
    });
    expect(created.res.status).toBe(200);
    expect(created.body.result.isError).toBeFalsy();
    const issue = JSON.parse(created.body.result.content[0].text);
    expect(issue.key).toMatch(/^AAA-/);
    // provenance: the write is attributed to the connector agent, not anonymous
    const [row] = await db.select().from(issues).where(eq(issues.key, issue.key));
    expect(row!.creatorType).toBe("agent");
    const [agent] = await db.select().from(agents).where(eq(agents.id, row!.creatorId!));
    expect(agent!.harness).toBe("mcp-connector");
  });

  it("PLAN-056: an OAuth/MCP connector (agent identity) cannot approve or send back a review item", async () => {
    const t = await connect();
    const call = (name: string, args: Record<string, unknown>) =>
      mcp(t.tokens.access_token, "tools/call", { name, arguments: args });
    const created = await call("create_issue", { title: "needs review" });
    const key = JSON.parse(created.body.result.content[0].text).key as string;
    // agents may submit work for review
    for (const state of ["todo", "in_progress", "in_review"]) {
      const r = await call("update_issue", { key, state });
      expect(r.body.result.isError, state).toBeFalsy();
    }
    // but not approve (-> done) or send back (-> in_progress)
    for (const state of ["done", "in_progress"]) {
      const r = await call("update_issue", { key, state });
      expect(r.body.result.isError, state).toBe(true);
      expect(JSON.stringify(r.body.result.content)).toContain("FORBIDDEN_AGENT");
    }
    const c = await call("claim", { key });
    expect(c.body.result.isError).toBe(true);
    const [row] = await db.select().from(issues).where(eq(issues.key, key));
    expect(row!.state).toBe("in_review");
    // the underlying REST route is refused for the same token via the internal dispatch only,
    // and a bare OAuth token on /v1 is 401 (audience-bound)
    const direct = await get(`/v1/workspaces/mcp-a/issues/${key}/review`, {
      method: "POST",
      headers: { authorization: `Bearer ${t.tokens.access_token}`, "content-type": "application/json" },
      body: JSON.stringify({ action: "approve" }),
    });
    expect(direct.status).toBe(401);
  });

  it("is stateless: GET/DELETE are 405 and no session id is minted", async () => {
    const t = await connect();
    const init = await mcp(t.tokens.access_token, "initialize", INIT);
    expect(init.res.headers.get("mcp-session-id")).toBeNull();
    for (const method of ["GET", "DELETE"]) {
      const res = await get("/mcp", { method, headers: { authorization: `Bearer ${t.tokens.access_token}` } });
      expect(res.status).toBe(405);
    }
  });

  it("a read-only grant can read but gets 403 insufficient_scope on a write tool", async () => {
    const t = await connect({ scopes: ["read"] });
    expect(t.tokens.scope).toBe("read");
    const read = await mcp(t.tokens.access_token, "tools/call", { name: "list_issues", arguments: {} });
    expect(read.res.status).toBe(200);
    const write = await mcp(t.tokens.access_token, "tools/call", { name: "create_issue", arguments: { title: "nope" } });
    expect(write.res.status).toBe(403);
    const h = write.res.headers.get("www-authenticate")!;
    expect(h).toContain('error="insufficient_scope"');
    expect(h).toContain('scope="write"');
    expect(h).toContain(`resource_metadata="${PRM_URL}"`);
  });

  it("rejects expired access tokens with 401 invalid_token, and refresh recovers", async () => {
    const t = await connect();
    vi.setSystemTime(NOW + (ACCESS_TTL_S + 5) * 1000);
    const expired = await mcp(t.tokens.access_token, "tools/list");
    expect(expired.res.status).toBe(401);
    expect(expired.res.headers.get("www-authenticate")).toContain('error="invalid_token"');
    const r = await tokenRequest({ grant_type: "refresh_token", refresh_token: t.tokens.refresh_token, client_id: t.clientId });
    expect(r.res.status).toBe(200);
    expect((await mcp(r.body.access_token, "tools/list")).res.status).toBe(200);
  });

  it("rejects tokens bound to a different resource (wrong audience)", async () => {
    const t = await connect();
    await db
      .update(oauthTokens)
      .set({ resource: "https://other.example/mcp" })
      .where(eq(oauthTokens.tokenHash, hashSecret(t.tokens.access_token)));
    const res = await mcp(t.tokens.access_token, "tools/list");
    expect(res.res.status).toBe(401);
  });

  it("rejects foreign credentials at /mcp: PATs, agent keys and JWT-shaped tokens", async () => {
    for (const tok of ["tly_pat_abc", "tly_agt_abc", "eyJhbGciOiJIUzI1NiJ9.e30.sig"]) {
      const res = await mcp(tok, "tools/list");
      expect(res.res.status, tok).toBe(401);
    }
  });

  it("an OAuth access token is not accepted by the REST API directly (audience-bound to /mcp)", async () => {
    const t = await connect();
    const direct = await get("/v1/workspaces/mcp-a/issues", {
      headers: { authorization: `Bearer ${t.tokens.access_token}` },
    });
    expect(direct.status).toBe(401);
    const forged = await get("/v1/workspaces/mcp-a/issues", {
      headers: { authorization: `Bearer ${t.tokens.access_token}`, [INTERNAL_HEADER]: "guess" },
    });
    expect(forged.status).toBe(401);
  });

  it("cannot reach another workspace: the grant pins the workspace and the API enforces it", async () => {
    const t = await connect();
    // even with the in-process dispatch credential, workspace B is off limits
    const other = await get("/v1/workspaces/mcp-b/issues", {
      headers: { authorization: `Bearer ${t.tokens.access_token}`, [INTERNAL_HEADER]: internalHeaderValue },
    });
    expect(other.status).toBe(403);
    const own = await get("/v1/workspaces/mcp-a/issues", {
      headers: { authorization: `Bearer ${t.tokens.access_token}`, [INTERNAL_HEADER]: internalHeaderValue },
    });
    expect(own.status).toBe(200);
  });

  it("a token for workspace B only sees B's data over MCP", async () => {
    await db.insert(issues).values({
      workspaceId: wsB,
      teamId: (await db.select().from(teams).where(eq(teams.workspaceId, wsB)))[0]!.id,
      number: 1,
      key: "BBB-1",
      title: "beta secret",
      creatorType: "human",
    } as never);
    const tb = await connect({ workspace: "mcp-b", cookie: cookieB });
    const listB = await mcp(tb.tokens.access_token, "tools/call", { name: "list_issues", arguments: {} });
    expect(JSON.stringify(listB.body)).toContain("beta secret");
    const ta = await connect();
    const listA = await mcp(ta.tokens.access_token, "tools/call", { name: "list_issues", arguments: {} });
    expect(JSON.stringify(listA.body)).not.toContain("beta secret");
  });

  it("enforces the Origin allowlist (DNS rebinding guard) but accepts origin-less and allowed clients", async () => {
    const t = await connect();
    const bad = await mcp(t.tokens.access_token, "tools/list", {}, { origin: "https://evil.example" });
    expect(bad.res.status).toBe(403);
    const ok = await mcp(t.tokens.access_token, "tools/list", {}, { origin: "https://claude.ai" });
    expect(ok.res.status).toBe(200);
  });

  it("returns a JSON-RPC parse error for malformed bodies", async () => {
    const t = await connect();
    const res = await get("/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${t.tokens.access_token}`, "content-type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
    expect((await jsonOf(res)).error.code).toBe(-32700);
  });
});

describe("oauth grants: revocation and membership", () => {
  it("lists grants (own for members, all for admins) and revokes them; revoked tokens die at once", async () => {
    const ownerGrant = await connect();
    const memberGrant = await connect({ cookie: cookieMember });

    const asMember = await get("/v1/workspaces/mcp-a/oauth/grants", { headers: { cookie: cookieMember } });
    const memberList = (await jsonOf(asMember)).grants as { id: string; userName: string }[];
    expect(memberList.every((g) => g.userName === "Mallory Member")).toBe(true);

    const asOwner = await get("/v1/workspaces/mcp-a/oauth/grants", { headers: { cookie: cookieA } });
    const ownerList = (await jsonOf(asOwner)).grants as { id: string; userName: string; clientName: string }[];
    expect(ownerList.some((g) => g.userName === "Alice")).toBe(true);
    expect(ownerList.some((g) => g.userName === "Mallory Member")).toBe(true);

    // a member cannot revoke the owner's grant
    const ownerGrantRow = ownerList.find((g) => g.userName === "Alice")!;
    const denied = await get(`/v1/workspaces/mcp-a/oauth/grants/${ownerGrantRow.id}`, {
      method: "DELETE",
      headers: { cookie: cookieMember },
    });
    expect(denied.status).toBe(403);

    // an admin can revoke anyone's; access and refresh die immediately
    const memberRow = memberList[0]!;
    const del = await get(`/v1/workspaces/mcp-a/oauth/grants/${memberRow.id}`, {
      method: "DELETE",
      headers: { cookie: cookieA },
    });
    expect(del.status).toBe(200);
    expect((await mcp(memberGrant.tokens.access_token, "tools/list")).res.status).toBe(401);
    const refresh = await tokenRequest({
      grant_type: "refresh_token",
      refresh_token: memberGrant.tokens.refresh_token,
      client_id: memberGrant.clientId,
    });
    expect(refresh.body.error).toBe("invalid_grant");
    // the owner's own grant is untouched
    expect((await mcp(ownerGrant.tokens.access_token, "tools/list")).res.status).toBe(200);
  });

  it("users revoke their own grants; another workspace's owner cannot see or revoke them", async () => {
    const t = await connect();
    const [grant] = await db.select().from(oauthGrants).where(eq(oauthGrants.clientId, t.clientId));
    expect(grant!.userId).toBe(userA);
    const foreign = await get(`/v1/workspaces/mcp-a/oauth/grants/${grant!.id}`, {
      method: "DELETE",
      headers: { cookie: cookieB },
    });
    expect(foreign.status).toBe(403); // not a member of workspace A
    const own = await get(`/v1/workspaces/mcp-a/oauth/grants/${grant!.id}`, {
      method: "DELETE",
      headers: { cookie: cookieA },
    });
    expect(own.status).toBe(200);
    expect((await mcp(t.tokens.access_token, "tools/list")).res.status).toBe(401);
    const again = await get(`/v1/workspaces/mcp-a/oauth/grants/${grant!.id}`, {
      method: "DELETE",
      headers: { cookie: cookieA },
    });
    expect(again.status).toBe(404);
  });

  it("OAuth tokens and agent credentials cannot approve connectors or manage grants", async () => {
    const t = await connect();
    const clientId = await register();
    const requestId = await startRequest(clientId, pkce().challenge);
    const res = await get(`/v1/oauth/consent/${requestId}`, {
      headers: { authorization: `Bearer ${t.tokens.access_token}`, [INTERNAL_HEADER]: internalHeaderValue },
    });
    expect(res.status).toBe(403);
    const list = await get("/v1/workspaces/mcp-a/oauth/grants", {
      headers: { authorization: `Bearer ${t.tokens.access_token}`, [INTERNAL_HEADER]: internalHeaderValue },
    });
    expect(list.status).toBe(403);
  });

  it("a user removed from the workspace loses access immediately", async () => {
    const t = await connect({ cookie: cookieMember });
    expect((await mcp(t.tokens.access_token, "tools/list")).res.status).toBe(200);
    await db.delete(workspaceMembers).where(eq(workspaceMembers.role, "member"));
    expect((await mcp(t.tokens.access_token, "tools/list")).res.status).toBe(401);
    const r = await tokenRequest({ grant_type: "refresh_token", refresh_token: t.tokens.refresh_token, client_id: t.clientId });
    expect(r.body.error).toBe("invalid_grant");
  });

  it("writes audit events for grant creation, token issue and revocation", async () => {
    const t = await connect();
    const [grant] = await db
      .select()
      .from(oauthGrants)
      .where(eq(oauthGrants.clientId, t.clientId));
    await get(`/v1/workspaces/mcp-a/oauth/grants/${grant!.id}`, { method: "DELETE", headers: { cookie: cookieA } });
    const rows = await db.select().from(events).where(eq(events.entityId, grant!.id));
    const actions = rows.map((r) => r.action);
    expect(actions).toContain("oauth.grant.created");
    expect(actions).toContain("oauth.token.issued");
    expect(actions).toContain("oauth.grant.revoked");
    expect(rows.every((r) => r.entityType === "oauth_grant")).toBe(true);
    // no secret material in audit payloads
    expect(JSON.stringify(rows)).not.toContain("tly_o");
  });
});
