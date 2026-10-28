import { and, eq } from "drizzle-orm";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "../db/client.js";
import { aiProviders, aiUsageLedger, events } from "../db/schema.js";
import { config_ } from "../env.js";
import { app } from "../index.js";
import { MemoryRateStore } from "../lib/rate-limit.js";
import { aiTestLimiter } from "./ai-providers.js";
import { __setAiFetchForTests, type AiFetch } from "../services/ai-providers.js";
import { newSession, seedTenant, type Tenant } from "../../test/tenants.js";

// S3-U2: bring-your-own AI provider. The API key is sealed, never echoed, a
// monthly cap stops calls before they are made, and nothing about a failure
// leaks the key or the upstream body.

let A: Tenant;
let B: Tenant;
let admin: string;
let member: string;
let bAdmin: string;

const mutableConfig = config_ as unknown as { authSecretKey: string; llmApiKey: string };
const savedSecret = mutableConfig.authSecretKey;
const savedLlmKey = mutableConfig.llmApiKey;
const savedPrivate = process.env.TALLYLINE_WEBHOOK_ALLOW_PRIVATE;

const KEY = "sk-or-v1-supersecretvalue-12345";

beforeAll(async () => {
  A = await seedTenant("aip-a", "AIA");
  B = await seedTenant("aip-b", "AIB");
  admin = `tly_session=${await newSession(A, "admin")}`;
  member = `tly_session=${await newSession(A, "member")}`;
  bAdmin = `tly_session=${await newSession(B, "admin")}`;
});

beforeEach(async () => {
  (aiTestLimiter.store as MemoryRateStore).buckets.clear();
  // the shared tenant seed plants a provider and a ledger row; start clean
  for (const t of [A, B]) {
    await db.delete(aiProviders).where(eq(aiProviders.workspaceId, t.ws.id));
    await db.delete(aiUsageLedger).where(eq(aiUsageLedger.workspaceId, t.ws.id));
  }
  mutableConfig.authSecretKey = "test-auth-secret-key-for-ai-providers-0123456789";
  mutableConfig.llmApiKey = "";
});

afterEach(async () => {
  mutableConfig.authSecretKey = savedSecret;
  mutableConfig.llmApiKey = savedLlmKey;
  if (savedPrivate === undefined) delete process.env.TALLYLINE_WEBHOOK_ALLOW_PRIVATE;
  else process.env.TALLYLINE_WEBHOOK_ALLOW_PRIVATE = savedPrivate;
  __setAiFetchForTests(null);
  for (const t of [A, B]) {
    await db.delete(aiProviders).where(eq(aiProviders.workspaceId, t.ws.id));
    await db.delete(aiUsageLedger).where(eq(aiUsageLedger.workspaceId, t.ws.id));
  }
});

const call = async (t: Tenant, path: string, init: RequestInit & { cookie?: string; bearer?: string } = {}) => {
  const { cookie, bearer, ...rest } = init;
  const res = await app.fetch(
    new Request(`http://api.test/v1/workspaces/${t.ws.slug}/ai${path}`, {
      ...rest,
      headers: {
        "content-type": "application/json",
        ...(cookie ? { cookie } : {}),
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      },
    }),
  );
  const text = await res.text();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let body: Record<string, any> = {};
  try {
    body = JSON.parse(text);
  } catch {
    body = { _text: text };
  }
  return { status: res.status, body, text };
};

const put = (body: Record<string, unknown>, cookie = admin, t = A) =>
  call(t, "/provider", { method: "PUT", cookie, body: JSON.stringify(body) });

const orBody = { kind: "openrouter", label: "My OpenRouter", model: "openai/gpt-4o-mini", apiKey: KEY };

const okReply = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    choices: [{ message: { content: "ok" } }],
    usage: { prompt_tokens: 12, completion_tokens: 3, cost: 0.0004 },
    ...over,
  });

function fakeFetch(reply: { status: number; body: string } | Error) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const seen: { url: string; headers: Record<string, string>; body: any }[] = [];
  const f: AiFetch = async (url, init) => {
    seen.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    if (reply instanceof Error) throw reply;
    return reply;
  };
  __setAiFetchForTests(f);
  return seen;
}

describe("connecting a provider", () => {
  it("seals the key, never returns it, and shows only hasKey", async () => {
    const r = await put(orBody);
    expect(r.status).toBe(200);
    expect(r.body.provider).toMatchObject({
      source: "workspace",
      kind: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      hasKey: true,
      monthlyCapCents: 1000,
      editable: true,
    });
    expect(r.text).not.toContain(KEY);
    const g = await call(A, "/provider", { cookie: admin });
    expect(g.status).toBe(200);
    expect(g.text).not.toContain(KEY);
    expect(g.body.provider.hasKey).toBe(true);
    const [row] = await db.select().from(aiProviders).where(eq(aiProviders.workspaceId, A.ws.id));
    expect(row!.apiKeyEnc).toBeTruthy();
    expect(row!.apiKeyEnc).not.toContain(KEY);
  });

  it("keeps the key when apiKey is omitted and removes it with an empty string", async () => {
    await put(orBody);
    const keep = await put({ kind: "openrouter", label: "Renamed", model: "openai/gpt-4o" });
    expect(keep.status).toBe(200);
    expect(keep.body.provider).toMatchObject({ label: "Renamed", hasKey: true });
    const [sealed] = await db.select().from(aiProviders).where(eq(aiProviders.workspaceId, A.ws.id));
    expect(sealed!.apiKeyEnc).toBeTruthy();
    // openrouter can't live without a key
    const strip = await put({ ...orBody, apiKey: "" });
    expect(strip.status).toBe(422);
    expect(strip.text).toContain("API_KEY_REQUIRED");
  });

  it("an openai-compatible provider can run without a key and needs a base URL", async () => {
    process.env.TALLYLINE_WEBHOOK_ALLOW_PRIVATE = "1";
    const noUrl = await put({ kind: "openai_compatible", label: "Local", model: "llama3" });
    expect(noUrl.status).toBe(422);
    expect(noUrl.text).toContain("BASE_URL_REQUIRED");
    const ok = await put({ kind: "openai_compatible", label: "Local", model: "llama3", baseUrl: "http://127.0.0.1:11434/v1/" });
    expect(ok.status).toBe(200);
    expect(ok.body.provider).toMatchObject({ baseUrl: "http://127.0.0.1:11434/v1", hasKey: false });
  });

  it("refuses plain http and private addresses unless the operator allowed private networks", async () => {
    process.env.TALLYLINE_WEBHOOK_ALLOW_PRIVATE = "";
    const http = await put({ kind: "openai_compatible", label: "x", model: "m", baseUrl: "http://example.com/v1" });
    expect(http.status).toBe(422);
    expect(http.text).toContain("BASE_URL_NOT_HTTPS");
    const meta = await put({ kind: "openai_compatible", label: "x", model: "m", baseUrl: "https://169.254.169.254/v1" });
    expect(meta.status).toBe(422);
    expect(meta.text).toContain("BASE_URL_NOT_ALLOWED");
    const loop = await put({ kind: "openai_compatible", label: "x", model: "m", baseUrl: "https://127.0.0.1/v1" });
    expect(loop.status).toBe(422);
    const [row] = await db.select().from(aiProviders).where(eq(aiProviders.workspaceId, A.ws.id));
    expect(row).toBeUndefined();
  });

  it("says plainly when the server has no key to seal with", async () => {
    mutableConfig.authSecretKey = "";
    const r = await put(orBody);
    expect(r.status).toBe(503);
    expect(r.text).toContain("SECRETS_KEY_MISSING");
  });

  it("validates the limit", async () => {
    expect((await put({ ...orBody, monthlyCapCents: -1 })).status).toBe(400);
    expect((await put({ ...orBody, monthlyCapCents: 99_999_999 })).status).toBe(400);
    const none = await put({ ...orBody, monthlyCapCents: null });
    expect(none.status).toBe(200);
    expect(none.body.provider.monthlyCapCents).toBeNull();
  });

  it("is admin only, and one workspace never sees another's provider", async () => {
    expect((await put(orBody, member)).status).toBe(403);
    expect((await call(A, "/provider", { cookie: member })).status).toBe(403);
    expect((await call(A, "/provider", { bearer: A.agentKeys.read })).status).toBe(403);
    expect((await call(A, "/provider", { bearer: A.agentKeys.write, method: "PUT", body: JSON.stringify(orBody) })).status).toBe(403);
    await put(orBody);
    const other = await call(B, "/provider", { cookie: bAdmin });
    expect(other.body.provider).toBeNull();
    // an admin of B cannot reach A's
    expect((await call(A, "/provider", { cookie: bAdmin })).status).toBe(403);
  });

  it("records who connected it without the key in the audit trail", async () => {
    await put(orBody);
    const rows = await db.select().from(events).where(and(eq(events.workspaceId, A.ws.id), eq(events.entityType, "ai_provider")));
    expect(rows.length).toBeGreaterThan(0);
    expect(JSON.stringify(rows)).not.toContain(KEY);
  });

  it("disconnects, and 404s when there is nothing of its own to remove", async () => {
    await put(orBody);
    expect((await call(A, "/provider", { method: "DELETE", cookie: admin })).status).toBe(200);
    expect((await call(A, "/provider", { cookie: admin })).body.provider).toBeNull();
    expect((await call(A, "/provider", { method: "DELETE", cookie: admin })).status).toBe(404);
  });

  it("falls back to the server-wide provider, which can't be edited here", async () => {
    mutableConfig.llmApiKey = "env-provider-key-xyz";
    const g = await call(A, "/provider", { cookie: admin });
    expect(g.body.provider).toMatchObject({ source: "environment", hasKey: true, editable: false });
    expect(g.text).not.toContain("env-provider-key-xyz");
    expect((await call(A, "/provider", { method: "DELETE", cookie: admin })).status).toBe(404);
  });
});

describe("the test button and the ledger", () => {
  it("makes one call with the key and records its cost", async () => {
    await put(orBody);
    const seen = fakeFetch({ status: 200, body: okReply() });
    const r = await call(A, "/provider/test", { method: "POST", cookie: admin });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, model: "openai/gpt-4o-mini" });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(seen[0]!.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(seen[0]!.body.model).toBe("openai/gpt-4o-mini");
    expect(seen[0]!.body.usage).toEqual({ include: true });
    const u = await call(A, "/usage", { cookie: admin });
    expect(u.status).toBe(200);
    expect(u.body.calls).toBe(1);
    expect(u.body.spentCents).toBeCloseTo(0.04, 5);
    expect(u.body.recent[0]).toMatchObject({ action: "test", status: "ok", tokensIn: 12, tokensOut: 3 });
    expect(u.text).not.toContain(KEY);
  });

  it("an openai-compatible provider is called at its own address without the OpenRouter extras", async () => {
    process.env.TALLYLINE_WEBHOOK_ALLOW_PRIVATE = "1";
    await put({ kind: "openai_compatible", label: "Local", model: "llama3", baseUrl: "http://127.0.0.1:11434/v1" });
    const seen = fakeFetch({ status: 200, body: okReply({ usage: undefined }) });
    const r = await call(A, "/provider/test", { method: "POST", cookie: admin });
    expect(r.body.ok).toBe(true);
    expect(seen[0]!.url).toBe("http://127.0.0.1:11434/v1/chat/completions");
    expect(seen[0]!.headers.authorization).toBeUndefined();
    expect(seen[0]!.body.usage).toBeUndefined();
  });

  it("a rejected key is an answer, not a server error, and never echoes the key or the body", async () => {
    await put(orBody);
    fakeFetch({ status: 401, body: JSON.stringify({ error: { message: `bad key ${KEY}` } }) });
    const r = await call(A, "/provider/test", { method: "POST", cookie: admin });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: false, code: "AI_UPSTREAM" });
    expect(r.body.message).toContain("didn't accept the API key");
    expect(r.text).not.toContain(KEY);
    const u = await call(A, "/usage", { cookie: admin });
    expect(u.body.recent[0].status).toBe("error");
  });

  it("redacts the key from a network failure", async () => {
    await put(orBody);
    fakeFetch(new Error(`connect failed for ${KEY}`));
    const r = await call(A, "/provider/test", { method: "POST", cookie: admin });
    expect(r.body).toMatchObject({ ok: false, code: "AI_UNREACHABLE" });
    expect(r.text).not.toContain(KEY);
  });

  it("answers plainly when nothing is connected", async () => {
    const r = await call(A, "/provider/test", { method: "POST", cookie: admin });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: false, code: "AI_NOT_CONFIGURED" });
  });

  it("stops before calling once the monthly limit is spent", async () => {
    await put({ ...orBody, monthlyCapCents: 1 });
    await db.insert(aiUsageLedger).values({ workspaceId: A.ws.id, action: "summary", model: "m", costMicros: 20_000 });
    const seen = fakeFetch({ status: 200, body: okReply() });
    const r = await call(A, "/provider/test", { method: "POST", cookie: admin });
    expect(r.body).toMatchObject({ ok: false, code: "AI_CAP_REACHED" });
    expect(seen).toHaveLength(0);
    // raising the limit lets it through
    await put({ ...orBody, monthlyCapCents: 100 });
    expect((await call(A, "/provider/test", { method: "POST", cookie: admin })).body.ok).toBe(true);
    await db.delete(aiUsageLedger).where(and(eq(aiUsageLedger.workspaceId, A.ws.id), eq(aiUsageLedger.action, "summary")));
  });

  it("a limit of null means no limit", async () => {
    await put({ ...orBody, monthlyCapCents: null });
    await db.insert(aiUsageLedger).values({ workspaceId: A.ws.id, action: "summary", model: "m", costMicros: 900_000_000 });
    fakeFetch({ status: 200, body: okReply() });
    expect((await call(A, "/provider/test", { method: "POST", cookie: admin })).body.ok).toBe(true);
    await db.delete(aiUsageLedger).where(and(eq(aiUsageLedger.workspaceId, A.ws.id), eq(aiUsageLedger.action, "summary")));
  });

  it("an empty answer counts as an error", async () => {
    await put(orBody);
    fakeFetch({ status: 200, body: JSON.stringify({ choices: [{ message: { content: "  " } }] }) });
    const r = await call(A, "/provider/test", { method: "POST", cookie: admin });
    expect(r.body).toMatchObject({ ok: false, code: "AI_UPSTREAM" });
  });

  it("limits the test button so a stuck script can't run up a bill", async () => {
    await put(orBody);
    fakeFetch({ status: 200, body: okReply() });
    const codes: number[] = [];
    for (let i = 0; i < 8; i++) codes.push((await call(A, "/provider/test", { method: "POST", cookie: admin })).status);
    expect(codes.slice(0, 6).every((c) => c === 200)).toBe(true);
    expect(codes.slice(6)).toEqual([429, 429]);
  });

  it("only admins see spend, and only their own workspace's", async () => {
    expect((await call(A, "/usage", { cookie: member })).status).toBe(403);
    await db.insert(aiUsageLedger).values({ workspaceId: A.ws.id, action: "only-a", model: "m" });
    const b = await call(B, "/usage", { cookie: bAdmin });
    expect(b.text).not.toContain("only-a");
    await db.delete(aiUsageLedger).where(and(eq(aiUsageLedger.workspaceId, A.ws.id), eq(aiUsageLedger.action, "only-a")));
  });
});
