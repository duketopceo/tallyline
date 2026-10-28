import { randomBytes, randomInt } from "node:crypto";
import { db } from "../src/db/client.js";
import { deviceAuthorizations } from "../src/db/schema.js";
import { consentView, registerClient } from "../src/services/mcp-oauth.js";
import { createAuthRequest, RESOURCE } from "../src/services/mcp-oauth.js";
import {
  mkAgent,
  mkAgentSession,
  mkCycle,
  mkDelivery,
  mkDispatch,
  mkEndpoint,
  mkInvite,
  mkIssue,
  mkLabel,
  mkMember,
  mkMilestone,
  mkNotification,
  mkOauthGrant,
  mkProject,
  mkProvider,
  mkRelation,
  mkSuggestion,
  mkToken,
  mkView,
  PASSWORD,
  type Tenant,
} from "./tenants.js";

// Request builders, one per OpenAPI operation. Each builds a *valid* request
// against fresh rows in tenant `t` (so validation never masks authorization
// and destructive operations always have a real target). The permission
// matrix runs these once per credential; the tenancy suite re-uses them with
// foreign ids.

export const CREDENTIALS = [
  "anonymous",
  "member",
  "admin",
  "owner",
  "agent_read",
  "agent_write",
  "pat_read",
  "pat_write",
  "outsider",
] as const;
export type CredName = (typeof CREDENTIALS)[number];

export interface Caller {
  name: CredName;
  /** the user behind the credential, when it has one */
  userId: string | null;
}

export interface Built {
  method: string;
  path: string;
  body?: unknown;
  rawBody?: string;
  headers?: Record<string, string>;
}

export type Builder = (t: Tenant, who: Caller) => Promise<Built>;

/** a live authorization request, already viewed by `userId` (csrf minted) */
async function pendingConsent(t: Tenant, userId: string | null) {
  const client = await registerClient({ redirect_uris: ["https://matrix.example/cb"] });
  const id = await createAuthRequest({
    clientId: client.client_id,
    redirectUri: "https://matrix.example/cb",
    scopes: ["read"],
    state: undefined,
    codeChallenge: "A".repeat(43),
    resource: RESOURCE,
  });
  const view = await consentView(id, userId ?? t.people.owner.id);
  return { id, csrf: view.csrf };
}

const u = () => randomBytes(4).toString("hex");
const base = (t: Tenant) => `/v1/workspaces/${t.ws.slug}`;
const letters = () =>
  Array.from(randomBytes(5), (b) => String.fromCharCode(65 + (b % 26))).join("");

const get = (p: (t: Tenant) => string): Builder => async (t) => ({ method: "GET", path: p(t) });
const simple =
  (method: string, p: (t: Tenant) => string, body?: unknown): Builder =>
  async (t) => ({ method, path: p(t), ...(body === undefined ? {} : { body }) });

const issueOp =
  (method: string, suffix: string, body?: unknown, over?: Parameters<typeof mkIssue>[1]): Builder =>
  async (t) => {
    const i = await mkIssue(t, over);
    return { method, path: `${base(t)}/issues/${i.key}${suffix}`, ...(body === undefined ? {} : { body }) };
  };

const projectOp =
  (method: string, suffix: string, body?: unknown): Builder =>
  async (t) => {
    const p = await mkProject(t);
    return { method, path: `${base(t)}/projects/${p.id}${suffix}`, ...(body === undefined ? {} : { body }) };
  };

const milestoneOp =
  (method: string, body?: unknown): Builder =>
  async (t) => {
    const p = await mkProject(t);
    const m = await mkMilestone(t, p.id);
    return { method, path: `${base(t)}/projects/${p.id}/milestones/${m.id}`, ...(body === undefined ? {} : { body }) };
  };

const cycleOp =
  (method: string, suffix: string, body?: unknown): Builder =>
  async (t) => {
    const c = await mkCycle(t);
    return { method, path: `${base(t)}/cycles/${c.id}${suffix}`, ...(body === undefined ? {} : { body }) };
  };

// views are per-user: the target view belongs to the caller
const viewOp =
  (method: string, body?: unknown): Builder =>
  async (t, who) => {
    const v = await mkView(t, who.userId ?? t.people.owner.id);
    return { method, path: `${base(t)}/views/${v.id}`, ...(body === undefined ? {} : { body }) };
  };

const labelOp =
  (method: string, body?: unknown): Builder =>
  async (t) => {
    const l = await mkLabel(t);
    return { method, path: `${base(t)}/labels/${l.id}`, ...(body === undefined ? {} : { body }) };
  };

// notifications are per-user: the row belongs to the calling user so
// mark-read resolves to a real target (200 for humans, 404 for cross-tenant ids)
const notificationOp =
  (method: string): Builder =>
  async (t, who) => {
    const n = await mkNotification(t, who.userId ?? t.people.owner.id);
    return { method, path: `${base(t)}/notifications/${n.id}/read` };
  };

const endpointOp =
  (method: string, suffix = "", body?: unknown): Builder =>
  async (t) => {
    const e = await mkEndpoint(t);
    return { method, path: `${base(t)}/webhook-endpoints/${e.id}${suffix}`, ...(body === undefined ? {} : { body }) };
  };

const dispatchOp =
  (method: string, suffix: string, body?: unknown): Builder =>
  async (t) => {
    const i = await mkIssue(t);
    const d = await mkDispatch(t, i.id);
    return { method, path: `${base(t)}/dispatches/${d.id}${suffix}`, ...(body === undefined ? {} : { body }) };
  };

const sessionOp =
  (method: string, suffix: string, body?: unknown): Builder =>
  async (t) => {
    const i = await mkIssue(t);
    const d = await mkDispatch(t, i.id);
    const s = await mkAgentSession(t, d.id, i.id);
    return { method, path: `${base(t)}/agent-sessions/${s.id}${suffix}`, ...(body === undefined ? {} : { body }) };
  };

/** a live device sign-in request, as the CLI would have started it */
async function mkDeviceRequest() {
  // inserted directly: starting through the service would trip the per-address cap
  const userCode = Array.from({ length: 8 }, () => "BCDFGHJKMNPQRSTVWXZ23456789"[randomInt(27)]).join("");
  await db.insert(deviceAuthorizations).values({
    deviceCodeHash: randomBytes(16).toString("hex"),
    userCode,
    clientName: "matrix cli",
    expiresAt: new Date(Date.now() + 600_000),
  });
  return { userCode: `${userCode.slice(0, 4)}-${userCode.slice(4)}` };
}

const providerOp =
  (method: string, suffix = "", body?: unknown): Builder =>
  async () => {
    const p = await mkProvider();
    return { method, path: `/v1/auth/providers/${p.id}${suffix}`, ...(body === undefined ? {} : { body }) };
  };

export const OPERATIONS: Record<string, Builder> = {
  // ── public / infrastructure ────────────────────────────────────────────────
  "GET /health": get(() => "/health"),
  "GET /openapi.json": get(() => "/openapi.json"),
  "GET /v1/auth/methods": get(() => "/v1/auth/methods"),
  "GET /v1/auth/oauth/{provider}/start": get(() => "/v1/auth/oauth/nope/start"),
  "GET /v1/auth/oauth/{provider}/callback": get(() => "/v1/auth/oauth/nope/callback?code=x&state=y"),
  "POST /v1/auth/oauth/exchange": simple("POST", () => "/v1/auth/oauth/exchange", { code: "no-such-code" }),
  "POST /v1/auth/oauth/link": simple("POST", () => "/v1/auth/oauth/link", { code: "no-such-code" }),
  "POST /v1/auth/accept-invite": simple("POST", () => "/v1/auth/accept-invite", { token: "no-such-invite" }),
  "POST /v1/auth/bootstrap": simple("POST", () => "/v1/auth/bootstrap", {
    workspaceSlug: "bootstrap-attempt",
    workspaceName: "x",
    teamKey: "BOO",
    email: "boot@matrix.test",
    name: "Boot",
    password: PASSWORD,
  }),
  "POST /v1/auth/login": async (t) => ({
    method: "POST",
    path: "/v1/auth/login",
    body: { email: t.people.member.email, password: PASSWORD },
  }),
  "POST /v1/auth/logout": simple("POST", () => "/v1/auth/logout"),
  "POST /v1/auth/device/code": simple("POST", () => "/v1/auth/device/code", { clientName: "matrix" }),
  "POST /v1/auth/device/token": simple("POST", () => "/v1/auth/device/token", {
    deviceCode: "no-such-device-code-0000000000",
  }),
  "GET /github/manifest/callback/{state}": get(() => "/github/manifest/callback/not-a-state?code=x"),
  "POST /webhooks/github": async () => ({
    method: "POST",
    path: "/webhooks/github",
    rawBody: "{}",
    headers: { "x-github-event": "ping", "x-github-delivery": `d-${u()}` },
  }),
  "POST /webhooks/slack": async () => ({
    method: "POST",
    path: "/webhooks/slack",
    rawBody: "{}",
    headers: { "x-slack-request-timestamp": "1", "x-slack-signature": "v0=bad" },
  }),

  // ── MCP remote endpoint + OAuth authorization server (PLAN-010/011) ───────
  "GET /.well-known/oauth-protected-resource": get(() => "/.well-known/oauth-protected-resource"),
  "GET /.well-known/oauth-protected-resource/mcp": get(() => "/.well-known/oauth-protected-resource/mcp"),
  "GET /.well-known/oauth-authorization-server": get(() => "/.well-known/oauth-authorization-server"),
  "GET /oauth/authorize": async () => ({ method: "GET", path: "/oauth/authorize?client_id=tly_cli_matrix" }),
  // a registered client, so the endpoint reaches grant handling (400) rather
  // than answering invalid_client (401, which the matrix reads as a denial)
  "POST /oauth/token": async () => ({
    method: "POST",
    path: "/oauth/token",
    rawBody: `grant_type=password&client_id=${
      (await registerClient({ redirect_uris: ["https://matrix.example/cb"] })).client_id
    }`,
    headers: { "content-type": "application/x-www-form-urlencoded" },
  }),
  "POST /oauth/register": async () => ({
    method: "POST",
    path: "/oauth/register",
    body: { client_name: "Matrix", redirect_uris: ["https://matrix.example/cb"] },
  }),
  "POST /oauth/revoke": async () => ({
    method: "POST",
    path: "/oauth/revoke",
    rawBody: "token=tly_ort_unknown",
    headers: { "content-type": "application/x-www-form-urlencoded" },
  }),
  "POST /mcp": async () => ({
    method: "POST",
    path: "/mcp",
    body: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
  }),
  "GET /mcp": get(() => "/mcp"),
  "DELETE /mcp": simple("DELETE", () => "/mcp"),
  "GET /v1/oauth/consent/{id}": async (t, who) => {
    const id = await pendingConsent(t, who.userId);
    return { method: "GET", path: `/v1/oauth/consent/${id.id}` };
  },
  "POST /v1/oauth/consent/{id}": async (t, who) => {
    const { id, csrf } = await pendingConsent(t, who.userId);
    return { method: "POST", path: `/v1/oauth/consent/${id}`, body: { approve: false, csrf } };
  },
  "GET /v1/workspaces/{ws}/oauth/grants": get((t) => `${base(t)}/oauth/grants`),
  "DELETE /v1/workspaces/{ws}/oauth/grants/{id}": async (t) => {
    // owned by the workspace owner: members are refused, admins may revoke
    const g = await mkOauthGrant(t, t.people.owner.id);
    return { method: "DELETE", path: `${base(t)}/oauth/grants/${g.id}` };
  },

  // ── session / identity ─────────────────────────────────────────────────────
  "GET /v1/auth/me": get(() => "/v1/auth/me"),
  "POST /v1/auth/session": async (t) => ({
    method: "POST",
    path: "/v1/auth/session",
    body: { workspaceSlug: t.ws.slug },
  }),
  "POST /v1/auth/token": simple("POST", () => "/v1/auth/token"),
  "GET /v1/whoami": get(() => "/v1/whoami"),

  // ── instance admin: providers ──────────────────────────────────────────────
  "GET /v1/auth/providers": get(() => "/v1/auth/providers"),
  "POST /v1/auth/providers": async () => ({
    method: "POST",
    path: "/v1/auth/providers",
    body: { key: `p-${u()}`, type: "github", label: "Matrix", clientId: "cid", clientSecret: "csecret" },
  }),
  "PATCH /v1/auth/providers/{id}": providerOp("PATCH", "", { label: "Renamed" }),
  "DELETE /v1/auth/providers/{id}": providerOp("DELETE"),
  "POST /v1/auth/providers/{id}/test": providerOp("POST", "/test"),

  // ── workspaces / teams ─────────────────────────────────────────────────────
  "POST /v1/workspaces": simple("POST", () => "/v1/workspaces", {
    slug: `created-${u()}`,
    name: "Created by matrix",
  }),
  "GET /v1/workspaces/{ws}": get(base),
  "PATCH /v1/workspaces/{ws}": simple("PATCH", base, { name: "Renamed workspace" }),
  "GET /v1/workspaces/{ws}/teams": get((t) => `${base(t)}/teams`),
  "POST /v1/workspaces/{ws}/teams": async (t) => ({
    method: "POST",
    path: `${base(t)}/teams`,
    body: { key: letters(), name: "New team" },
  }),
  "PATCH /v1/workspaces/{ws}/teams/{id}": async (t) => ({
    method: "PATCH",
    path: `${base(t)}/teams/${t.team.id}`,
    body: { name: "Renamed team" },
  }),

  // ── issues ─────────────────────────────────────────────────────────────────
  "GET /v1/workspaces/{ws}/issues": get((t) => `${base(t)}/issues`),
  "POST /v1/workspaces/{ws}/issues": simple("POST", (t) => `${base(t)}/issues`, { title: "Matrix issue" }),
  "POST /v1/workspaces/{ws}/intake": simple("POST", (t) => `${base(t)}/intake`, {
    kind: "error",
    title: "Matrix intake probe",
    externalId: `matrix-${Math.random().toString(36).slice(2)}`,
  }),
  "GET /v1/workspaces/{ws}/issues/{key}": issueOp("GET", ""),
  "PATCH /v1/workspaces/{ws}/issues/{key}": issueOp("PATCH", "", { title: "Edited" }),
  "GET /v1/workspaces/{ws}/issues/{key}/comments": issueOp("GET", "/comments"),
  "POST /v1/workspaces/{ws}/issues/{key}/comments": issueOp("POST", "/comments", { body: "hello" }),
  "POST /v1/workspaces/{ws}/issues/{key}/summarize": issueOp("POST", "/summarize"),
  "POST /v1/workspaces/{ws}/issues/{key}/triage-suggest": issueOp("POST", "/triage-suggest"),
  "POST /v1/workspaces/{ws}/issues/dup-check": simple("POST", (t) => `${base(t)}/issues/dup-check`, {
    title: "Matrix duplicate probe",
  }),
  "GET /v1/workspaces/{ws}/llm/status": get((t) => `${base(t)}/llm/status`),
  "GET /v1/workspaces/{ws}/issues/{key}/slack-link": issueOp("GET", "/slack-link"),
  "DELETE /v1/workspaces/{ws}/issues/{key}/slack-link": issueOp("DELETE", "/slack-link"),
  "GET /v1/workspaces/{ws}/issues/{key}/events": issueOp("GET", "/events"),
  "POST /v1/workspaces/{ws}/issues/{key}/triage": issueOp("POST", "/triage", { action: "accept" }, { state: "triage" }),
  "POST /v1/workspaces/{ws}/issues/{key}/review": issueOp("POST", "/review", { action: "approve" }, { state: "in_review" }),
  "GET /v1/workspaces/{ws}/issues/{key}/sessions": issueOp("GET", "/sessions"),
  "GET /v1/workspaces/{ws}/labels": get((t) => `${base(t)}/labels`),
  "POST /v1/workspaces/{ws}/labels": async (t) => ({
    method: "POST",
    path: `${base(t)}/labels`,
    body: { name: `label-${u()}`, color: "#112233" },
  }),
  "PATCH /v1/workspaces/{ws}/labels/{id}": labelOp("PATCH", { name: `renamed-${u()}` }),
  "DELETE /v1/workspaces/{ws}/labels/{id}": labelOp("DELETE"),

  // ── agents ─────────────────────────────────────────────────────────────────
  "GET /v1/workspaces/{ws}/agents": get((t) => `${base(t)}/agents`),
  "POST /v1/workspaces/{ws}/agents": async (t) => ({
    method: "POST",
    path: `${base(t)}/agents`,
    body: { name: `agent-${u()}`, harness: "test" },
  }),
  "GET /v1/workspaces/{ws}/agents/{id}/keys": async (t) => {
    const a = await mkAgent(t);
    return { method: "GET", path: `${base(t)}/agents/${a.id}/keys` };
  },
  "DELETE /v1/workspaces/{ws}/agents/{id}/keys/{keyId}": async (t) => {
    const a = await mkAgent(t);
    return {
      method: "DELETE",
      path: `${base(t)}/agents/${a.id}/keys/00000000-0000-4000-8000-000000000000`,
    };
  },
  "POST /v1/workspaces/{ws}/agents/{id}/keys/{keyId}/rotate": async (t) => {
    const a = await mkAgent(t);
    return {
      method: "POST",
      path: `${base(t)}/agents/${a.id}/keys/00000000-0000-4000-8000-000000000000/rotate`,
      body: {},
    };
  },
  "POST /v1/workspaces/{ws}/agents/{id}/keys": async (t) => {
    const a = await mkAgent(t);
    return { method: "POST", path: `${base(t)}/agents/${a.id}/keys`, body: { name: "k", scopes: ["read"] } };
  },

  // ── members / invites / tokens ─────────────────────────────────────────────
  "GET /v1/workspaces/{ws}/members": get((t) => `${base(t)}/members`),
  "PATCH /v1/workspaces/{ws}/members/{id}": async (t) => {
    const m = await mkMember(t);
    return { method: "PATCH", path: `${base(t)}/members/${m.memberRowId}`, body: { role: "admin" } };
  },
  "DELETE /v1/workspaces/{ws}/members/{id}": async (t) => {
    const m = await mkMember(t);
    return { method: "DELETE", path: `${base(t)}/members/${m.memberRowId}` };
  },
  "GET /v1/workspaces/{ws}/invites": get((t) => `${base(t)}/invites`),
  "POST /v1/workspaces/{ws}/invites": simple("POST", (t) => `${base(t)}/invites`, { role: "member" }),
  "DELETE /v1/workspaces/{ws}/invites/{id}": async (t) => {
    const i = await mkInvite(t, t.people.owner.id);
    return { method: "DELETE", path: `${base(t)}/invites/${i.id}` };
  },
  "GET /v1/workspaces/{ws}/tokens": get((t) => `${base(t)}/tokens`),
  "POST /v1/workspaces/{ws}/tokens": simple("POST", (t) => `${base(t)}/tokens`, {
    name: "matrix token",
    scopes: ["read"],
  }),
  "GET /v1/workspaces/{ws}/device/{userCode}": async (t) => ({
    method: "GET",
    path: `${base(t)}/device/${(await mkDeviceRequest()).userCode}`,
  }),
  "POST /v1/workspaces/{ws}/device/{userCode}": async (t) => ({
    method: "POST",
    path: `${base(t)}/device/${(await mkDeviceRequest()).userCode}`,
    body: { decision: "deny" },
  }),
  "POST /v1/workspaces/{ws}/devices/pairing": simple("POST", (t) => `${base(t)}/devices/pairing`, {}),
  "GET /v1/workspaces/{ws}/devices": get((t) => `${base(t)}/devices`),
  "DELETE /v1/workspaces/{ws}/devices/{id}": simple("DELETE", (t) => `${base(t)}/devices/00000000-0000-4000-8000-000000000000`),
  "DELETE /v1/workspaces/{ws}/devices/current": simple("DELETE", (t) => `${base(t)}/devices/current`),
  "POST /v1/workspaces/{ws}/devices/current/rotate": simple("POST", (t) => `${base(t)}/devices/current/rotate`, {}),
  "POST /v1/auth/pair/redeem": simple("POST", () => "/v1/auth/pair/redeem", {
    code: "tlpair_no-such-code-0000000000",
    deviceName: "matrix",
  }),
  "GET /v1/workspaces/{ws}/ai/provider": get((t) => `${base(t)}/ai/provider`),
  "PUT /v1/workspaces/{ws}/ai/provider": simple("PUT", (t) => `${base(t)}/ai/provider`, {
    kind: "openrouter",
    label: "Matrix OpenRouter",
    model: "openai/gpt-4o-mini",
    apiKey: "matrix-fake-credential-0000",
  }),
  "DELETE /v1/workspaces/{ws}/ai/provider": simple("DELETE", (t) => `${base(t)}/ai/provider`),
  "POST /v1/workspaces/{ws}/ai/provider/test": simple("POST", (t) => `${base(t)}/ai/provider/test`),
  "GET /v1/workspaces/{ws}/ai/usage": get((t) => `${base(t)}/ai/usage`),
  "GET /v1/workspaces/{ws}/system/status": get((t) => `${base(t)}/system/status`),
  "DELETE /v1/workspaces/{ws}/tokens/{id}": async (t, who) => {
    const tok = await mkToken(t, who.userId ?? t.people.owner.id);
    return { method: "DELETE", path: `${base(t)}/tokens/${tok.id}` };
  },

  // ── projects / milestones / cycles / views ────────────────────────────────
  "GET /v1/workspaces/{ws}/projects": get((t) => `${base(t)}/projects`),
  "POST /v1/workspaces/{ws}/projects": simple("POST", (t) => `${base(t)}/projects`, { name: "Matrix project" }),
  "PATCH /v1/workspaces/{ws}/projects/{id}": projectOp("PATCH", "", { name: "Renamed project" }),
  "DELETE /v1/workspaces/{ws}/projects/{id}": projectOp("DELETE", ""),
  "GET /v1/workspaces/{ws}/milestones": get((t) => `${base(t)}/milestones`),
  "GET /v1/workspaces/{ws}/projects/{id}/milestones": projectOp("GET", "/milestones"),
  "POST /v1/workspaces/{ws}/projects/{id}/milestones": projectOp("POST", "/milestones", { title: "M1" }),
  "GET /v1/workspaces/{ws}/projects/{id}/updates": projectOp("GET", "/updates"),
  "POST /v1/workspaces/{ws}/projects/{id}/updates": projectOp("POST", "/updates", { health: "on_track", body: "Matrix update" }),
  "GET /v1/workspaces/{ws}/projects/{id}/update-draft": projectOp("GET", "/update-draft"),
  "PATCH /v1/workspaces/{ws}/projects/{id}/milestones/{mid}": milestoneOp("PATCH", { title: "M1b" }),
  "DELETE /v1/workspaces/{ws}/projects/{id}/milestones/{mid}": milestoneOp("DELETE"),
  "GET /v1/workspaces/{ws}/cycles": get((t) => `${base(t)}/cycles`),
  "POST /v1/workspaces/{ws}/cycles": async (t) => ({
    method: "POST",
    path: `${base(t)}/cycles`,
    body: { teamKey: t.team.key, startsAt: "2026-11-01T00:00:00.000Z", endsAt: "2026-11-14T00:00:00.000Z" },
  }),
  "GET /v1/workspaces/{ws}/cycles/{id}": cycleOp("GET", ""),
  "PATCH /v1/workspaces/{ws}/cycles/{id}": cycleOp("PATCH", "", { name: "Renamed cycle" }),
  "DELETE /v1/workspaces/{ws}/cycles/{id}": cycleOp("DELETE", ""),
  "POST /v1/workspaces/{ws}/cycles/{id}/complete": cycleOp("POST", "/complete"),
  "GET /v1/workspaces/{ws}/views": get((t) => `${base(t)}/views`),
  "POST /v1/workspaces/{ws}/views": simple("POST", (t) => `${base(t)}/views`, {
    name: "Matrix view",
    filters: { state: "todo" },
  }),
  "PATCH /v1/workspaces/{ws}/views/{id}": viewOp("PATCH", { name: "Renamed view" }),
  "DELETE /v1/workspaces/{ws}/views/{id}": viewOp("DELETE"),

  // ── feeds ──────────────────────────────────────────────────────────────────
  "GET /v1/workspaces/{ws}/insights": get((t) => `${base(t)}/insights`),
  "GET /v1/workspaces/{ws}/roadmap/summary": get((t) => `${base(t)}/roadmap/summary`),
  "GET /v1/workspaces/{ws}/usage": get((t) => `${base(t)}/usage`),
  "GET /v1/workspaces/{ws}/events": get((t) => `${base(t)}/events`),
  "GET /v1/workspaces/{ws}/events/stream": get((t) => `${base(t)}/events/stream`),

  // ── dispatches / review ────────────────────────────────────────────────────
  "GET /v1/workspaces/{ws}/dispatches": get((t) => `${base(t)}/dispatches`),
  "GET /v1/workspaces/{ws}/review-queue": get((t) => `${base(t)}/review-queue`),
  "GET /v1/workspaces/{ws}/review-queue/count": get((t) => `${base(t)}/review-queue/count`),
  "POST /v1/workspaces/{ws}/dispatches/{id}/report": dispatchOp("POST", "/report", { outcome: "completed" }),
  "GET /v1/workspaces/{ws}/dispatches/{id}/events": dispatchOp("GET", "/events"),
  "POST /v1/workspaces/{ws}/dispatches/{id}/events": dispatchOp("POST", "/events", {
    events: [{ kind: "note", message: "progress" }],
  }),

  // ── agent sessions (plan L1) ───────────────────────────────────────────────
  "GET /v1/workspaces/{ws}/issues/{key}/agent-sessions": issueOp("GET", "/agent-sessions"),
  "GET /v1/workspaces/{ws}/agent-sessions/{id}": sessionOp("GET", ""),
  "POST /v1/workspaces/{ws}/agent-sessions/{id}/activities": sessionOp("POST", "/activities", {
    content: { type: "prompt", body: "carry on" },
  }),
  "PATCH /v1/workspaces/{ws}/agent-sessions/{id}": sessionOp("PATCH", "", {
    pullRequests: ["https://github.com/example/repo/pull/1"],
  }),

  // ── L4: suggestions, L5: relations, L6: workflows, L7: sync, L8: agent skills ──
  "PATCH /v1/workspaces/{ws}/agents": async (t) => {
    const a = await mkAgent(t);
    return {
      method: "PATCH",
      path: `${base(t)}/agents`,
      body: { id: a.id, skills: ["typescript"] },
    };
  },
  "PATCH /v1/workspaces/{ws}/agents/{id}": async (t) => {
    const a = await mkAgent(t);
    return {
      method: "PATCH",
      path: `${base(t)}/agents/${a.id}`,
      body: { skills: ["typescript"] },
    };
  },
  "GET /v1/workspaces/{ws}/issues/{key}/suggestions": issueOp("GET", "/suggestions"),
  "POST /v1/workspaces/{ws}/issues/{key}/suggestions": issueOp("POST", "/suggestions", {
    kind: "label",
    suggestedValue: "bug",
    reason: "matches title",
  }),
  "PATCH /v1/workspaces/{ws}/issues/{key}/suggestions/{sid}": async (t) => {
    const i = await mkIssue(t);
    const s = await mkSuggestion(t, i.id);
    return {
      method: "PATCH",
      path: `${base(t)}/issues/${i.key}/suggestions/${s.id}`,
      body: { state: "dismissed", dismissedReason: "not relevant" },
    };
  },
  "GET /v1/workspaces/{ws}/issues/{key}/relations": issueOp("GET", "/relations"),
  "POST /v1/workspaces/{ws}/issues/{key}/relations": async (t) => {
    const src = await mkIssue(t);
    const tgt = await mkIssue(t);
    return {
      method: "POST",
      path: `${base(t)}/issues/${src.key}/relations`,
      body: { targetIssueId: tgt.id, relationType: "related" },
    };
  },
  "DELETE /v1/workspaces/{ws}/issues/{key}/relations/{rid}": async (t) => {
    const src = await mkIssue(t);
    const tgt = await mkIssue(t);
    const r = await mkRelation(t, src.id, tgt.id);
    return {
      method: "DELETE",
      path: `${base(t)}/issues/${src.key}/relations/${r.id}`,
    };
  },
  "GET /v1/workspaces/{ws}/workflows": get((t) => `${base(t)}/workflows`),
  "POST /v1/workspaces/{ws}/workflows": async (t) => ({
    method: "POST",
    path: `${base(t)}/workflows`,
    body: {
      name: `wf-${u()}`,
      trigger: "issue.transition",
      condition: { to: "in_review" },
      action: { type: "comment", body: "automated check" },
    },
  }),
  "GET /v1/workspaces/{ws}/sync": get((t) => `${base(t)}/sync`),

  // ── github / import ────────────────────────────────────────────────────────
  "GET /v1/workspaces/{ws}/github/manifest": get((t) => `${base(t)}/github/manifest`),
  "GET /v1/workspaces/{ws}/github/install-url": get((t) => `${base(t)}/github/install-url`),
  "POST /v1/workspaces/{ws}/github/setup": simple("POST", (t) => `${base(t)}/github/setup`, { installationId: 424242 }),
  "GET /v1/workspaces/{ws}/github/repos": get((t) => `${base(t)}/github/repos`),
  "POST /v1/workspaces/{ws}/github/repos/connect": async (t) => ({
    method: "POST",
    path: `${base(t)}/github/repos/connect`,
    body: { fullName: `matrix/repo-${u()}` },
  }),
  "POST /v1/workspaces/{ws}/github/repos/disconnect": async (t) => ({
    method: "POST",
    path: `${base(t)}/github/repos/disconnect`,
    body: { fullName: `matrix/repo-${u()}` },
  }),
  "POST /v1/workspaces/{ws}/github/repos/project": async (t) => ({
    method: "POST",
    path: `${base(t)}/github/repos/project`,
    body: { fullName: `matrix/repo-${u()}`, projectId: null },
  }),
  "POST /v1/workspaces/{ws}/github/repos/backfill": async (t) => ({
    method: "POST",
    path: `${base(t)}/github/repos/backfill`,
    body: { map: {} },
  }),
  "POST /v1/workspaces/{ws}/issues/bulk": async (t) => ({
    method: "POST",
    path: `${base(t)}/issues/bulk`,
    body: { ids: [crypto.randomUUID()], projectId: null },
  }),
  "POST /v1/workspaces/{ws}/import/github": async (t) => ({
    method: "POST",
    path: `${base(t)}/import/github`,
    body: { fullName: "matrix/none", token: "not-a-real-token" },
  }),
  "POST /v1/workspaces/{ws}/import/linear": async (t) => ({
    method: "POST",
    path: `${base(t)}/import/linear`,
    body: { teamKey: t.team.key, csv: "ID,Title,Status\nL-1,Imported,Todo\n" },
  }),

  "POST /v1/workspaces/{ws}/import/plan": async (t) => {
    const project = await mkProject(t);
    return {
      method: "POST",
      path: `${base(t)}/import/plan`,
      body: {
        project: project.id,
        teamKey: t.team.key,
        plan: {
          scope: "MX",
          source: { repo: "o/r", path: "plan.md", sha: "abc1234" },
          markdown: "# P\n\n### U1. Imported unit\n\n**Goal:** g\n",
        },
      },
    };
  },

  // ── notifications ──────────────────────────────────────────────────────────
  "GET /v1/workspaces/{ws}/notifications": get((t) => `${base(t)}/notifications`),
  "GET /v1/workspaces/{ws}/notifications/unread-count": get((t) => `${base(t)}/notifications/unread-count`),
  "POST /v1/workspaces/{ws}/notifications/read-all": simple("POST", (t) => `${base(t)}/notifications/read-all`),
  "POST /v1/workspaces/{ws}/notifications/{id}/read": notificationOp("POST"),

  // ── outbound webhooks ──────────────────────────────────────────────────────
  "GET /v1/workspaces/{ws}/webhook-endpoints": get((t) => `${base(t)}/webhook-endpoints`),
  "POST /v1/workspaces/{ws}/webhook-endpoints": async (t) => ({
    method: "POST",
    path: `${base(t)}/webhook-endpoints`,
    body: { url: `http://127.0.0.1:9/hook-${u()}` },
  }),
  "PATCH /v1/workspaces/{ws}/webhook-endpoints/{id}": endpointOp("PATCH", "", { enabled: false }),
  "DELETE /v1/workspaces/{ws}/webhook-endpoints/{id}": endpointOp("DELETE"),
  "GET /v1/workspaces/{ws}/webhook-endpoints/{id}/deliveries": async (t) => {
    const e = await mkEndpoint(t);
    await mkDelivery(t, e.id);
    return { method: "GET", path: `${base(t)}/webhook-endpoints/${e.id}/deliveries` };
  },

  // ── glitchtip integration ──────────────────────────────────────────────────
  "GET /v1/workspaces/{ws}/glitchtip": get((t) => `${base(t)}/glitchtip`),
  "PUT /v1/workspaces/{ws}/glitchtip": async (t) => ({
    method: "PUT",
    path: `${base(t)}/glitchtip`,
    body: { projectMap: {}, enabled: true },
  }),
  "DELETE /v1/workspaces/{ws}/glitchtip": simple("DELETE", (t) => `${base(t)}/glitchtip`),
  "POST /v1/workspaces/{ws}/glitchtip/rotate": simple("POST", (t) => `${base(t)}/glitchtip/rotate`),
  "POST /webhooks/glitchtip/{token}": async () => ({
    method: "POST",
    path: "/webhooks/glitchtip/tly_gt_not-a-real-token",
    rawBody: "{}",
  }),

  // ── account lifecycle ──────────────────────────────────────────────────────
  // Destructive lifecycle ops carry a confirm that does NOT match, so an
  // authorized caller gets 400 CONFIRM_MISMATCH (authorization already passed)
  // and the shared tenant / its people survive the run. The real deletions are
  // exercised in src/routes/account.test.ts.
  "POST /v1/auth/password/forgot": async () => ({
    method: "POST",
    path: "/v1/auth/password/forgot",
    body: { email: `nobody-${u()}@matrix.test` },
  }),
  "POST /v1/auth/password/reset": simple("POST", () => "/v1/auth/password/reset", {
    token: "not-a-real-reset-token-0000",
    password: "matrix-password-123",
  }),
  "POST /v1/auth/verify-email": simple("POST", () => "/v1/auth/verify-email", {
    token: "not-a-real-verify-token-0000",
  }),
  "POST /v1/me/verify-email/resend": simple("POST", () => "/v1/me/verify-email/resend"),
  "GET /v1/me/export": get(() => "/v1/me/export"),
  "POST /v1/me/deletion": simple("POST", () => "/v1/me/deletion", { confirm: "not-the-account-email@matrix.test" }),
  "GET /v1/dev/mail": get(() => "/v1/dev/mail"),
  "GET /v1/workspaces/{ws}/export": get((t) => `${base(t)}/export`),
  "POST /v1/workspaces/{ws}/deletion": async (t) => ({
    method: "POST",
    path: `${base(t)}/deletion`,
    body: { confirm: `${t.ws.slug}-not-this-one` },
  }),
  "POST /v1/workspaces/{ws}/restore": simple("POST", (t) => `${base(t)}/restore`),
};

