import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "../db/client.js";
import { authIdentities, users } from "../db/schema.js";
import { config_ } from "../env.js";
import { app } from "../index.js";
import { __setProvidersForTests } from "../auth/providers/registry.js";
import type { IdentityResult, OAuthProvider } from "../auth/providers/types.js";
import { appleProvider, appleWebReady } from "../auth/providers/apple.js";
import { newSession, seedTenant, type Tenant } from "../../test/tenants.js";

// U6: web Apple sign-in (form_post bounce) and linked identities.

let t: Tenant;
let cookie: string;

async function call(path: string, init: { method?: string; body?: string; headers?: Record<string, string>; cookie?: string } = {}) {
  const res = await app.fetch(
    new Request(`http://api.test${path}`, {
      method: init.method ?? "GET",
      redirect: "manual",
      headers: { ...(init.cookie ? { cookie: `tly_session=${init.cookie}` } : {}), ...init.headers },
      ...(init.body !== undefined ? { body: init.body } : {}),
    }),
  );
  return res;
}

beforeEach(async () => {
  t = await seedTenant("aw", "AWA");
  cookie = await newSession(t, "owner");
});

const appleEnv = config_ as {
  appleClientId: string;
  appleTeamId: string;
  appleKeyId: string;
  applePrivateKey: string;
  authAccountLinking: "auto" | "login" | "disabled";
};
const savedApple = {
  appleClientId: config_.appleClientId,
  appleTeamId: config_.appleTeamId,
  appleKeyId: config_.appleKeyId,
  applePrivateKey: config_.applePrivateKey,
  authAccountLinking: config_.authAccountLinking,
};

afterEach(() => {
  appleEnv.appleClientId = savedApple.appleClientId;
  appleEnv.appleTeamId = savedApple.appleTeamId;
  appleEnv.appleKeyId = savedApple.appleKeyId;
  appleEnv.applePrivateKey = savedApple.applePrivateKey;
  appleEnv.authAccountLinking = savedApple.authAccountLinking;
  __setProvidersForTests(null);
});

function setWebApple(privateKey: string) {
  appleEnv.appleClientId = "app.tallyline.web";
  appleEnv.appleTeamId = "T";
  appleEnv.appleKeyId = "K";
  appleEnv.applePrivateKey = privateKey;
}

describe("apple web provider", () => {
  const full = { appleClientId: "app.tallyline.web", appleTeamId: "T", appleKeyId: "K", applePrivateKey: "P" };

  it("is ready only when Services ID, team, key and private key are all set", () => {
    expect(appleWebReady(full)).toBe(true);
    expect(appleWebReady({ ...full, applePrivateKey: "" })).toBe(false);
    expect(appleWebReady({ ...full, appleClientId: "" })).toBe(false);
  });

  it("authorizes with form_post, the openid email name scope and PKCE", async () => {
    const p = appleProvider({ key: "apple", label: "Apple", clientId: "c", teamId: "T", keyId: "K", privateKeyPem: "P", source: "env" });
    const u = new URL(await p.authorizeUrl({ redirectUri: "https://api/cb", state: "s", nonce: "n", codeChallenge: "ch" }));
    expect(u.searchParams.get("response_mode")).toBe("form_post");
    expect(u.searchParams.get("scope")).toBe("openid email name");
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
  });
});

describe("form_post callback", () => {
  it("303s the cross-site POST to the GET leg carrying code and state only", async () => {
    const res = await call("/v1/auth/oauth/apple/callback", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "code=abc&state=xyz&user=%7B%22name%22%3A%22x%22%7D&evil=1",
    });
    expect(res.status).toBe(303);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.pathname).toBe("/v1/auth/oauth/apple/callback");
    expect(loc.searchParams.get("code")).toBe("abc");
    expect(loc.searchParams.get("state")).toBe("xyz");
    expect(loc.searchParams.has("user")).toBe(false);
    expect(loc.searchParams.has("evil")).toBe(false);
  });

  it("a forged state on the GET leg still fails closed to the web error path", async () => {
    const res = await call("/v1/auth/oauth/apple/callback?code=abc&state=forged");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("/login?error=");
  });
});

describe("linked identities", () => {
  async function link(userId: string, email: string | null, sub: string) {
    const [row] = await db
      .insert(authIdentities)
      .values({ userId, providerKey: "apple", providerSubject: sub, email, emailVerified: true })
      .returning();
    return row!;
  }

  it("lists provider, link date and relay marker, never the subject", async () => {
    await link(t.people.owner.id, "abc123@privaterelay.appleid.com", "sub-secret-1");
    const res = await call("/v1/me/identities", { cookie });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("sub-secret-1");
    const body = JSON.parse(text) as { identities: { provider: string; relayEmail: boolean; linkedAt: string }[]; hasPassword: boolean };
    expect(body.identities).toHaveLength(1);
    expect(body.identities[0]).toMatchObject({ provider: "apple", relayEmail: true });
    expect(body.hasPassword).toBe(true);
  });

  it("disconnects when another method remains, refuses the last one", async () => {
    const row = await link(t.people.owner.id, null, "sub-2");
    const ok = await call(`/v1/me/identities/${row.id}`, { method: "DELETE", cookie });
    expect(ok.status).toBe(200);
    expect(await db.select().from(authIdentities).where(eq(authIdentities.userId, t.people.owner.id))).toHaveLength(0);

    // passwordless account with a single identity: that identity is the last method
    const only = await link(t.people.owner.id, null, "sub-3");
    await db.update(users).set({ passwordHash: null }).where(eq(users.id, t.people.owner.id));
    const refused = await call(`/v1/me/identities/${only.id}`, { method: "DELETE", cookie });
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe("LAST_SIGN_IN_METHOD");
    expect(await db.select().from(authIdentities).where(eq(authIdentities.id, only.id))).toHaveLength(1);
  });

  it("another user's identity is a 404 and requires a session", async () => {
    const other = await link(t.people.admin.id, null, "sub-4");
    expect((await call(`/v1/me/identities/${other.id}`, { method: "DELETE", cookie })).status).toBe(404);
    expect((await call("/v1/me/identities")).status).toBe(401);
  });
});

describe("web Apple methods and callback identity", () => {
  it("lists Apple only when the four web fields are set", async () => {
    __setProvidersForTests(null);
    setWebApple("P");
    const ready = await call("/v1/auth/methods");
    expect(ready.status).toBe(200);
    const listed = (await ready.json()) as { providers: { key: string; type: string }[] };
    expect(listed.providers).toContainEqual({ key: "apple", type: "apple", label: "Apple" });

    setWebApple("");
    const hidden = await call("/v1/auth/methods");
    const omitted = (await hidden.json()) as { providers: { key: string; type: string }[] };
    expect(omitted.providers.some((p) => p.type === "apple")).toBe(false);
  });

  it("asks for a web link when policy is login and does not set a session", async () => {
    appleEnv.authAccountLinking = "login";
    const identity: IdentityResult = {
      subject: "apple-sub-link",
      email: t.people.owner.email,
      emailVerified: true,
      name: null,
      avatarUrl: null,
      hd: null,
    };
    __setProvidersForTests([appleStub(() => identity)]);
    const ex = await roundTrip("nonce-link");
    expect(ex.status).toBe(409);
    const body = (await ex.json()) as { purpose: string };
    expect(body.purpose).toBe("pending-link");
    expect(ex.headers.getSetCookie().join(";")).not.toContain("tly_session=");
  });

  it("keeps the same user when a later Apple token omits email", async () => {
    appleEnv.authAccountLinking = "auto";
    let identity: IdentityResult = {
      subject: "apple-sub-1",
      email: t.people.owner.email,
      emailVerified: true,
      name: null,
      avatarUrl: null,
      hd: null,
    };
    __setProvidersForTests([appleStub(() => identity)]);
    const first = await roundTrip("nonce-auto-1");
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { purpose: string; user: { id: string } };
    expect(firstBody.purpose).toBe("login");

    identity = { ...identity, email: null, emailVerified: false };
    const second = await roundTrip("nonce-auto-2");
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as { purpose: string; user: { id: string } };
    expect(secondBody.purpose).toBe("login");
    expect(secondBody.user.id).toBe(firstBody.user.id);
    const rows = await db.select().from(authIdentities).where(eq(authIdentities.providerSubject, "apple-sub-1"));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.userId).toBe(t.people.owner.id);
  });
});

function appleStub(read: () => IdentityResult): OAuthProvider {
  return {
    key: "apple",
    type: "apple",
    label: "Apple",
    public: { clientId: "app.tallyline.web", scopes: ["openid", "email", "name"], issuer: null, source: "env" },
    authorizeUrl: ({ state }) => `https://appleid.apple.com/auth/authorize?state=${state}`,
    exchange: async () => read(),
  };
}

async function roundTrip(loginNonce: string) {
  const start = await app.fetch(
    new Request(`http://api.test/v1/auth/oauth/apple/start?return_to=/board&login_nonce=${loginNonce}`, {
      redirect: "manual",
    }),
  );
  const state = new URL(start.headers.get("location")!).searchParams.get("state");
  const jar = start.headers.getSetCookie().map((s) => s.split(";")[0]).join("; ");
  const cb = await app.fetch(
    new Request(`http://api.test/v1/auth/oauth/apple/callback?code=idc&state=${state}`, {
      redirect: "manual",
      headers: { cookie: jar },
    }),
  );
  const code = new URL(cb.headers.get("location")!).searchParams.get("code");
  return app.fetch(
    new Request("http://api.test/v1/auth/oauth/exchange", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, login_nonce: loginNonce }),
    }),
  );
}
