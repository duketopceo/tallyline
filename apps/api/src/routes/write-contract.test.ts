import { beforeAll, describe, expect, it } from "vitest";
import { app } from "../index.js";
import { mkIssue, newSession, seedTenant, type Tenant } from "../../test/tenants.js";

// Write contract C6: a per-issue integer `version` on reads, an optional
// `If-Match` precondition on issue patch, and `409 STALE_WRITE` carrying the
// current server issue. No `If-Match` means no precondition.

let A: Tenant;
let admin: string;

beforeAll(async () => {
  A = await seedTenant("wc-a", "WCA");
  admin = `tly_session=${await newSession(A, "admin")}`;
});

const call = async (path: string, init: RequestInit & { headers?: Record<string, string> } = {}) => {
  const res = await app.fetch(
    new Request(`http://api.test${path}`, {
      ...init,
      headers: { "content-type": "application/json", cookie: admin, ...(init.headers ?? {}) },
    }),
  );
  const body = (await res.json().catch(() => ({}))) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  return { status: res.status, body, headers: res.headers };
};
const base = () => `/v1/workspaces/${A.ws.slug}/issues`;
const patch = (key: string, data: Record<string, unknown>, headers: Record<string, string> = {}) =>
  call(`${base()}/${key}`, { method: "PATCH", body: JSON.stringify(data), headers });

describe("issue version", () => {
  it("is returned on create, detail and list reads", async () => {
    const created = await call(base(), { method: "POST", body: JSON.stringify({ title: "versioned" }) });
    expect(created.status).toBe(201);
    expect(typeof created.body.version).toBe("number");
    const detail = await call(`${base()}/${created.body.key}`);
    expect(detail.body.version).toBe(created.body.version);
    const list = await call(`${base()}?limit=200`);
    const row = (list.body.issues as { key: string; version: number }[]).find((i) => i.key === created.body.key);
    expect(row?.version).toBe(created.body.version);
  });

  it("increases on every write and stays out of the delta cursor", async () => {
    const issue = await mkIssue(A);
    const v0 = (await call(`${base()}/${issue.key}`)).body.version as number;
    const r = await patch(issue.key, { title: "one" });
    expect(r.body.version).toBeGreaterThan(v0);
    const since = new Date(Date.now() - 60_000).toISOString();
    const delta = await call(`${base()}?updatedSince=${encodeURIComponent(since)}&limit=200`);
    expect(delta.status).toBe(200);
    const row = (delta.body.issues as { key: string; version: number }[]).find((i) => i.key === issue.key);
    expect(row?.version).toBe(r.body.version);
  });
});

describe("If-Match precondition on issue patch", () => {
  it("succeeds with the current version and returns the next one", async () => {
    const issue = await mkIssue(A);
    const v = (await call(`${base()}/${issue.key}`)).body.version as number;
    const r = await patch(issue.key, { title: "fresh" }, { "if-match": `"${v}"` });
    expect(r.status).toBe(200);
    expect(r.body.title).toBe("fresh");
    expect(r.body.version).toBeGreaterThan(v);
  });

  it("accepts the bare integer form too", async () => {
    const issue = await mkIssue(A);
    const v = (await call(`${base()}/${issue.key}`)).body.version as number;
    expect((await patch(issue.key, { title: "bare" }, { "if-match": String(v) })).status).toBe(200);
  });

  it("an old version is 409 STALE_WRITE with the current issue, and nothing is written", async () => {
    const issue = await mkIssue(A);
    const v = (await call(`${base()}/${issue.key}`)).body.version as number;
    await patch(issue.key, { title: "theirs" });
    const stale = await patch(issue.key, { title: "mine", priority: "urgent" }, { "if-match": `"${v}"` });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("STALE_WRITE");
    expect(typeof stale.body.error.message).toBe("string");
    expect(stale.body.issue.title).toBe("theirs");
    expect(stale.body.issue.version).toBeGreaterThan(v);
    const after = await call(`${base()}/${issue.key}`);
    expect(after.body.title).toBe("theirs");
    expect(after.body.priority).not.toBe("urgent");
  });

  it("a state change with a stale version is refused before it transitions", async () => {
    const issue = await mkIssue(A);
    const v = (await call(`${base()}/${issue.key}`)).body.version as number;
    await patch(issue.key, { title: "bump" });
    const stale = await patch(issue.key, { state: "done" }, { "if-match": String(v) });
    expect(stale.status).toBe(409);
    expect((await call(`${base()}/${issue.key}`)).body.state).not.toBe("done");
  });

  it("no If-Match header means no precondition (shipped clients)", async () => {
    const issue = await mkIssue(A);
    await patch(issue.key, { title: "a" });
    expect((await patch(issue.key, { title: "b" })).status).toBe(200);
  });

  it("two queued writes resolve in order: the second uses the version the first returned", async () => {
    const issue = await mkIssue(A);
    const v = (await call(`${base()}/${issue.key}`)).body.version as number;
    const first = await patch(issue.key, { title: "first" }, { "if-match": String(v) });
    const second = await patch(issue.key, { priority: "high" }, { "if-match": String(first.body.version) });
    expect(second.status).toBe(200);
  });

  it("a malformed If-Match is 400", async () => {
    const issue = await mkIssue(A);
    const r = await patch(issue.key, { title: "x" }, { "if-match": "abc" });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("BAD_IF_MATCH");
  });

  it("STALE_WRITE is not stored by Idempotency-Key: fixing the version and retrying works", async () => {
    const issue = await mkIssue(A);
    const v = (await call(`${base()}/${issue.key}`)).body.version as number;
    await patch(issue.key, { title: "theirs" });
    const key = `wc-key-${Math.random().toString(36).slice(2)}-1234`;
    const stale = await patch(issue.key, { title: "mine" }, { "if-match": String(v), "idempotency-key": key });
    expect(stale.status).toBe(409);
    const now = (await call(`${base()}/${issue.key}`)).body.version as number;
    const ok = await patch(issue.key, { title: "mine" }, { "if-match": String(now), "idempotency-key": key });
    // same key, different request (header is not part of the fingerprint): body equal, so replay or run; either way 200
    expect(ok.status).toBe(200);
  });
});
