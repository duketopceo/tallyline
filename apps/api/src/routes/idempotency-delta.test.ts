import { eq, sql } from "drizzle-orm";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { db } from "../db/client.js";
import { idempotencyKeys, issues } from "../db/schema.js";
import { app } from "../index.js";
import { IDEMPOTENCY_STALE_MS } from "../lib/idempotency.js";
import { resetClock, setClock } from "../services/clock.js";
import { mkIssue, newSession, seedTenant, type Tenant } from "../../test/tenants.js";

// S4-U4: what an offline client needs from the API: Idempotency-Key on writes
// and `updatedSince` delta reads.

let A: Tenant;
let B: Tenant;
let admin: string;
let member: string;

beforeAll(async () => {
  A = await seedTenant("idem-a", "IDA");
  B = await seedTenant("idem-b", "IDB");
  admin = `tly_session=${await newSession(A, "admin")}`;
  member = `tly_session=${await newSession(A, "member")}`;
});
afterEach(() => resetClock());

const call = async (path: string, init: RequestInit & { cookie?: string; bearer?: string; key?: string } = {}) => {
  const { cookie, bearer, key, ...rest } = init;
  const res = await app.fetch(
    new Request(`http://api.test${path}`, {
      ...rest,
      headers: {
        "content-type": "application/json",
        ...(cookie ? { cookie } : {}),
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
        ...(key ? { "idempotency-key": key } : {}),
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
  return { status: res.status, body, headers: res.headers };
};

const issuesPath = (t: Tenant, q = "") => `/v1/workspaces/${t.ws.slug}/issues${q}`;
const create = (title: string, key?: string, cookie = admin, extra: Record<string, unknown> = {}) =>
  call(issuesPath(A), { method: "POST", cookie, ...(key ? { key } : {}), body: JSON.stringify({ title, ...extra }) });
const countTitled = async (title: string) =>
  (await db.select().from(issues).where(eq(issues.workspaceId, A.ws.id))).filter((i) => i.title === title).length;
const KEY = () => `key-${Math.random().toString(36).slice(2)}-${Date.now()}`;

describe("Idempotency-Key", () => {
  it("a retry returns the first response and writes once", async () => {
    const key = KEY();
    const first = await create("offline write", key);
    const retry = await create("offline write", key);
    expect(first.status).toBe(201);
    expect(retry.status).toBe(201);
    expect(retry.body).toEqual(first.body);
    expect(first.headers.get("idempotent-replayed")).toBeNull();
    expect(retry.headers.get("idempotent-replayed")).toBe("true");
    expect(await countTitled("offline write")).toBe(1);
  });

  it("without a key nothing changes: two writes, two issues", async () => {
    await create("no key");
    await create("no key");
    expect(await countTitled("no key")).toBe(2);
  });

  it("the same key for a different request is refused and writes nothing", async () => {
    const key = KEY();
    await create("original", key);
    const other = await create("something else", key);
    expect(other.status).toBe(422);
    expect((other.body.error as { code: string }).code).toBe("IDEMPOTENCY_KEY_REUSED");
    expect(await countTitled("something else")).toBe(0);
  });

  it("simultaneous retries create exactly one issue", async () => {
    const key = KEY();
    const results = await Promise.all([1, 2, 3, 4].map(() => create("racing write", key)));
    expect(await countTitled("racing write")).toBe(1);
    for (const r of results) expect([201, 409]).toContain(r.status);
    expect(results.filter((r) => r.status === 201).length).toBeGreaterThanOrEqual(1);
    const settled = await create("racing write", key);
    expect(settled.status).toBe(201);
    expect(settled.headers.get("idempotent-replayed")).toBe("true");
  });

  it("a failed request releases the key so the fixed request can use it", async () => {
    const key = KEY();
    const bad = await create("", key); // empty title: validation error
    expect(bad.status).toBe(400);
    const ok = await create("fixed after failure", key);
    expect(ok.status).toBe(201);
    expect(ok.headers.get("idempotent-replayed")).toBeNull();
  });

  it("keys are per caller: someone else's identical key runs their own request", async () => {
    const key = KEY();
    const a = await create("per caller", key, admin);
    const m = await create("per caller", key, member);
    expect(a.status).toBe(201);
    expect(m.status).toBe(201);
    expect(m.body.id).not.toBe(a.body.id);
    expect(m.headers.get("idempotent-replayed")).toBeNull();
  });

  it("never replays to someone outside the workspace", async () => {
    const key = KEY();
    await create("tenant secret", key);
    const outsider = `tly_session=${await newSession(B, "admin")}`;
    const r = await call(issuesPath(A), {
      method: "POST",
      cookie: outsider,
      key,
      body: JSON.stringify({ title: "tenant secret" }),
    });
    expect(r.status).toBe(403);
    expect(JSON.stringify(r.body)).not.toContain("tenant secret");
  });

  it("rejects malformed keys", async () => {
    for (const bad of ["short", "has space in it", "x".repeat(129), "bad/slash/key-1234"]) {
      const r = await create("bad key", bad);
      expect(r.status, bad).toBe(400);
    }
    expect(await countTitled("bad key")).toBe(0);
  });

  it("covers comments and issue updates too", async () => {
    const issue = await mkIssue(A);
    const ck = KEY();
    const post = () =>
      call(`${issuesPath(A)}/${issue.key}/comments`, {
        method: "POST",
        cookie: admin,
        key: ck,
        body: JSON.stringify({ body: "sent while offline" }),
      });
    const c1 = await post();
    const c2 = await post();
    expect(c1.status).toBe(201);
    expect(c2.body).toEqual(c1.body);
    expect(c2.headers.get("idempotent-replayed")).toBe("true");

    const pk = KEY();
    const patch = () =>
      call(`${issuesPath(A)}/${issue.key}`, {
        method: "PATCH",
        cookie: admin,
        key: pk,
        body: JSON.stringify({ title: "renamed once" }),
      });
    expect((await patch()).status).toBe(200);
    const again = await patch();
    expect(again.status).toBe(200);
    expect(again.headers.get("idempotent-replayed")).toBe("true");
  });

  it("an abandoned first attempt can be taken over after a minute", async () => {
    const key = KEY();
    const scope = `${A.ws.id}|user:${A.people.admin.id}`;
    const body = JSON.stringify({ title: "taken over" });
    // simulate a crashed first request: a claim that never finished
    const { createHash } = await import("node:crypto");
    const fingerprint = createHash("sha256")
      .update(`POST\n${issuesPath(A)}\n${body}`)
      .digest("hex");
    await db.insert(idempotencyKeys).values({ scope, key, fingerprint });
    const waiting = await create("taken over", key);
    expect(waiting.status).toBe(409);
    expect((waiting.body.error as { code: string }).code).toBe("IDEMPOTENCY_IN_PROGRESS");
    setClock(() => Date.now() + IDEMPOTENCY_STALE_MS + 1_000);
    const ok = await create("taken over", key);
    expect(ok.status).toBe(201);
  });
});

describe("updatedSince delta reads", () => {
  const pageAll = async (since: string, limit: number) => {
    const out: { id: string; updatedAt: string }[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 50; guard++) {
      const r: Awaited<ReturnType<typeof call>> = await call(
        issuesPath(A, `?updatedSince=${encodeURIComponent(since)}&limit=${limit}${cursor ? `&cursor=${cursor}` : ""}`),
        { cookie: admin },
      );
      expect(r.status).toBe(200);
      out.push(...(r.body.issues as { id: string; updatedAt: string }[]));
      cursor = (r.body.nextCursor as string | null) ?? null;
      if (!cursor) break;
    }
    return out;
  };

  it("returns only what changed, oldest change first, with stable complete paging", async () => {
    const since = new Date(Date.now() - 1000).toISOString();
    const made: Awaited<ReturnType<typeof mkIssue>>[] = [];
    for (let i = 0; i < 7; i++) made.push(await mkIssue(A, { title: `delta ${i}` }));
    // the same instant for three of them, to prove ties do not drop rows
    const same = new Date(Date.now() + 5000);
    for (const i of made.slice(0, 3)) {
      await db.update(issues).set({ updatedAt: same }).where(eq(issues.id, i.id));
    }
    const all = await pageAll(since, 2);
    const ids = all.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length); // no duplicates across pages
    for (const m of made) expect(ids).toContain(m.id);
    const times = all.map((i) => Date.parse(i.updatedAt));
    expect([...times].sort((a, b) => a - b)).toEqual(times); // oldest change first
  });

  it("pages correctly when many rows share one millisecond but differ in microseconds", async () => {
    const since = new Date(Date.now() - 1000).toISOString();
    const rows: Awaited<ReturnType<typeof mkIssue>>[] = [];
    for (let i = 0; i < 5; i++) rows.push(await mkIssue(A, { title: `micro ${i}` }));
    await db.execute(
      sql`update issues set updated_at = timestamptz '2031-01-01 00:00:00.123000+00' + (random() * interval '900 microseconds') where id in (${sql.join(
        rows.map((r) => sql`${r.id}::uuid`),
        sql`, `,
      )})`,
    );
    const all = await pageAll(since, 1);
    const hits = all.filter((i) => rows.some((r) => r.id === i.id));
    expect(hits).toHaveLength(5);
    expect(new Set(hits.map((h) => h.id)).size).toBe(5);
  });

  it("an update moves an issue into the next delta", async () => {
    const issue = await mkIssue(A, { title: "will change" });
    const mark = new Date(Date.now() + 2000).toISOString();
    expect((await pageAll(mark, 50)).map((i) => i.id)).not.toContain(issue.id);
    setClock(() => Date.now() + 10_000);
    const patch = await call(`${issuesPath(A)}/${issue.key}`, {
      method: "PATCH",
      cookie: admin,
      body: JSON.stringify({ title: "changed" }),
    });
    expect(patch.status).toBe(200);
    expect((await pageAll(mark, 50)).map((i) => i.id)).toContain(issue.id);
  });

  it("does not leak other workspaces and rejects mismatched or bad cursors", async () => {
    const other = await mkIssue(B, { title: "foreign delta" });
    const since = new Date(Date.now() - 5000).toISOString();
    expect((await pageAll(since, 200)).map((i) => i.id)).not.toContain(other.id);

    const normal = await call(issuesPath(A, "?limit=1"), { cookie: admin });
    const normalCursor = normal.body.nextCursor as string;
    expect(normalCursor).toBeTruthy();
    const mixed = await call(issuesPath(A, `?updatedSince=${encodeURIComponent(since)}&cursor=${normalCursor}`), { cookie: admin });
    expect(mixed.status).toBe(400);
    const junk = await call(issuesPath(A, `?updatedSince=${encodeURIComponent(since)}&cursor=d.not-a-cursor`), { cookie: admin });
    expect(junk.status).toBe(400);
    const badDate = await call(issuesPath(A, "?updatedSince=yesterday"), { cookie: admin });
    expect(badDate.status).toBe(400);
  });

  it("leaves the normal newest-first listing alone", async () => {
    const r = await call(issuesPath(A, "?limit=3"), { cookie: admin });
    const t = (r.body.issues as { createdAt: string }[]).map((i) => Date.parse(i.createdAt));
    expect([...t].sort((a, b) => b - a)).toEqual(t);
  });
});
