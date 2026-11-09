import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../db/client.js";
import {
  events,
  glitchtipConnections,
  glitchtipIssues,
  glitchtipProjectLinks,
  issues,
} from "../db/schema.js";
import { config_ } from "../env.js";
import { app } from "../index.js";
import { MemoryRateStore } from "../lib/rate-limit.js";
import { resetClock, setClock } from "../services/clock.js";
import { getConnection, syncDueLinks } from "../services/glitchtip-sync.js";
import { glitchtipSyncLimiter } from "./glitchtip-feed.js";
import { mkProject, newSession, seedTenant, type Tenant } from "../../test/tenants.js";

// GlitchTip pull side. The database is real; only GlitchTip's HTTP API is
// faked, by a local server that records what it was asked.

const TOKEN = ["gt", "api", "token", "unit", "9f3a1c77"].join("-");
const T0 = Date.parse("2026-11-09T12:00:00.000Z");
const mutableConfig = config_ as unknown as { authSecretKey: string };
const savedSecret = mutableConfig.authSecretKey;

interface Seen {
  path: string;
  auth: string | undefined;
}

let server: Server;
let baseUrl = "";
let seen: Seen[] = [];
let handler: (req: IncomingMessage, res: ServerResponse) => void;

const issue = (id: number, over: Record<string, unknown> = {}) => ({
  id: String(id),
  shortId: `API-${id}`,
  title: `TypeError ${id}`,
  culprit: "app/handler.ts",
  level: "error",
  status: "unresolved",
  count: "12",
  userCount: 3,
  firstSeen: "2026-11-01T10:00:00Z",
  lastSeen: `2026-11-09T11:0${id % 10}:00Z`,
  ...over,
});

let listing: unknown[] = [];
const okHandler = (req: IncomingMessage, res: ServerResponse) => {
  const url = req.url ?? "";
  const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(typeof body === "string" ? body : JSON.stringify(body));
  };
  if (url.startsWith("/api/0/organizations/")) return send(200, []);
  if (url.startsWith("/api/0/projects/acme/api/issues/")) return send(200, listing);
  if (url.startsWith("/api/0/issues/101/events/latest/")) {
    return send(200, {
      eventID: "evt-1",
      dateCreated: "2026-11-09T11:59:00Z",
      message: "boom",
      user: { email: "person@example.com", ip_address: "203.0.113.9" },
      request: { url: "https://app.example/secret?token=abc" },
      tags: [{ key: "environment", value: "production" }],
      entries: [
        {
          type: "exception",
          data: {
            values: [
              {
                type: "TypeError",
                value: "x is undefined",
                stacktrace: { frames: [{ filename: "a.ts", function: "outer", lineNo: 1 }, { filename: "b.ts", function: "inner", lineNo: 9 }] },
              },
            ],
          },
        },
      ],
    });
  }
  return send(404, { detail: "not found" });
};

interface Body {
  error: { code: string };
  connection: { status: string; tokenLast4: string };
  errors: {
    openCount: number;
    stale: boolean;
    status: string | null;
    link: { backoffUntil: string | null } | null;
    recent: { title: string; level: string; count: number; link: string; lastSeen: string }[];
  };
  issue: {
    eventStatus: string;
    latestEvent: { exception: { type: string; frames: { file: string; function: string; line: number }[] } };
  };
  issues: { glitchtipId: string; status: string; count: number }[];
  projects: { projectId: string }[];
  sync: string;
  ticket: { key: string; title: string };
}

let A: Tenant;
let B: Tenant;
let admin: string;
let member: string;
let bAdmin: string;
let projectId: string;

const call = async (cookie: string, method: string, path: string, body?: unknown) => {
  const res = await app.fetch(
    new Request(`http://api.test${path}`, {
      method,
      headers: { cookie, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  const text = await res.text();
  let json = {} as Body;
  try {
    json = JSON.parse(text) as Body;
  } catch {
    /* not json */
  }
  return { status: res.status, json, text };
};

const ws = (t: Tenant) => `/v1/workspaces/${t.ws.slug}`;
const connect = (token = TOKEN, url = baseUrl) =>
  call(admin, "PUT", `${ws(A)}/glitchtip/connection`, { baseUrl: url, token });
const map = () => call(admin, "PUT", `${ws(A)}/projects/${projectId}/glitchtip`, { orgSlug: "acme", projectSlug: "api" });
const sync = () => call(member, "POST", `${ws(A)}/projects/${projectId}/glitchtip/sync`);
const errors = (cookie = member) => call(cookie, "GET", `${ws(A)}/projects/${projectId}/glitchtip`);

beforeAll(async () => {
  server = createServer((req, res) => {
    seen.push({ path: req.url ?? "", auth: req.headers.authorization });
    handler(req, res);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  A = await seedTenant("gtf-a", "GFA");
  B = await seedTenant("gtf-b", "GFB");
  admin = `tly_session=${await newSession(A, "admin")}`;
  member = `tly_session=${await newSession(A, "member")}`;
  bAdmin = `tly_session=${await newSession(B, "admin")}`;
});

afterAll(async () => {
  resetClock();
  mutableConfig.authSecretKey = savedSecret;
  await new Promise<void>((r) => server.close(() => r()));
});

beforeEach(async () => {
  mutableConfig.authSecretKey = "test-auth-secret-key-for-glitchtip-feed-0123456789";
  (glitchtipSyncLimiter.store as MemoryRateStore).buckets.clear();
  setClock(() => T0);
  seen = [];
  listing = [issue(101), issue(102, { level: "warning" })];
  handler = okHandler;
  for (const t of [A, B]) {
    await db.delete(glitchtipIssues).where(eq(glitchtipIssues.workspaceId, t.ws.id));
    await db.delete(glitchtipProjectLinks).where(eq(glitchtipProjectLinks.workspaceId, t.ws.id));
    await db.delete(glitchtipConnections).where(eq(glitchtipConnections.workspaceId, t.ws.id));
  }
  projectId = (await mkProject(A)).id;
});

afterEach(() => vi.restoreAllMocks());

describe("connection", () => {
  it("seals the token, never returns it, and audits without it", async () => {
    const r = await connect();
    expect(r.status).toBe(200);
    expect(r.json.connection).toMatchObject({ baseUrl, tokenLast4: TOKEN.slice(-4), status: "ok" });
    expect(r.text).not.toContain(TOKEN);
    const row = await getConnection(A.ws.id);
    expect(row!.tokenEnc).not.toContain(TOKEN);
    expect(row!.tokenEnc.startsWith("v1:")).toBe(true);
    expect(seen.at(-1)).toEqual({ path: "/api/0/organizations/", auth: `Bearer ${TOKEN}` });

    const got = await call(admin, "GET", `${ws(A)}/glitchtip/connection`);
    expect(got.status).toBe(200);
    expect(got.text).not.toContain(TOKEN);

    const evs = await db.select().from(events).where(and(eq(events.workspaceId, A.ws.id), eq(events.action, "glitchtip_connected")));
    expect(evs.length).toBeGreaterThan(0);
    expect(JSON.stringify(evs)).not.toContain(TOKEN);
  });

  it("keeps the saved token when only the address changes, and audits the change", async () => {
    await connect();
    const r = await call(admin, "PUT", `${ws(A)}/glitchtip/connection`, { baseUrl: `${baseUrl}/` });
    expect(r.status).toBe(200);
    expect(r.json.connection.tokenLast4).toBe(TOKEN.slice(-4));
    expect(seen.at(-1)!.auth).toBe(`Bearer ${TOKEN}`);
    const evs = await db.select().from(events).where(and(eq(events.workspaceId, A.ws.id), eq(events.action, "glitchtip_connection_changed")));
    expect(evs).toHaveLength(1);
  });

  it("never re-sends the saved token to a new address", async () => {
    await connect();
    seen = [];
    const r = await call(admin, "PUT", `${ws(A)}/glitchtip/connection`, { baseUrl: "http://localhost:1" });
    expect(r.status).toBe(422);
    expect(r.json.error.code).toBe("TOKEN_REQUIRED");
    expect(seen).toHaveLength(0);
    expect((await getConnection(A.ws.id))!.baseUrl).toBe(baseUrl);
  });

  it("refuses a token GlitchTip rejects and stores nothing", async () => {
    handler = (_req, res) => {
      res.writeHead(401).end("{}");
    };
    const r = await connect();
    expect(r.status).toBe(422);
    expect(r.json.error.code).toBe("GLITCHTIP_AUTH_FAILED");
    expect(await getConnection(A.ws.id)).toBeUndefined();
  });

  it("saves while GlitchTip is unreachable, with status unreachable", async () => {
    const dead = createServer();
    await new Promise<void>((r) => dead.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(dead.address() as AddressInfo).port}`;
    await new Promise<void>((r) => dead.close(() => r()));
    const r = await connect(TOKEN, url);
    expect(r.status).toBe(200);
    expect(r.json.connection.status).toBe("unreachable");
  });

  it("validates the address and needs a token the first time", async () => {
    expect((await call(admin, "PUT", `${ws(A)}/glitchtip/connection`, { baseUrl: "not a url", token: TOKEN })).json.error.code).toBe("BAD_BASE_URL");
    expect((await call(admin, "PUT", `${ws(A)}/glitchtip/connection`, { baseUrl: "https://user:pw@gt.example.com", token: TOKEN })).json.error.code).toBe("BAD_BASE_URL");
    expect((await call(admin, "PUT", `${ws(A)}/glitchtip/connection`, { baseUrl })).json.error.code).toBe("TOKEN_REQUIRED");
  });

  it("refuses to store a token on a server with no AUTH_SECRET_KEY", async () => {
    mutableConfig.authSecretKey = "";
    const r = await connect();
    expect(r.status).toBe(503);
    expect(r.json.error.code).toBe("SECRETS_KEY_MISSING");
    expect(await getConnection(A.ws.id)).toBeUndefined();
  });

  it("is admin-only", async () => {
    expect((await call(member, "PUT", `${ws(A)}/glitchtip/connection`, { baseUrl, token: TOKEN })).status).toBe(403);
    expect((await call(member, "GET", `${ws(A)}/glitchtip/connection`)).status).toBe(403);
    expect((await call(member, "DELETE", `${ws(A)}/glitchtip/connection`)).status).toBe(403);
  });

  it("disconnects, audits, and 404s when there is nothing to disconnect", async () => {
    await connect();
    expect((await call(admin, "DELETE", `${ws(A)}/glitchtip/connection`)).status).toBe(200);
    expect((await call(admin, "DELETE", `${ws(A)}/glitchtip/connection`)).status).toBe(404);
    const evs = await db.select().from(events).where(and(eq(events.workspaceId, A.ws.id), eq(events.action, "glitchtip_disconnected")));
    expect(evs).toHaveLength(1);
  });
});

describe("project mapping and sync", () => {
  it("needs a connection first", async () => {
    const r = await map();
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe("NOT_CONNECTED");
  });

  it("maps, runs a first sync, and serves the error health from the cache", async () => {
    await connect();
    const r = await map();
    expect(r.status).toBe(200);
    expect(r.json.errors).toMatchObject({ connected: true, mapped: true, status: "ok", openCount: 2, openCapped: false, stale: false });
    expect(r.json.errors.link).toMatchObject({ orgSlug: "acme", projectSlug: "api", url: `${baseUrl}/acme` });
    const recent = r.json.errors.recent as { title: string; level: string; count: number; link: string; lastSeen: string }[];
    expect(recent).toHaveLength(2);
    expect(recent[0]).toMatchObject({ count: 12, link: expect.stringContaining("/acme/issues/") });
    expect(r.text).not.toContain(TOKEN);

    // reads never call GlitchTip
    seen = [];
    handler = () => {
      throw new Error("a read must not reach GlitchTip");
    };
    const read = await errors();
    expect(read.json.errors.openCount).toBe(2);
    const list = await call(member, "GET", `${ws(A)}/projects/${projectId}/glitchtip/issues?status=all&limit=1`);
    expect(list.json.issues).toHaveLength(1);
    expect(seen).toHaveLength(0);

    const evs = await db.select().from(events).where(and(eq(events.workspaceId, A.ws.id), eq(events.action, "glitchtip_project_linked")));
    expect(evs).toHaveLength(1);
    expect(evs[0]!.after).toMatchObject({ projectId, orgSlug: "acme", projectSlug: "api" });
  });

  it("rejects bad slugs and projects of another workspace", async () => {
    await connect();
    expect((await call(admin, "PUT", `${ws(A)}/projects/${projectId}/glitchtip`, { orgSlug: "a/b", projectSlug: "api" })).json.error.code).toBe("BAD_SLUG");
    const foreign = (await mkProject(B)).id;
    expect((await call(admin, "PUT", `${ws(A)}/projects/${foreign}/glitchtip`, { orgSlug: "acme", projectSlug: "api" })).status).toBe(404);
    expect((await call(admin, "GET", `${ws(A)}/projects/${foreign}/glitchtip`)).status).toBe(404);
  });

  it("marks errors GlitchTip no longer lists as resolved and tracks new counts", async () => {
    await connect();
    await map();
    listing = [issue(101, { count: "40" })];
    const r = await sync();
    expect(r.json.sync).toBe("ok");
    expect(r.json.errors.openCount).toBe(1);
    const all = await call(member, "GET", `${ws(A)}/projects/${projectId}/glitchtip/issues?status=all`);
    const byId = Object.fromEntries((all.json.issues as { glitchtipId: string; status: string; count: number }[]).map((i) => [i.glitchtipId, i]));
    expect(byId["101"]).toMatchObject({ status: "unresolved", count: 40 });
    expect(byId["102"]!.status).toBe("resolved");
  });

  it("flags a full page as capped and skips resolving", async () => {
    await connect();
    await map();
    listing = Array.from({ length: 100 }, (_v, i) => issue(1000 + i));
    const r = await sync();
    expect(r.json.errors).toMatchObject({ openCount: 100, openCapped: true });
    const still = await call(member, "GET", `${ws(A)}/projects/${projectId}/glitchtip/issues?status=unresolved&limit=100`);
    expect((still.json.issues as { glitchtipId: string }[]).some((i) => i.glitchtipId === "101")).toBe(true);
  });

  it("drops unparseable rows instead of failing the sync", async () => {
    await connect();
    await map();
    listing = [issue(101), { id: "x/y", title: "bad id" }, { id: "7" }, "junk"];
    const r = await sync();
    expect(r.json.sync).toBe("ok");
    expect(r.json.errors.openCount).toBe(1);
  });

  it("honors Retry-After: records the backoff, serves the cache, and does not call again until it passes", async () => {
    await connect();
    await map();
    handler = (_req, res) => {
      res.writeHead(429, { "retry-after": "120", "content-type": "application/json" }).end("{}");
    };
    seen = [];
    const r = await sync();
    expect(r.status).toBe(200);
    expect(r.json.sync).toBe("rate_limited");
    expect(r.json.errors.status).toBe("rate_limited");
    expect(r.json.errors.openCount).toBe(2); // last good cache
    expect(new Date(r.json.errors.link!.backoffUntil!).getTime()).toBe(T0 + 120_000);
    expect(seen).toHaveLength(1);

    seen = [];
    expect((await sync()).json.sync).toBe("skipped");
    expect(await syncDueLinks()).toEqual({ synced: 0 });
    expect(seen).toHaveLength(0);

    handler = okHandler;
    setClock(() => T0 + 121_000);
    const again = await sync();
    expect(again.json.sync).toBe("ok");
    expect(again.json.errors.link!.backoffUntil).toBeNull();
  });

  it("fails soft when GlitchTip is down, rejects the token, or answers garbage", async () => {
    await connect();
    await map();
    for (const [status, expected] of [
      [500, "unreachable"],
      [401, "auth_failed"],
      [404, "not_found"],
    ] as const) {
      handler = (_req, res) => {
        res.writeHead(status).end("{}");
      };
      const r = await sync();
      expect(r.status).toBe(200);
      expect(r.json.sync).toBe(expected);
      expect(r.json.errors.openCount).toBe(2);
    }
    handler = (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" }).end("<html>not json</html>");
    };
    expect((await sync()).json.sync).toBe("bad_response");
    const conn = await getConnection(A.ws.id);
    expect(conn!.lastStatus).toBe("bad_response");
  });

  it("reports stale when the last good sync is old", async () => {
    await connect();
    await map();
    setClock(() => T0 + 20 * 60_000);
    expect((await errors()).json.errors.stale).toBe(true);
  });

  it("the background tick syncs due links only", async () => {
    await connect();
    await map();
    expect(await syncDueLinks()).toEqual({ synced: 0 }); // just synced
    setClock(() => T0 + 6 * 60_000);
    listing = [issue(101)];
    expect(await syncDueLinks()).toEqual({ synced: 1 });
    expect((await errors()).json.errors.openCount).toBe(1);
  });

  it("never logs the token, even when a sync fails", async () => {
    const spies = [vi.spyOn(console, "log"), vi.spyOn(console, "error"), vi.spyOn(console, "warn")];
    await connect();
    await map();
    handler = (_req, res) => {
      res.writeHead(500).end(`upstream said ${TOKEN}`);
    };
    const r = await sync();
    expect(r.text).not.toContain(TOKEN);
    for (const s of spies) expect(JSON.stringify(s.mock.calls)).not.toContain(TOKEN);
  });

  it("sends only the owning workspace's token", async () => {
    await connect();
    await map();
    const otherToken = `${TOKEN}-b`;
    await call(bAdmin, "PUT", `${ws(B)}/glitchtip/connection`, { baseUrl, token: otherToken });
    const bProject = (await mkProject(B)).id;
    await call(bAdmin, "PUT", `${ws(B)}/projects/${bProject}/glitchtip`, { orgSlug: "acme", projectSlug: "api" });
    seen = [];
    await sync();
    expect(seen.every((s) => s.auth === `Bearer ${TOKEN}`)).toBe(true);
  });

  it("unmaps, clears the cache and audits", async () => {
    await connect();
    await map();
    expect((await call(admin, "DELETE", `${ws(A)}/projects/${projectId}/glitchtip`)).status).toBe(200);
    expect((await call(admin, "DELETE", `${ws(A)}/projects/${projectId}/glitchtip`)).status).toBe(404);
    expect((await errors()).json.errors).toMatchObject({ mapped: false, openCount: 0, recent: [] });
    const left = await db.select().from(glitchtipIssues).where(eq(glitchtipIssues.projectId, projectId));
    expect(left).toHaveLength(0);
    const evs = await db.select().from(events).where(and(eq(events.workspaceId, A.ws.id), eq(events.action, "glitchtip_project_unlinked")));
    expect(evs).toHaveLength(1);
  });

  it("changing the mapping drops the old project's cached errors", async () => {
    await connect();
    await map();
    listing = [];
    const r = await call(admin, "PUT", `${ws(A)}/projects/${projectId}/glitchtip`, { orgSlug: "acme", projectSlug: "other" });
    expect(r.status).toBe(200);
    expect((await db.select().from(glitchtipIssues).where(eq(glitchtipIssues.projectId, projectId))).length).toBe(0);
  });

  it("rate limits manual syncs", async () => {
    await connect();
    await map();
    let last = 200;
    for (let i = 0; i < 8; i++) last = (await sync()).status;
    expect(last).toBe(429);
  });

  it("exposes every mapped project for the portfolio view, scoped to the workspace", async () => {
    await connect();
    await map();
    const h = await call(member, "GET", `${ws(A)}/glitchtip/health`);
    expect(h.json.projects).toHaveLength(1);
    expect(h.json.projects[0]).toMatchObject({ projectId, openCount: 2, status: "ok" });
    const other = await call(bAdmin, "GET", `${ws(B)}/glitchtip/health`);
    expect(other.json.projects).toEqual([]);
    expect(other.text).not.toContain(projectId);
  });
});

describe("error detail", () => {
  it("returns the latest event trimmed of user and request data", async () => {
    await connect();
    await map();
    const r = await call(member, "GET", `${ws(A)}/projects/${projectId}/glitchtip/issues/101`);
    expect(r.status).toBe(200);
    expect(r.json.issue).toMatchObject({ glitchtipId: "101", eventStatus: "ok" });
    expect(r.json.issue.latestEvent.exception).toMatchObject({ type: "TypeError", value: "x is undefined" });
    expect(r.json.issue.latestEvent.exception.frames[0]).toMatchObject({ file: "b.ts", function: "inner", line: 9 });
    expect(r.text).not.toContain("person@example.com");
    expect(r.text).not.toContain("203.0.113.9");
    expect(r.text).not.toContain("secret?token");
    const stored = await db.select().from(glitchtipIssues).where(eq(glitchtipIssues.projectId, projectId));
    expect(JSON.stringify(stored)).not.toContain("person@example.com");
  });

  it("serves the cached event when GlitchTip can't answer, and 404s unknown ids", async () => {
    await connect();
    await map();
    await call(member, "GET", `${ws(A)}/projects/${projectId}/glitchtip/issues/101`);
    setClock(() => T0 + 10 * 60_000);
    handler = (_req, res) => {
      res.writeHead(503).end("{}");
    };
    const r = await call(member, "GET", `${ws(A)}/projects/${projectId}/glitchtip/issues/101`);
    expect(r.status).toBe(200);
    expect(r.json.issue.eventStatus).toBe("unreachable");
    expect(r.json.issue.latestEvent.exception.type).toBe("TypeError");
    expect((await call(member, "GET", `${ws(A)}/projects/${projectId}/glitchtip/issues/9999`)).status).toBe(404);
  });

  it("does not call GlitchTip for an event while a Retry-After is in force", async () => {
    await connect();
    await map();
    handler = (_req, res) => {
      res.writeHead(429, { "retry-after": "300" }).end("{}");
    };
    await sync();
    seen = [];
    const r = await call(member, "GET", `${ws(A)}/projects/${projectId}/glitchtip/issues/101`);
    expect(r.status).toBe(200);
    expect(r.json.issue.eventStatus).toBe("rate_limited");
    expect(seen).toHaveLength(0);
  });

  it("does not show another workspace's error", async () => {
    await connect();
    await map();
    const bProject = (await mkProject(B)).id;
    const r = await call(bAdmin, "GET", `${ws(B)}/projects/${bProject}/glitchtip/issues/101`);
    expect(r.status).toBe(404);
    const cross = await call(bAdmin, "GET", `${ws(B)}/projects/${projectId}/glitchtip/issues/101`);
    expect(cross.status).toBe(404);
  });
});

describe("ticket from an error", () => {
  it("files one triage ticket and returns it again on repeat", async () => {
    await connect();
    await map();
    const r = await call(member, "POST", `${ws(A)}/projects/${projectId}/glitchtip/issues/101/ticket`);
    expect(r.status).toBe(201);
    expect(r.json.ticket.title).toBe("TypeError 101");
    const [row] = await db.select().from(issues).where(and(eq(issues.workspaceId, A.ws.id), eq(issues.key, r.json.ticket.key)));
    expect(row).toMatchObject({ state: "triage", source: "intake" });
    expect(row!.description).toContain("/acme/issues/101");

    const again = await call(member, "POST", `${ws(A)}/projects/${projectId}/glitchtip/issues/101/ticket`);
    expect(again.status).toBe(200);
    expect(again.json.ticket.key).toBe(r.json.ticket.key);
    expect((await call(member, "POST", `${ws(A)}/projects/${projectId}/glitchtip/issues/9999/ticket`)).status).toBe(404);
  });
});
