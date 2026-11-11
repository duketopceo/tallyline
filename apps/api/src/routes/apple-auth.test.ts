import { createHash, createSign, generateKeyPairSync, type KeyObject } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { APPLE_JWKS_URL } from "../auth/apple-identity.js";
import { __setProviderFetchForTests } from "../auth/providers/types.js";
import { db } from "../db/client.js";
import { authIdentities, devices, userTokens } from "../db/schema.js";
import { config_ } from "../env.js";
import { app } from "../index.js";
import { seedTenant } from "../../test/tenants.js";

function b64url(buf: Buffer | string): string {
  const b = typeof buf === "string" ? Buffer.from(buf, "utf8") : buf;
  return b.toString("base64url");
}

function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "test-kid", alg: "RS256", use: "sig" };

function mintToken(key: KeyObject, claims: Record<string, unknown>): string {
  const header = b64url(JSON.stringify({ alg: "RS256", kid: "test-kid" }));
  const payload = b64url(JSON.stringify(claims));
  const sig = createSign("RSA-SHA256").update(`${header}.${payload}`).sign({ key });
  return `${header}.${payload}.${b64url(sig)}`;
}

function claims(opts: { sub: string; rawNonce: string; email?: string | null; emailVerified?: unknown }): Record<string, unknown> {
  const body: Record<string, unknown> = {
    iss: "https://appleid.apple.com",
    aud: "app.tallyline.ios",
    exp: Math.floor(Date.now() / 1000) + 3600,
    sub: opts.sub,
    nonce: sha256Hex(opts.rawNonce),
  };
  if (opts.email !== null && opts.email !== undefined) body.email = opts.email;
  if (opts.emailVerified !== undefined) body.email_verified = opts.emailVerified;
  return body;
}

const mutable = config_ as {
  appleBundleIds: string[];
  appleClientId: string;
  authAccountLinking: "auto" | "login" | "disabled";
};
const saved = {
  appleBundleIds: [...config_.appleBundleIds],
  appleClientId: config_.appleClientId,
  authAccountLinking: config_.authAccountLinking,
};

const call = async (body: Record<string, unknown>) => {
  const res = await app.fetch(
    new Request("http://api.test/v1/auth/apple", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};

const post = (identityToken: string, rawNonce: string) =>
  call({
    identityToken,
    rawNonce,
    deviceName: "Luke's iPhone",
    platform: "ios",
  });

async function tokenCount(userId?: string): Promise<number> {
  const rows = userId
    ? await db.select({ id: userTokens.id }).from(userTokens).where(eq(userTokens.userId, userId))
    : await db.select({ id: userTokens.id }).from(userTokens);
  return rows.length;
}

beforeAll(() => {
  mutable.appleBundleIds = ["app.tallyline.ios"];
  mutable.appleClientId = "";
  __setProviderFetchForTests(async (url) => {
    if (url !== APPLE_JWKS_URL) throw new Error(`unexpected fetch ${url}`);
    return {
      ok: true,
      status: 200,
      json: async () => ({ keys: [jwk] }),
      text: async () => "",
    };
  });
});

afterEach(() => {
  mutable.authAccountLinking = "auto";
  mutable.appleBundleIds = ["app.tallyline.ios"];
  mutable.appleClientId = "";
});

afterAll(() => {
  mutable.appleBundleIds = saved.appleBundleIds;
  mutable.appleClientId = saved.appleClientId;
  mutable.authAccountLinking = saved.authAccountLinking;
  __setProviderFetchForTests(null);
});

function expectPat(body: Record<string, unknown>, slug: string) {
  expect(body.token).toEqual(expect.stringMatching(/^tly_pat_/));
  expect(body.tokenType).toBe("Bearer");
  expect(typeof body.expiresAt).toBe("string");
  expect(body.scopes).toEqual(["read", "write"]);
  expect(typeof body.deviceId).toBe("string");
  expect(typeof body.server).toBe("string");
  const workspace = body.workspace as { slug: string; name: string };
  expect(workspace.slug).toBe(slug);
  expect(workspace.name.length).toBeGreaterThan(0);
}

describe("POST /v1/auth/apple", () => {
  it("mints a device PAT for a known Apple sub and keeps the first token on a second sign-in", async () => {
    const tenant = await seedTenant("apple-happy", "APH");
    const sub = "apple-sub-happy";
    const rawNonce = "client-nonce-1";
    await db.insert(authIdentities).values({
      userId: tenant.people.member.id,
      providerKey: "apple",
      providerSubject: sub,
      email: tenant.people.member.email,
      emailVerified: true,
    });
    const token = mintToken(privateKey, claims({ sub, rawNonce, email: tenant.people.member.email, emailVerified: "true" }));
    const first = await post(token, rawNonce);
    expect(first.status).toBe(200);
    expectPat(first.body, tenant.ws.slug);

    const againNonce = "client-nonce-2";
    const again = await post(
      mintToken(privateKey, claims({ sub, rawNonce: againNonce, email: tenant.people.member.email, emailVerified: "true" })),
      againNonce,
    );
    expect(again.status).toBe(200);
    expect(again.body.token).not.toBe(first.body.token);
    const rows = await db.select().from(devices).where(eq(devices.userId, tenant.people.member.id));
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.revokedAt === null)).toBe(true);

    const who = await app.fetch(
      new Request("http://api.test/v1/whoami", { headers: { authorization: `Bearer ${first.body.token as string}` } }),
    );
    expect(who.status).toBe(200);
  });

  it("signs in again when a later token omits email", async () => {
    const tenant = await seedTenant("apple-noemail", "ANE");
    const sub = "apple-sub-noemail";
    await db.insert(authIdentities).values({
      userId: tenant.people.member.id,
      providerKey: "apple",
      providerSubject: sub,
      email: tenant.people.member.email,
      emailVerified: true,
    });
    const rawNonce = "client-nonce-noemail";
    const res = await post(mintToken(privateKey, claims({ sub, rawNonce, email: null })), rawNonce);
    expect(res.status).toBe(200);
    expectPat(res.body, tenant.ws.slug);
    const me = await app.fetch(
      new Request("http://api.test/v1/whoami", { headers: { authorization: `Bearer ${res.body.token as string}` } }),
    );
    const body = (await me.json()) as { id: string };
    expect(body.id).toBe(tenant.people.member.id);
  });

  it("returns 503 when no Apple audience is configured and mints nothing", async () => {
    mutable.appleBundleIds = [];
    mutable.appleClientId = "";
    const before = await tokenCount();
    const res = await post("not-a-real-identity-token-value", "client-nonce-1");
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ error: { code: "APPLE_NOT_CONFIGURED" } });
    expect(await tokenCount()).toBe(before);
  });

  it("rejects a wrong raw nonce and mints nothing", async () => {
    const tenant = await seedTenant("apple-nonce", "APN");
    const before = await tokenCount(tenant.people.member.id);
    const rawNonce = "client-nonce-1";
    const token = mintToken(
      privateKey,
      claims({ sub: "apple-sub-nonce", rawNonce, email: tenant.people.member.email, emailVerified: "true" }),
    );
    const res = await post(token, "other-nonce-value");
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ error: { code: "INVALID_APPLE_TOKEN" } });
    expect(await tokenCount(tenant.people.member.id)).toBe(before);
  });

  it("auto-links a verified email and mints a PAT without a web link step", async () => {
    const tenant = await seedTenant("apple-auto", "APA");
    const sub = "apple-sub-auto";
    const rawNonce = "client-nonce-auto";
    const res = await post(
      mintToken(privateKey, claims({ sub, rawNonce, email: tenant.people.member.email, emailVerified: "true" })),
      rawNonce,
    );
    expect(res.status).toBe(200);
    expectPat(res.body, tenant.ws.slug);
    const rows = await db.select().from(authIdentities).where(eq(authIdentities.providerSubject, sub));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.userId).toBe(tenant.people.member.id);
  });

  it("returns LINK_REQUIRED when linking policy is login and mints no device token", async () => {
    const tenant = await seedTenant("apple-link", "APL");
    mutable.authAccountLinking = "login";
    const sub = "apple-sub-login";
    const before = await tokenCount(tenant.people.member.id);
    const rawNonce = "client-nonce-login";
    const res = await post(
      mintToken(privateKey, claims({ sub, rawNonce, email: tenant.people.member.email, emailVerified: "true" })),
      rawNonce,
    );
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: { code: "LINK_REQUIRED" } });
    expect(await db.select().from(authIdentities).where(eq(authIdentities.providerSubject, sub))).toHaveLength(0);
    expect(await tokenCount(tenant.people.member.id)).toBe(before);
  });

  it("refuses a verified email that matches nobody", async () => {
    const sub = "apple-sub-nobody";
    const rawNonce = "client-nonce-nobody";
    const res = await post(
      mintToken(privateKey, claims({ sub, rawNonce, email: "nobody-apple@nowhere.test", emailVerified: "true" })),
      rawNonce,
    );
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: { code: "INVITE_REQUIRED" } });
  });

  it("does not take the email-match rung when email_verified is absent", async () => {
    const tenant = await seedTenant("apple-unverified", "APU");
    const sub = "apple-sub-unverified";
    const before = await tokenCount(tenant.people.member.id);
    const rawNonce = "client-nonce-unverified";
    const res = await post(
      mintToken(privateKey, claims({ sub, rawNonce, email: tenant.people.member.email })),
      rawNonce,
    );
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: { code: "INVITE_REQUIRED" } });
    expect(await db.select().from(authIdentities).where(eq(authIdentities.providerSubject, sub))).toHaveLength(0);
    expect(await tokenCount(tenant.people.member.id)).toBe(before);
  });

  it("accepts a replay of the same unexpired body and mints a second PAT", async () => {
    const tenant = await seedTenant("apple-replay", "APR");
    const sub = "apple-sub-replay";
    const rawNonce = "client-nonce-replay";
    await db.insert(authIdentities).values({
      userId: tenant.people.member.id,
      providerKey: "apple",
      providerSubject: sub,
      email: tenant.people.member.email,
      emailVerified: true,
    });
    const token = mintToken(privateKey, claims({ sub, rawNonce, email: tenant.people.member.email, emailVerified: "true" }));
    const body = {
      identityToken: token,
      rawNonce,
      deviceName: "Luke's iPhone",
      platform: "ios",
    };
    const raw = JSON.stringify(body);
    const first = await app.fetch(
      new Request("http://api.test/v1/auth/apple", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: raw,
      }),
    );
    const second = await app.fetch(
      new Request("http://api.test/v1/auth/apple", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: raw,
      }),
    );
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const a = (await first.json()) as { token: string };
    const b = (await second.json()) as { token: string };
    expect(a.token).toMatch(/^tly_pat_/);
    expect(b.token).toMatch(/^tly_pat_/);
    expect(b.token).not.toBe(a.token);
  });
});
