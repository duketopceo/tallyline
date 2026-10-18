import { and, eq } from "drizzle-orm";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { db } from "../db/client.js";
import { agentKeys, events } from "../db/schema.js";
import { app } from "../index.js";
import { clock, resetClock, setClock } from "../services/clock.js";
import { createAgentKey } from "../services/agents.js";
import { newSession, seedTenant, type Tenant } from "../../test/tenants.js";

// U5 (R3): agent keys can be revoked, rotated and expired. Revocation is
// immediate because agentFromKey hits the database on every call (no cache).

let A: Tenant;
let B: Tenant;
let adminCookie: string;
let memberCookie: string;
let bAdminCookie: string;

beforeAll(async () => {
  A = await seedTenant("keys-a", "KAA");
  B = await seedTenant("keys-b", "KBB");
  adminCookie = `tly_session=${await newSession(A, "admin")}`;
  memberCookie = `tly_session=${await newSession(A, "member")}`;
  bAdminCookie = `tly_session=${await newSession(B, "admin")}`;
});

afterEach(() => resetClock());

const call = async (
  path: string,
  init: RequestInit & { cookie?: string; bearer?: string } = {},
) => {
  const { cookie, bearer, ...rest } = init;
  const res = await app.fetch(
    new Request(`http://api.test${path}`, {
      ...rest,
      headers: {
        "content-type": "application/json",
        ...(cookie ? { cookie } : {}),
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      },
    }),
  );
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    body = { _text: text };
  }
  return { status: res.status, body, text };
};

const keysPath = (t: Tenant, suffix = "") =>
  `/v1/workspaces/${t.ws.slug}/agents/${t.agent.id}/keys${suffix}`;

const mint = async (body: Record<string, unknown> = {}) => {
  const r = await call(keysPath(A), {
    method: "POST",
    cookie: adminCookie,
    body: JSON.stringify({ name: "k", scopes: ["read"], ...body }),
  });
  expect(r.status).toBe(201);
  return { id: r.body.id as string, key: r.body.key as string };
};

const whoami = (key: string) => call("/v1/whoami", { bearer: key });
const revoke = (id: string, cookie = adminCookie, t = A) =>
  call(keysPath(t, `/${id}`), { method: "DELETE", cookie });
const rotate = (id: string, body: Record<string, unknown> = {}, cookie = adminCookie) =>
  call(keysPath(A, `/${id}/rotate`), {
    method: "POST",
    cookie,
    body: JSON.stringify(body),
  });

describe("agent key revoke", () => {
  it("a revoked key is 401 on its very next call and the row is gone", async () => {
    const k = await mint();
    expect((await whoami(k.key)).status).toBe(200);
    const del = await revoke(k.id);
    expect(del.status).toBe(200);
    expect((await whoami(k.key)).status).toBe(401);
    expect((await revoke(k.id)).status).toBe(404);
  });

  it("a member, an agent key and a PAT cannot revoke; the key keeps working", async () => {
    const k = await mint();
    expect((await revoke(k.id, memberCookie)).status).toBe(403);
    const asAgent = await call(keysPath(A, `/${k.id}`), {
      method: "DELETE",
      bearer: A.agentKeys.write,
    });
    expect(asAgent.status).toBe(403);
    expect(asAgent.text).toContain("FORBIDDEN_AGENT");
    const asPat = await call(keysPath(A, `/${k.id}`), {
      method: "DELETE",
      bearer: A.pats.write,
    });
    expect(asPat.status).toBe(403);
    expect((await whoami(k.key)).status).toBe(200);
  });

  it("revoking another workspace's key is 404 and leaves it alive", async () => {
    const k = await mint();
    // B's admin, B's route, A's key id
    expect((await revoke(k.id, bAdminCookie, B)).status).toBe(404);
    expect((await whoami(k.key)).status).toBe(200);
  });

  it("writes an event that carries no key material", async () => {
    const k = await mint({ name: "audited" });
    await revoke(k.id);
    const rows = await db
      .select()
      .from(events)
      .where(and(eq(events.entityType, "agent_key"), eq(events.entityId, k.id)));
    expect(rows.map((r) => r.action)).toContain("agent_key_revoked");
    const blob = JSON.stringify(rows);
    expect(blob).not.toContain(k.key);
    expect(blob).not.toContain("token_hash");
    expect(blob).not.toContain("tokenHash");
    expect(blob).not.toMatch(/tly_agt_/);
  });
});

describe("agent key rotate", () => {
  it("returns a new key and, by default, kills the old one at once", async () => {
    const old = await mint();
    const r = await rotate(old.id);
    expect(r.status).toBe(201);
    const next = r.body.key as string;
    expect(next).toMatch(/^tly_agt_/);
    expect(next).not.toBe(old.key);
    expect(r.body.id).not.toBe(old.id);
    expect((await whoami(next)).status).toBe(200);
    expect((await whoami(old.key)).status).toBe(401);
  });

  it("the new key inherits scopes and name; plaintext is not in events or listings", async () => {
    const old = await mint({ name: "inherit", scopes: ["read", "write"] });
    const r = await rotate(old.id);
    expect(r.body.scopes).toEqual(["read", "write"]);
    const list = await call(keysPath(A), { cookie: adminCookie });
    expect(list.text).not.toContain(r.body.key as string);
    const rows = await db
      .select()
      .from(events)
      .where(eq(events.entityType, "agent_key"));
    expect(JSON.stringify(rows)).not.toContain(r.body.key as string);
    expect(JSON.stringify(rows)).not.toContain(old.key);
    expect(rows.map((x) => x.action)).toContain("agent_key_rotated");
  });

  it("graceSeconds keeps the old key valid only inside the window", async () => {
    const t0 = Date.now();
    setClock(() => t0);
    const old = await mint();
    const r = await rotate(old.id, { graceSeconds: 600 });
    expect(r.status).toBe(201);
    setClock(() => t0 + 599_000);
    expect((await whoami(old.key)).status).toBe(200);
    setClock(() => t0 + 601_000);
    expect((await whoami(old.key)).status).toBe(401);
    expect((await whoami(r.body.key as string)).status).toBe(200);
  });

  it("rejects a grace window over 24 hours", async () => {
    const old = await mint();
    const r = await rotate(old.id, { graceSeconds: 86_401 });
    expect(r.status).toBe(400);
    expect((await whoami(old.key)).status).toBe(200);
  });

  it("a member or an agent cannot rotate; another workspace's key is 404", async () => {
    const old = await mint();
    expect((await rotate(old.id, {}, memberCookie)).status).toBe(403);
    const asAgent = await call(keysPath(A, `/${old.id}/rotate`), {
      method: "POST",
      bearer: A.agentKeys.write,
      body: "{}",
    });
    expect(asAgent.status).toBe(403);
    expect(asAgent.text).toContain("FORBIDDEN_AGENT");
    const cross = await call(keysPath(B, `/${old.id}/rotate`), {
      method: "POST",
      cookie: bAdminCookie,
      body: "{}",
    });
    expect(cross.status).toBe(404);
    expect((await whoami(old.key)).status).toBe(200);
  });

  it("rotating an already-revoked key is 404", async () => {
    const old = await mint();
    await revoke(old.id);
    expect((await rotate(old.id)).status).toBe(404);
  });
});

describe("agent key expiry", () => {
  it("an expired key is refused", async () => {
    const t0 = Date.now();
    setClock(() => t0);
    const k = await mint({ expiresInDays: 1 });
    expect((await whoami(k.key)).status).toBe(200);
    setClock(() => t0 + 86_400_000 + 1000);
    expect((await whoami(k.key)).status).toBe(401);
  });

  it("applies the 90-day default when the caller omits expiresInDays", async () => {
    const t0 = Date.now();
    setClock(() => t0);
    const k = await mint();
    const list = await call(keysPath(A), { cookie: adminCookie });
    const row = (list.body.keys as { id: string; expiresAt: string | null }[]).find(
      (x) => x.id === k.id,
    );
    expect(new Date(row!.expiresAt!).getTime()).toBe(t0 + 90 * 86_400_000);
    setClock(() => t0 + 91 * 86_400_000);
    expect((await whoami(k.key)).status).toBe(401);
  });

  it("an explicit expiresInDays beats the default", async () => {
    const t0 = clock.ms();
    const k = await mint({ expiresInDays: 365 });
    const [row] = await db.select().from(agentKeys).where(eq(agentKeys.id, k.id));
    expect(row!.expiresAt!.getTime()).toBeGreaterThan(t0 + 364 * 86_400_000);
  });

  it("rotating a key that has no expiry gives the new key the default expiry", async () => {
    const legacy = await createAgentKey(A.agent.id, A.ws.id, "legacy", ["read"]);
    const r = await rotate(legacy.id);
    const [row] = await db
      .select()
      .from(agentKeys)
      .where(eq(agentKeys.id, r.body.id as string));
    expect(row!.expiresAt).not.toBeNull();
  });
});
