import { eq } from "drizzle-orm";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "../db/client.js";
import { aiProviders, aiUsageLedger } from "../db/schema.js";
import { config_ } from "../env.js";
import { app } from "../index.js";
import { MemoryRateStore } from "../lib/rate-limit.js";
import { aiConnectLimiter } from "./ai-providers.js";
import { __setAiFetchForTests, type AiFetch } from "../services/ai-providers.js";
import { challengeFor, CONNECT_TTL_MS, OPENROUTER_KEYS_URL } from "../services/openrouter-connect.js";
import { resetClock, setClock } from "../services/clock.js";
import { newSession, seedTenant, type Tenant } from "../../test/tenants.js";

// S3-U3: connect OpenRouter through its PKCE flow. The verifier never leaves
// the server unsealed, the key is stored only after a good exchange, and a
// state only finishes for the person and workspace that started it.

let A: Tenant;
let B: Tenant;
let admin: string;
let admin2: string;
let bAdmin: string;

const mutableConfig = config_ as unknown as { authSecretKey: string; webUrl: string };
const savedSecret = mutableConfig.authSecretKey;
const KEY = ["sk", "or", "v1", "unit", "test", "0042"].join("-");

beforeAll(async () => {
  A = await seedTenant("orc-a", "ORA");
  B = await seedTenant("orc-b", "ORB");
  admin = `tly_session=${await newSession(A, "admin")}`;
  admin2 = `tly_session=${await newSession(A, "owner")}`;
  bAdmin = `tly_session=${await newSession(B, "admin")}`;
});

const clean = async () => {
  for (const t of [A, B]) {
    await db.delete(aiProviders).where(eq(aiProviders.workspaceId, t.ws.id));
    await db.delete(aiUsageLedger).where(eq(aiUsageLedger.workspaceId, t.ws.id));
  }
};

beforeEach(async () => {
  (aiConnectLimiter.store as MemoryRateStore).buckets.clear();
  mutableConfig.authSecretKey = "test-auth-secret-key-for-openrouter-0123456789";
  await clean();
});

afterEach(async () => {
  mutableConfig.authSecretKey = savedSecret;
  __setAiFetchForTests(null);
  resetClock();
  await clean();
});

const call = async (t: Tenant, path: string, cookie: string, body: unknown) => {
  const res = await app.fetch(
    new Request(`http://api.test/v1/workspaces/${t.ws.slug}/ai${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify(body),
    }),
  );
  const text = await res.text();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let json: Record<string, any> = {};
  try {
    json = JSON.parse(text);
  } catch {
    json = {};
  }
  return { status: res.status, body: json, text };
};

function fakeExchange(reply: { status: number; body: string } | Error) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const seen: { url: string; body: any }[] = [];
  const f: AiFetch = async (url, init) => {
    seen.push({ url, body: JSON.parse(init.body) });
    if (reply instanceof Error) throw reply;
    return reply;
  };
  __setAiFetchForTests(f);
  return seen;
}

describe("starting an OpenRouter connect", () => {
  it("returns a sign-in URL with an S256 challenge and the web callback", async () => {
    const r = await call(A, "/openrouter/start", admin, {});
    expect(r.status).toBe(200);
    const url = new URL(r.body.authUrl);
    expect(url.origin + url.pathname).toBe("https://openrouter.ai/auth");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.get("callback_url")).toBe(`${mutableConfig.webUrl}/settings/ai/openrouter`);
    expect(url.searchParams.get("state")).toBe(r.body.state);
    // the verifier is sealed: the state must not carry it in the clear
    expect(Buffer.from(r.body.state, "base64url").toString("utf8")).not.toContain("verifier");
  });

  it("headless mode leaves out the callback and state, for a pasted code", async () => {
    const r = await call(A, "/openrouter/start", admin, { mode: "headless" });
    expect(r.status).toBe(200);
    const url = new URL(r.body.authUrl);
    expect(url.searchParams.has("callback_url")).toBe(false);
    expect(url.searchParams.has("state")).toBe(false);
    expect(r.body.state).toBeTruthy();
  });

  it("refuses to start without a secrets key", async () => {
    mutableConfig.authSecretKey = "";
    const r = await call(A, "/openrouter/start", admin, {});
    expect(r.status).toBe(503);
    expect(r.text).toContain("SECRETS_KEY_MISSING");
  });
});

describe("finishing an OpenRouter connect", () => {
  it("exchanges the code with the matching verifier and stores a sealed key", async () => {
    const s = await call(A, "/openrouter/start", admin, { model: "openai/gpt-4o-mini", monthlyCapCents: 500 });
    const challenge = new URL(s.body.authUrl).searchParams.get("code_challenge");
    const seen = fakeExchange({ status: 200, body: JSON.stringify({ key: KEY }) });
    const r = await call(A, "/openrouter/complete", admin, { code: "abc123", state: s.body.state });
    expect(r.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe(OPENROUTER_KEYS_URL);
    expect(seen[0]!.body).toMatchObject({ code: "abc123", code_challenge_method: "S256" });
    expect(challengeFor(seen[0]!.body.code_verifier)).toBe(challenge);
    expect(r.body.provider).toMatchObject({
      kind: "openrouter",
      label: "OpenRouter",
      model: "openai/gpt-4o-mini",
      hasKey: true,
      monthlyCapCents: 500,
    });
    expect(r.text).not.toContain(KEY);
    const [row] = await db.select().from(aiProviders).where(eq(aiProviders.workspaceId, A.ws.id));
    expect(row!.apiKeyEnc).not.toContain(KEY);
  });

  it("will not finish for another workspace or another person", async () => {
    const s = await call(A, "/openrouter/start", admin, {});
    const seen = fakeExchange({ status: 200, body: JSON.stringify({ key: KEY }) });
    const other = await call(B, "/openrouter/complete", bAdmin, { code: "c", state: s.body.state });
    expect(other.status).toBe(400);
    expect(other.text).toContain("CONNECT_STATE_INVALID");
    const person = await call(A, "/openrouter/complete", admin2, { code: "c", state: s.body.state });
    expect(person.status).toBe(400);
    expect(seen).toHaveLength(0);
    expect(await db.select().from(aiProviders).where(eq(aiProviders.workspaceId, A.ws.id))).toHaveLength(0);
  });

  it("rejects a tampered state and an expired one", async () => {
    const bad = await call(A, "/openrouter/complete", admin, { code: "c", state: "bm90LWEtc3RhdGU" });
    expect(bad.status).toBe(400);
    const s = await call(A, "/openrouter/start", admin, {});
    const later = Date.now() + CONNECT_TTL_MS + 1000;
    setClock(() => later);
    const old = await call(A, "/openrouter/complete", admin, { code: "c", state: s.body.state });
    expect(old.status).toBe(410);
    expect(old.text).toContain("CONNECT_EXPIRED");
  });

  it("explains a rejected code and stores nothing", async () => {
    const s = await call(A, "/openrouter/start", admin, {});
    fakeExchange({ status: 403, body: '{"error":"invalid code"}' });
    const r = await call(A, "/openrouter/complete", admin, { code: "used", state: s.body.state });
    expect(r.status).toBe(400);
    expect(r.text).toContain("CONNECT_CODE_REJECTED");
    expect(r.text).not.toContain("invalid code");
    expect(await db.select().from(aiProviders).where(eq(aiProviders.workspaceId, A.ws.id))).toHaveLength(0);
  });

  it("maps an outage to a retryable error", async () => {
    const s = await call(A, "/openrouter/start", admin, {});
    fakeExchange(new Error("ECONNRESET"));
    const r = await call(A, "/openrouter/complete", admin, { code: "c", state: s.body.state });
    expect(r.status).toBe(502);
    expect(r.text).toContain("OPENROUTER_UNREACHABLE");
  });
});
