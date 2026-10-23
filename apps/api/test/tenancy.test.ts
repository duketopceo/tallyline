import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { pool } from "../src/db/client.js";
import { app } from "../src/index.js";
import { routeDiff } from "../src/lib/route-diff.js";
import { openApiDoc } from "../src/openapi.js";
import { OPERATIONS, type Caller, type CredName } from "./matrix-ops.js";
import { TENANT_JOIN_TABLES, TENANT_TABLES } from "../src/services/tenant-tables.js";
import { purgeWorkspace } from "../src/services/workspace-lifecycle.js";
import { newSession, seedEntities, seedTenant, type Entities, type Tenant } from "./tenants.js";

// PLAN-036: two-tenant isolation. A caller authenticated in workspace A must
// not read, list, update or delete anything in workspace B through ANY
// endpoint. Four independent angles:
//   1. coverage: every table with workspace_id is accounted for (or justified)
//   2. slug sweep: every {ws} operation, A credentials against B's slug
//   3. id sweep:  every id/key operation, B's real ids under A's own slug
//   4. leak sweep: every read endpoint under A's slug returns nothing of B's,
//      and cross-tenant references in A's writes are refused / never stored
// B's rows are fingerprinted around every mutating request: byte-identical
// afterwards or the test fails.

// table -> operations that read/list/update/delete it (all must be swept).
// `reason` marks tables with no tenant-reachable endpoint.
const TABLE_ENDPOINTS: Record<string, { ops: string[]; reason?: string }> = {
  agent_keys: { ops: ["GET /v1/workspaces/{ws}/agents/{id}/keys", "POST /v1/workspaces/{ws}/agents/{id}/keys"] },
  agents: { ops: ["GET /v1/workspaces/{ws}/agents", "POST /v1/workspaces/{ws}/agents", "POST /v1/workspaces/{ws}/agents/{id}/keys"] },
  auth_providers: {
    ops: [],
    reason:
      "instance-scoped (workspace_id is NULL in v1, column reserved); only reachable via /v1/auth/providers, which is instance-admin-only and covered by the permission matrix",
  },
  comments: { ops: ["GET /v1/workspaces/{ws}/issues/{key}/comments", "POST /v1/workspaces/{ws}/issues/{key}/comments", "GET /v1/workspaces/{ws}/issues/{key}"] },
  cycle_velocity: { ops: ["POST /v1/workspaces/{ws}/cycles/{id}/complete", "GET /v1/workspaces/{ws}/insights"] },
  cycles: {
    ops: [
      "GET /v1/workspaces/{ws}/cycles",
      "GET /v1/workspaces/{ws}/cycles/{id}",
      "PATCH /v1/workspaces/{ws}/cycles/{id}",
      "DELETE /v1/workspaces/{ws}/cycles/{id}",
      "POST /v1/workspaces/{ws}/cycles/{id}/complete",
    ],
  },
  agent_activities: { ops: ["GET /v1/workspaces/{ws}/agent-sessions/{id}", "POST /v1/workspaces/{ws}/agent-sessions/{id}/activities"] },
  agent_sessions: { ops: ["GET /v1/workspaces/{ws}/issues/{key}/agent-sessions", "GET /v1/workspaces/{ws}/agent-sessions/{id}", "POST /v1/workspaces/{ws}/agent-sessions/{id}/activities", "PATCH /v1/workspaces/{ws}/agent-sessions/{id}"] },
  dispatch_events: { ops: ["GET /v1/workspaces/{ws}/dispatches/{id}/events", "POST /v1/workspaces/{ws}/dispatches/{id}/events", "GET /v1/workspaces/{ws}/issues/{key}/sessions"] },
  dispatches: {
    ops: [
      "GET /v1/workspaces/{ws}/dispatches",
      "POST /v1/workspaces/{ws}/dispatches/{id}/report",
      "GET /v1/workspaces/{ws}/review-queue",
      "GET /v1/workspaces/{ws}/review-queue/count",
      "GET /v1/workspaces/{ws}/issues/{key}/sessions",
    ],
  },
  events: {
    ops: [
      "GET /v1/workspaces/{ws}/events",
      "GET /v1/workspaces/{ws}/events/stream",
      "GET /v1/workspaces/{ws}/issues/{key}/events",
      "GET /v1/workspaces/{ws}/insights",
    ],
  },
  github_installations: { ops: ["POST /v1/workspaces/{ws}/github/setup", "GET /v1/workspaces/{ws}/github/install-url"] },
  github_issue_links: { ops: ["POST /v1/workspaces/{ws}/import/github", "GET /v1/workspaces/{ws}/issues/{key}"] },
  github_repos: {
    ops: [
      "GET /v1/workspaces/{ws}/github/repos",
      "POST /v1/workspaces/{ws}/github/repos/connect",
      "POST /v1/workspaces/{ws}/github/repos/disconnect",
      "POST /v1/workspaces/{ws}/import/github",
    ],
  },
  invites: {
    ops: [
      "GET /v1/workspaces/{ws}/invites",
      "POST /v1/workspaces/{ws}/invites",
      "DELETE /v1/workspaces/{ws}/invites/{id}",
    ],
  },
  intake_events: { ops: ["POST /v1/workspaces/{ws}/intake"] },
  issue_external_refs: { ops: ["POST /v1/workspaces/{ws}/import/linear", "POST /v1/workspaces/{ws}/import/plan", "GET /v1/workspaces/{ws}/issues/{key}"] },
  notifications: {
    ops: [
      "GET /v1/workspaces/{ws}/notifications",
      "GET /v1/workspaces/{ws}/notifications/unread-count",
      "POST /v1/workspaces/{ws}/notifications/{id}/read",
      "POST /v1/workspaces/{ws}/notifications/read-all",
    ],
  },
  issues: {
    ops: [
      "GET /v1/workspaces/{ws}/issues",
      "POST /v1/workspaces/{ws}/issues",
      "GET /v1/workspaces/{ws}/issues/{key}",
      "PATCH /v1/workspaces/{ws}/issues/{key}",
      "POST /v1/workspaces/{ws}/issues/{key}/triage",
      "POST /v1/workspaces/{ws}/issues/{key}/review",
    ],
  },
  labels: {
    ops: [
      "GET /v1/workspaces/{ws}/labels",
      "POST /v1/workspaces/{ws}/labels",
      "PATCH /v1/workspaces/{ws}/labels/{id}",
      "DELETE /v1/workspaces/{ws}/labels/{id}",
    ],
  },
  oauth_grants: {
    ops: ["GET /v1/workspaces/{ws}/oauth/grants", "DELETE /v1/workspaces/{ws}/oauth/grants/{id}"],
  },
  oauth_codes: {
    ops: [],
    reason:
      "pre-session handoff codes, looked up only by sha256(code) in /v1/auth/oauth/exchange|link; the secret code, not a workspace id, is the key, and there is no list/read-by-id route",
  },
  project_milestones: {
    ops: [
      "GET /v1/workspaces/{ws}/milestones",
      "GET /v1/workspaces/{ws}/projects/{id}/milestones",
      "POST /v1/workspaces/{ws}/projects/{id}/milestones",
      "PATCH /v1/workspaces/{ws}/projects/{id}/milestones/{mid}",
      "DELETE /v1/workspaces/{ws}/projects/{id}/milestones/{mid}",
    ],
  },
  projects: {
    ops: [
      "GET /v1/workspaces/{ws}/projects",
      "POST /v1/workspaces/{ws}/projects",
      "PATCH /v1/workspaces/{ws}/projects/{id}",
      "DELETE /v1/workspaces/{ws}/projects/{id}",
    ],
  },
  sessions: { ops: ["POST /v1/auth/session"] },
  slack_links: {
    ops: ["GET /v1/workspaces/{ws}/issues/{key}/slack-link", "DELETE /v1/workspaces/{ws}/issues/{key}/slack-link"],
  },
  teams: {
    ops: ["GET /v1/workspaces/{ws}/teams", "POST /v1/workspaces/{ws}/teams", "PATCH /v1/workspaces/{ws}/teams/{id}"],
  },
  usage_daily: { ops: ["GET /v1/workspaces/{ws}/usage"] },
  user_tokens: {
    ops: ["GET /v1/workspaces/{ws}/tokens", "POST /v1/workspaces/{ws}/tokens", "DELETE /v1/workspaces/{ws}/tokens/{id}"],
  },
  views: {
    ops: [
      "GET /v1/workspaces/{ws}/views",
      "POST /v1/workspaces/{ws}/views",
      "PATCH /v1/workspaces/{ws}/views/{id}",
      "DELETE /v1/workspaces/{ws}/views/{id}",
    ],
  },
  webhook_deliveries: { ops: ["GET /v1/workspaces/{ws}/webhook-endpoints/{id}/deliveries"] },
  webhook_endpoints: {
    ops: [
      "GET /v1/workspaces/{ws}/webhook-endpoints",
      "POST /v1/workspaces/{ws}/webhook-endpoints",
      "PATCH /v1/workspaces/{ws}/webhook-endpoints/{id}",
      "DELETE /v1/workspaces/{ws}/webhook-endpoints/{id}",
    ],
  },
  workspace_members: {
    ops: [
      "GET /v1/workspaces/{ws}/members",
      "PATCH /v1/workspaces/{ws}/members/{id}",
      "DELETE /v1/workspaces/{ws}/members/{id}",
    ],
  },
};

// tables WITHOUT a workspace_id column, and why each is tenant-safe
const UNSCOPED_TABLES: Record<string, string> = {
  workspaces: "the tenant root itself; reached only through requireWorkspace (membership/credential check)",
  users: "global identities (one person can be in many workspaces); exposed only via workspace_members joins",
  auth_identities: "per-user SSO links, global by (provider, subject); no workspace-facing route",
  user_id_map: "forensic audit trail of the 0019 duplicate-email merge; no route reads it",
  issue_labels: "join table covered through its parent issue/label (both tenant-scoped); reads go through GET issues/{key}",
  team_members: "join table covered through its parent team (tenant-scoped); no direct route",
  oauth_clients:
    "global registry of public MCP OAuth clients (DCR rows and cached client-metadata documents); holds only client name + redirect URIs, never tenant data, and no route lists or reads it",
  oauth_requests:
    "short-lived pending MCP authorization requests keyed by an unguessable uuid, bound to the viewing user's session + CSRF token; the workspace is chosen and membership-checked only at the decision, which writes the tenant-scoped oauth_grants row",
  oauth_tokens:
    "MCP authorization codes / access / refresh tokens, stored as sha256 hashes and always attached to an oauth_grants row (tenant-scoped, ON DELETE CASCADE); only resolved by hash at /oauth/token and /mcp, never listed",
  account_tokens:
    "single-use password-reset / email-verify tokens, user-scoped (sha256 at rest); only resolved by hash at /v1/auth/password/reset and /v1/auth/verify-email, never listed",
  audit_events:
    "account-level security log (reset, verify, export, deletion) keyed by user id with no email or names; included only in that user's own /v1/me/export",
  github_webhook_events:
    "global GitHub delivery log keyed by X-GitHub-Delivery: HMAC-authenticated inbound only, deduped, never returned by any route; tenant routing happens later via github_installations/github_repos",
};

const ATTACKERS = ["owner", "agent_write", "pat_write"] as const;
type Attacker = (typeof ATTACKERS)[number];

let A: Tenant;
let B: Tenant;
let EA: Entities;
let EB: Entities;
let tenantTables: string[] = [];

async function authFor(t: Tenant, kind: Attacker): Promise<Record<string, string>> {
  if (kind === "owner") return { cookie: `tly_session=${await newSession(t, "owner")}` };
  if (kind === "agent_write") return { authorization: `Bearer ${t.agentKeys.write}` };
  return { authorization: `Bearer ${t.pats.write}` };
}

async function call(
  built: { method: string; path: string; body?: unknown; rawBody?: string; headers?: Record<string, string> },
  headers: Record<string, string>,
): Promise<{ status: number; code: string | undefined; text: string }> {
  const res = await app.fetch(
    new Request(`http://tenancy.test${built.path}`, {
      method: built.method,
      headers: {
        ...(built.body === undefined && built.rawBody === undefined ? {} : { "content-type": "application/json" }),
        ...headers,
        ...built.headers,
      },
      ...(built.rawBody !== undefined
        ? { body: built.rawBody }
        : built.body !== undefined
          ? { body: JSON.stringify(built.body) }
          : {}),
    }),
  );
  if ((res.headers.get("content-type") ?? "").includes("text/event-stream")) {
    await res.body?.cancel();
    return { status: res.status, code: undefined, text: "" };
  }
  const text = await res.text();
  let code: string | undefined;
  try {
    code = (JSON.parse(text) as { error?: { code?: string } }).error?.code;
  } catch {
    /* not json */
  }
  return { status: res.status, code, text };
}

/** per-table (count, md5) of every row of a tenant, to prove nothing changed */
async function fingerprint(t: Tenant): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const table of tenantTables) {
    if (table === "auth_providers") continue; // instance scoped
    const { rows } = await pool.query(
      `select count(*)::int as n,
              coalesce(md5(string_agg(x::text, '|' order by x::text)), '') as h
         from "${table}" x where workspace_id = $1`,
      [t.ws.id],
    );
    out[table] = `${rows[0].n}:${rows[0].h}`;
  }
  // tenant-owned rows hanging off tables without workspace_id
  const members = await pool.query(
    `select count(*)::int n, coalesce(md5(string_agg(x::text,'|' order by x::text)),'') h
       from issue_labels x where issue_id in (select id from issues where workspace_id=$1)`,
    [t.ws.id],
  );
  out.issue_labels = `${members.rows[0].n}:${members.rows[0].h}`;
  const ws = await pool.query(`select md5(x::text) h from workspaces x where id=$1`, [t.ws.id]);
  out.workspaces = ws.rows[0]?.h ?? "gone";
  return out;
}

async function idsOf(t: Tenant): Promise<string[]> {
  const ids = new Set<string>([t.ws.id]);
  for (const table of tenantTables) {
    if (table === "auth_providers") continue;
    const { rows } = await pool.query(`select id::text as id from "${table}" where workspace_id = $1`, [t.ws.id]);
    // uuids only: bigserial ids ("1", "2") would match any digit in a body
    for (const r of rows) if (/^[0-9a-f-]{36}$/.test(r.id)) ids.add(r.id);
  }
  for (const p of Object.values(t.people)) {
    ids.add(p.id);
    ids.add(p.memberRowId);
  }
  return [...ids];
}

beforeAll(async () => {
  vi.stubGlobal("fetch", async () => {
    throw new Error("network disabled in tenancy test");
  });
  const { rows } = await pool.query(
    `select table_name from information_schema.columns
      where column_name = 'workspace_id' and table_schema = 'public'
      group by 1 order by 1`,
  );
  tenantTables = rows.map((r) => r.table_name as string);
  A = await seedTenant("a", "AAA");
  B = await seedTenant("b", "BBB");
  EA = await seedEntities(A);
  EB = await seedEntities(B);
});

afterAll(() => {
  vi.unstubAllGlobals();
});

describe("tenancy: static coverage", () => {
  it("accounts for every table that has a workspace_id column", () => {
    const missing = tenantTables.filter((t) => !(t in TABLE_ENDPOINTS));
    const stale = Object.keys(TABLE_ENDPOINTS).filter((t) => !tenantTables.includes(t));
    expect(missing, "tenant-scoped tables with no entry in TABLE_ENDPOINTS").toEqual([]);
    expect(stale, "TABLE_ENDPOINTS entries for tables that no longer have workspace_id").toEqual([]);
    expect(tenantTables.length).toBe(33);
  });

  it("the export/purge table list (src/services/tenant-tables.ts) is exactly the tenant tables", () => {
    expect(Object.keys(TENANT_TABLES).sort()).toEqual(tenantTables);
    for (const [table, p] of Object.entries(TENANT_TABLES)) {
      if (!p.export) expect(p.reason, `${table} is excluded from export without a reason`).toBeTruthy();
    }
    for (const table of Object.keys(TENANT_JOIN_TABLES)) expect(UNSCOPED_TABLES[table]).toBeTruthy();
  });

  it("every table either lists swept endpoints or justifies having none", () => {
    const registered = new Set(routeDiff(app, openApiDoc).impl);
    for (const [table, { ops, reason }] of Object.entries(TABLE_ENDPOINTS)) {
      if (ops.length === 0) {
        expect(reason, `${table} has no endpoints and no justification`).toBeTruthy();
        continue;
      }
      for (const op of ops) {
        expect(registered.has(op), `${table}: ${op} is not a registered route`).toBe(true);
        expect(OPERATIONS[op], `${table}: ${op} has no request builder`).toBeDefined();
      }
    }
  });

  it("justifies every table without a workspace_id column (new unscoped tables force a decision)", async () => {
    const { rows } = await pool.query(
      `select table_name from information_schema.tables
        where table_schema = 'public' and table_type = 'BASE TABLE'
          and table_name not in (
            select table_name from information_schema.columns where column_name = 'workspace_id')
        order by 1`,
    );
    expect(rows.map((r) => r.table_name as string)).toEqual(Object.keys(UNSCOPED_TABLES).sort());
  });

  it("seeds a row in every tenant-scoped table for both tenants (non-vacuous)", async () => {
    for (const t of [A, B]) {
      for (const table of tenantTables) {
        if (table === "auth_providers") continue;
        const { rows } = await pool.query(`select count(*)::int n from "${table}" where workspace_id = $1`, [t.ws.id]);
        expect(rows[0].n, `${t.label}.${table}`).toBeGreaterThan(0);
      }
    }
    expect(EA.issue.id).not.toBe(EB.issue.id);
  });
});

const wsOps = Object.keys(OPERATIONS).filter((op) => op.includes("{ws}"));
const idOps = wsOps.filter((op) => /\{(id|key|mid)\}/.test(op));

describe("tenancy: slug sweep (A credentials against B's workspace)", () => {
  it.each(wsOps.flatMap((op) => ATTACKERS.map((who) => ({ op, who }))))(
    "$op as A/$who -> 403",
    async ({ op, who }) => {
      const victim: Caller = { name: "owner" as CredName, userId: B.people.owner.id };
      const built = await OPERATIONS[op]!(B, victim);
      const before = await fingerprint(B);
      const r = await call(built, await authFor(A, who));
      expect(r.status, `${op} as A/${who}: ${r.status} ${r.code}`).toBe(403);
      expect(r.text).not.toContain(B.sentinel);
      expect(await fingerprint(B), "B changed").toEqual(before);
    },
  );
});

describe("tenancy: id sweep (B's ids under A's own workspace)", () => {
  it.each(idOps.flatMap((op) => ATTACKERS.map((who) => ({ op, who }))))(
    "$op as A/$who -> refused",
    async ({ op, who }) => {
      const victim: Caller = { name: "owner" as CredName, userId: B.people.owner.id };
      const built = await OPERATIONS[op]!(B, victim);
      const path = built.path.replace(`/v1/workspaces/${B.ws.slug}/`, `/v1/workspaces/${A.ws.slug}/`);
      expect(path).not.toBe(built.path);
      const before = await fingerprint(B);
      const r = await call({ ...built, path }, await authFor(A, who));
      const label = `${op} as A/${who}: ${r.status} ${r.code}`;
      if (built.method === "GET" && r.status === 200) {
        // a scoped query that matches nothing (e.g. B's agent id filtered by
        // A's workspace) is fine as long as it returns none of B's data
        for (const id of await idsOf(B)) expect(r.text, `${label} leaked ${id}`).not.toContain(id);
      } else {
        expect(r.status, label).toBeGreaterThanOrEqual(400);
        // 503 = feature disabled (LLM) before any lookup happens
        if (r.status >= 500) expect(r.status, label).toBe(503);
      }
      expect(r.text).not.toContain(B.sentinel);
      expect(await fingerprint(B), "B changed").toEqual(before);
    },
  );

  it("A cannot re-bind its session to B", async () => {
    const r = await call(
      { method: "POST", path: "/v1/auth/session", body: { workspaceSlug: B.ws.slug } },
      await authFor(A, "owner"),
    );
    expect(r.status).toBe(403);
    expect(r.code).toBe("FORBIDDEN_WORKSPACE");
  });
});

describe("tenancy: leak sweep (reads under A's own workspace)", () => {
  const readOps = wsOps.filter((op) => op.startsWith("GET ") && !op.endsWith("/events/stream"));

  it.each(readOps.flatMap((op) => ATTACKERS.map((who) => ({ op, who }))))(
    "$op as A/$who returns nothing of B's",
    async ({ op, who }) => {
      const bIds = await idsOf(B);
      const caller: Caller = { name: "owner" as CredName, userId: A.people.owner.id };
      const built = await OPERATIONS[op]!(A, caller);
      const r = await call(built, await authFor(A, who));
      if (r.status === 403) return; // cookie-only routes for delegated credentials
      if (r.status >= 500) expect(r.status, `${op}: ${r.status} ${r.code}`).toBe(503); // integration not configured
      expect(r.text).not.toContain(B.sentinel);
      expect(r.text).not.toContain(`${B.team.key}-`);
      for (const id of bIds) expect(r.text, `${op} leaked ${id}`).not.toContain(id);
    },
  );

  it("is symmetric: B sees nothing of A's", async () => {
    const aIds = await idsOf(A);
    for (const op of readOps) {
      const built = await OPERATIONS[op]!(B, { name: "owner" as CredName, userId: B.people.owner.id });
      const r = await call(built, await authFor(B, "owner"));
      expect(r.text, op).not.toContain(A.sentinel);
      for (const id of aIds) expect(r.text, `${op} leaked ${id}`).not.toContain(id);
    }
  });
});

describe("tenancy: cross-tenant references in A's writes", () => {
  const ws = () => `/v1/workspaces/${A.ws.slug}`;
  // each probe is a write under A's slug that smuggles one of B's ids
  const probes: {
    name: string;
    table: string;
    /** the request may succeed (B's id is ignored/filtered) but must not store or return it */
    mayIgnore?: true;
    build: () => { method: string; path: string; body?: unknown };
  }[] = [
    { name: "issue in B's project", table: "issues", build: () => ({ method: "POST", path: `${ws()}/issues`, body: { title: "x", projectId: EB.project.id } }) },
    { name: "issue in B's cycle", table: "issues", build: () => ({ method: "POST", path: `${ws()}/issues`, body: { title: "x", cycleId: EB.cycle.id } }) },
    { name: "issue under B's parent", table: "issues", build: () => ({ method: "POST", path: `${ws()}/issues`, body: { title: "x", parentId: EB.issue.id } }) },
    { name: "issue assigned to B's user", table: "issues", build: () => ({ method: "POST", path: `${ws()}/issues`, body: { title: "x", assigneeType: "human", assigneeId: B.people.member.id } }) },
    { name: "issue assigned to B's agent", table: "issues", build: () => ({ method: "POST", path: `${ws()}/issues`, body: { title: "x", assigneeType: "agent", assigneeId: B.agent.id } }) },
    { name: "issue with B's label", table: "issue_labels", mayIgnore: true, build: () => ({ method: "POST", path: `${ws()}/issues`, body: { title: "x", labelIds: [EB.label.id] } }) },
    { name: "issue in B's team key", table: "issues", build: () => ({ method: "POST", path: `${ws()}/issues`, body: { title: "x", teamKey: B.team.key } }) },
    { name: "patch A issue to B's project", table: "issues", build: () => ({ method: "PATCH", path: `${ws()}/issues/${EA.issue.key}`, body: { projectId: EB.project.id } }) },
    { name: "patch A issue to B's cycle", table: "issues", build: () => ({ method: "PATCH", path: `${ws()}/issues/${EA.issue.key}`, body: { cycleId: EB.cycle.id } }) },
    { name: "patch A issue parent to B's issue", table: "issues", build: () => ({ method: "PATCH", path: `${ws()}/issues/${EA.issue.key}`, body: { parentId: EB.issue.id } }) },
    { name: "patch A issue assignee to B's user", table: "issues", build: () => ({ method: "PATCH", path: `${ws()}/issues/${EA.issue.key}`, body: { assigneeType: "human", assigneeId: B.people.owner.id } }) },
    { name: "cycle for B's team key", table: "cycles", build: () => ({ method: "POST", path: `${ws()}/cycles`, body: { teamKey: B.team.key, startsAt: "2026-11-01T00:00:00.000Z", endsAt: "2026-11-14T00:00:00.000Z" } }) },
    { name: "project for B's team key", table: "projects", build: () => ({ method: "POST", path: `${ws()}/projects`, body: { name: "x", teamKey: B.team.key } }) },
    { name: "milestone on B's project", table: "project_milestones", build: () => ({ method: "POST", path: `${ws()}/projects/${EB.project.id}/milestones`, body: { title: "x" } }) },
    { name: "invite into B's team", table: "invites", build: () => ({ method: "POST", path: `${ws()}/invites`, body: { teamId: B.team.id } }) },
    { name: "key for B's agent", table: "agent_keys", build: () => ({ method: "POST", path: `${ws()}/agents/${B.agent.id}/keys`, body: { name: "k", scopes: ["read"] } }) },
    { name: "list B agent's keys", table: "agent_keys", mayIgnore: true, build: () => ({ method: "GET", path: `${ws()}/agents/${B.agent.id}/keys` }) },
    { name: "report B's dispatch", table: "dispatches", build: () => ({ method: "POST", path: `${ws()}/dispatches/${EB.dispatch.id}/report`, body: { outcome: "failed" } }) },
    { name: "append to B's dispatch log", table: "dispatch_events", build: () => ({ method: "POST", path: `${ws()}/dispatches/${EB.dispatch.id}/events`, body: { events: [{ kind: "note", message: "x" }] } }) },
    { name: "read B's dispatch log", table: "dispatch_events", build: () => ({ method: "GET", path: `${ws()}/dispatches/${EB.dispatch.id}/events` }) },
    { name: "read B's agent session", table: "agent_sessions", build: () => ({ method: "GET", path: `${ws()}/agent-sessions/${EB.agentSession.id}` }) },
    { name: "post activity to B's agent session", table: "agent_activities", build: () => ({ method: "POST", path: `${ws()}/agent-sessions/${EB.agentSession.id}/activities`, body: { content: { type: "prompt", body: "x" } } }) },
    { name: "patch B's agent session", table: "agent_sessions", build: () => ({ method: "PATCH", path: `${ws()}/agent-sessions/${EB.agentSession.id}`, body: { pullRequests: ["https://github.com/x/y/pull/9"] } }) },
    { name: "B's webhook deliveries", table: "webhook_deliveries", mayIgnore: true, build: () => ({ method: "GET", path: `${ws()}/webhook-endpoints/${EB.endpoint.id}/deliveries` }) },
    { name: "patch B's webhook endpoint", table: "webhook_endpoints", build: () => ({ method: "PATCH", path: `${ws()}/webhook-endpoints/${EB.endpoint.id}`, body: { enabled: false } }) },
    { name: "delete B's webhook endpoint", table: "webhook_endpoints", build: () => ({ method: "DELETE", path: `${ws()}/webhook-endpoints/${EB.endpoint.id}` }) },
    { name: "change B member's role", table: "workspace_members", build: () => ({ method: "PATCH", path: `${ws()}/members/${B.people.member.memberRowId}`, body: { role: "owner" } }) },
    { name: "remove B's member", table: "workspace_members", build: () => ({ method: "DELETE", path: `${ws()}/members/${B.people.member.memberRowId}` }) },
    { name: "revoke B's invite", table: "invites", build: () => ({ method: "DELETE", path: `${ws()}/invites/${EB.invite.id}` }) },
    { name: "revoke B owner's token", table: "user_tokens", build: () => ({ method: "DELETE", path: `${ws()}/tokens/${EB.token.id}` }) },
    { name: "edit B's view", table: "views", build: () => ({ method: "PATCH", path: `${ws()}/views/${EB.view.id}`, body: { name: "hijacked" } }) },
    { name: "delete B's view", table: "views", build: () => ({ method: "DELETE", path: `${ws()}/views/${EB.view.id}` }) },
    { name: "delete B's project", table: "projects", build: () => ({ method: "DELETE", path: `${ws()}/projects/${EB.project.id}` }) },
    { name: "complete B's cycle", table: "cycles", build: () => ({ method: "POST", path: `${ws()}/cycles/${EB.cycle.id}/complete` }) },
    { name: "rename B's team", table: "teams", build: () => ({ method: "PATCH", path: `${ws()}/teams/${B.team.id}`, body: { name: "hijacked" } }) },
    { name: "unlink B's slack thread", table: "slack_links", build: () => ({ method: "DELETE", path: `${ws()}/issues/${EB.issue.key}/slack-link` }) },
    { name: "comment on B's issue", table: "comments", build: () => ({ method: "POST", path: `${ws()}/issues/${EB.issue.key}/comments`, body: { body: "x" } }) },
    { name: "triage B's issue", table: "issues", build: () => ({ method: "POST", path: `${ws()}/issues/${EB.triageIssue.key}/triage`, body: { action: "decline" } }) },
    { name: "approve B's review", table: "issues", build: () => ({ method: "POST", path: `${ws()}/issues/${EB.reviewIssue.key}/review`, body: { action: "approve" } }) },
    { name: "connect B's team to a repo", table: "github_repos", build: () => ({ method: "POST", path: `${ws()}/github/repos/connect`, body: { fullName: "acme/x", teamKey: B.team.key } }) },
    { name: "disconnect B's repo", table: "github_repos", build: () => ({ method: "POST", path: `${ws()}/github/repos/disconnect`, body: { fullName: EB.github.repo.fullName } }) },
    { name: "linear import into B's team", table: "issue_external_refs", build: () => ({ method: "POST", path: `${ws()}/import/linear`, body: { teamKey: B.team.key, csv: "ID,Title,Status\nL-1,x,Todo\n" } }) },
    { name: "plan import into B's project", table: "issues", build: () => ({ method: "POST", path: `${ws()}/import/plan`, body: { project: EB.project.id, plan: { scope: "XT", source: { repo: "o/r", path: "p.md", sha: "abc1234" }, markdown: "# P\n\n### U1. Imported unit\n\n**Goal:** g\n" } } }) },
    { name: "plan import into B's team key", table: "issues", build: () => ({ method: "POST", path: `${ws()}/import/plan`, body: { project: EA.project.id, teamKey: B.team.key, plan: { scope: "XT", source: { repo: "o/r", path: "p.md", sha: "abc1234" }, markdown: "# P\n\n### U1. Imported unit\n\n**Goal:** g\n" } } }) },
    { name: "plan import resolving to B's issue", table: "issue_external_refs", build: () => ({ method: "POST", path: `${ws()}/import/plan`, body: { project: EA.project.id, plan: { scope: "XT", source: { repo: "o/r", path: "p.md", sha: "abc1234" }, markdown: "# P\n\n### U1. Imported unit\n\n**Goal:** g\n" }, resolutions: { "XT-U1": EB.issue.key } } }) },
    { name: "bind B's github installation", table: "github_installations", build: () => ({ method: "POST", path: `${ws()}/github/setup`, body: { installationId: EB.github.installation.installationId } }) },
  ];

  it("covers every tenant table that has endpoints", () => {
    const probed = new Set(probes.map((p) => p.table));
    for (const table of ["issues", "issue_labels", "cycles", "projects", "project_milestones", "invites", "agent_keys", "dispatches", "dispatch_events", "agent_sessions", "agent_activities", "webhook_deliveries", "webhook_endpoints", "workspace_members", "user_tokens", "views", "teams", "slack_links", "comments", "github_repos", "issue_external_refs", "github_installations"]) {
      expect(probed.has(table), table).toBe(true);
    }
  });

  it.each(probes.flatMap((p) => ATTACKERS.map((who) => ({ p, who, name: p.name }))))(
    "$name as A/$who is refused and leaves B untouched",
    async ({ p, who }) => {
      const before = await fingerprint(B);
      const r = await call(p.build(), await authFor(A, who));
      const label = `${p.name}: ${r.status} ${r.code}`;
      if (p.mayIgnore && r.status < 300) {
        expect(r.text).not.toContain(B.sentinel);
        for (const id of await idsOf(B)) expect(r.text, `${label} leaked ${id}`).not.toContain(id);
      } else {
        expect(r.status, label).toBeGreaterThanOrEqual(400);
        // 503 = integration not configured (GitHub App), refused before any lookup
        if (r.status >= 500) expect(r.status, label).toBe(503);
      }
      expect(await fingerprint(B), "B changed").toEqual(before);
    },
  );

  it("after every probe, no A row references any of B's ids", async () => {
    const bIds = await idsOf(B);
    for (const table of tenantTables) {
      if (table === "auth_providers") continue;
      const { rows } = await pool.query(
        `select count(*)::int n from "${table}" x where workspace_id = $1 and x::text like any($2)`,
        [A.ws.id, bIds.map((id) => `%${id}%`)],
      );
      expect(rows[0].n, `${table} rows in A reference B ids`).toBe(0);
    }
    const labels = await pool.query(
      `select count(*)::int n from issue_labels il
         join issues i on i.id = il.issue_id
        where i.workspace_id = $1 and il.label_id in (select id from labels where workspace_id = $2)`,
      [A.ws.id, B.ws.id],
    );
    expect(labels.rows[0].n, "A issues carry B labels").toBe(0);
  });
});

describe("tenancy: workspace export and hard delete", () => {
  it("A's export holds every exportable row of A, redacts credentials, and nothing of B", async () => {
    const r = await call({ method: "GET", path: `/v1/workspaces/${A.ws.slug}/export` }, await authFor(A, "owner"));
    expect(r.status).toBe(200);
    const doc = JSON.parse(r.text) as {
      workspace: { id: string };
      tables: Record<string, Record<string, unknown>[]>;
      attachments: { count: number; items: unknown[] };
      counts: Record<string, number>;
    };
    expect(doc.workspace.id).toBe(A.ws.id);
    expect(doc.attachments).toEqual({ count: 0, items: [] });
    for (const [table, policy] of Object.entries(TENANT_TABLES)) {
      if (!policy.export) {
        expect(doc.tables[table], `${table} must not be exported`).toBeUndefined();
        continue;
      }
      const { rows } = await pool.query(`select count(*)::int n from "${table}" where workspace_id = $1`, [A.ws.id]);
      expect(doc.tables[table]?.length, `${table} row count`).toBe(rows[0].n);
      expect(rows[0].n, `${table} seeded`).toBeGreaterThan(0);
      for (const col of policy.redact ?? []) {
        for (const row of doc.tables[table]!) expect(row[col], `${table}.${col}`).toBe("[redacted]");
      }
    }
    expect(doc.tables.issue_labels!.length).toBeGreaterThan(0);
    // no credential material at all
    const secrets = await pool.query(
      `select token_hash v from user_tokens where workspace_id = $1
       union all select token_hash from agent_keys where workspace_id = $1
       union all select token_hash from invites where workspace_id = $1
       union all select token_hash from sessions where workspace_id = $1
       union all select secret from webhook_endpoints where workspace_id = $1`,
      [A.ws.id],
    );
    for (const { v } of secrets.rows) expect(r.text).not.toContain(v);
    expect(r.text).not.toContain(B.sentinel);
    for (const id of await idsOf(B)) expect(r.text, `export leaked ${id}`).not.toContain(id);
  });

  it("purging a third tenant removes every one of its rows and leaves A and B byte-identical", async () => {
    const C = await seedTenant("c", "CCC");
    const EC = await seedEntities(C);
    expect(EC.issue.id).toBeTruthy();
    const issueIds = (await pool.query(`select id from issues where workspace_id = $1`, [C.ws.id])).rows.map((r) => r.id);
    const teamIds = (await pool.query(`select id from teams where workspace_id = $1`, [C.ws.id])).rows.map((r) => r.id);
    const beforeA = await fingerprint(A);
    const beforeB = await fingerprint(B);

    await purgeWorkspace(C.ws.id);

    for (const table of tenantTables) {
      const { rows } = await pool.query(`select count(*)::int n from "${table}" where workspace_id = $1`, [C.ws.id]);
      expect(rows[0].n, `${table} rows left for purged tenant`).toBe(0);
    }
    const il = await pool.query(`select count(*)::int n from issue_labels where issue_id = any($1::uuid[])`, [issueIds]);
    expect(il.rows[0].n).toBe(0);
    const tm = await pool.query(`select count(*)::int n from team_members where team_id = any($1::uuid[])`, [teamIds]);
    expect(tm.rows[0].n).toBe(0);
    const ws = await pool.query(`select count(*)::int n from workspaces where id = $1`, [C.ws.id]);
    expect(ws.rows[0].n).toBe(0);
    // people are global identities: they survive, without the membership
    const people = await pool.query(`select count(*)::int n from users where id = $1`, [C.people.owner.id]);
    expect(people.rows[0].n).toBe(1);

    expect(await fingerprint(A)).toEqual(beforeA);
    expect(await fingerprint(B)).toEqual(beforeB);
  });
});
