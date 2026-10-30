import { and, eq } from "drizzle-orm";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { db } from "../db/client.js";
import { devices, events, pairingCodes, userTokens, users, workspaceMembers } from "../db/schema.js";
import { app } from "../index.js";
import type { MemoryRateStore } from "../lib/rate-limit.js";
import { pairMintLimiter } from "./devices.js";
import { clock, resetClock, setClock } from "../services/clock.js";
import { createSession } from "../services/auth.js";
import { createUserToken } from "../services/tokens.js";
import { mkMember, newSession, seedTenant, type Tenant } from "../../test/tenants.js";

// S4-U2: QR pairing and the device registry. A signed-in person mints a
// five-minute single-use code; the phone trades it for a 90-day device
// credential that can rotate itself and be revoked from Settings.

let A: Tenant;
let B: Tenant;
let member: string;
let owner: string;
let bOwner: string;

beforeAll(async () => {
  A = await seedTenant("dev-a", "DVA");
  B = await seedTenant("dev-b", "DVB");
  member = `tly_session=${await newSession(A, "member")}`;
  owner = `tly_session=${await newSession(A, "owner")}`;
  bOwner = `tly_session=${await newSession(B, "owner")}`;
});

afterEach(() => {
  resetClock();
  (pairMintLimiter.store as MemoryRateStore).buckets.clear();
});

const call = async (path: string, init: RequestInit & { cookie?: string; bearer?: string } = {}) => {
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let body: Record<string, any> = {};
  try {
    body = JSON.parse(text);
  } catch {
    body = { _text: text };
  }
  return { status: res.status, body, text };
};

const wsPath = (t: Tenant, suffix: string) => `/v1/workspaces/${t.ws.slug}${suffix}`;
const mint = (cookie = member, t = A) => call(wsPath(t, "/devices/pairing"), { method: "POST", cookie, body: "{}" });
const redeem = (code: string, deviceName = "Test phone", platform = "ios") =>
  call("/v1/auth/pair/redeem", { method: "POST", body: JSON.stringify({ code, deviceName, platform }) });
const whoami = (token: string) => call("/v1/whoami", { bearer: token });
const list = (cookie = member, t = A) => call(wsPath(t, "/devices"), { cookie });

/** mint + redeem: a paired device for the member */
async function pair(name = "Test phone", cookie = member) {
  const m = await mint(cookie);
  expect(m.status).toBe(201);
  const r = await redeem(m.body.code, name);
  expect(r.status).toBe(200);
  return { token: r.body.token as string, deviceId: r.body.deviceId as string, code: m.body.code as string };
}

describe("pairing", () => {
  it("a member mints a code, the phone redeems it, and the credential works", async () => {
    const m = await mint();
    expect(m.status).toBe(201);
    expect(m.body.code).toMatch(/^tlpair_/);
    expect(m.body.expiresIn).toBe(300);
    const url = new URL(m.body.pairingUrl);
    expect(url.protocol).toBe("tallyline:");
    expect(url.searchParams.get("code")).toBe(m.body.code);
    expect(url.searchParams.get("server")).toMatch(/^https?:\/\//);

    const r = await redeem(m.body.code, "Test phone");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ tokenType: "Bearer", scopes: ["read", "write"], workspace: { slug: A.ws.slug } });
    expect(r.body.token).toMatch(/^tly_pat_/);
    const days = (new Date(r.body.expiresAt).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(89);
    expect(days).toBeLessThanOrEqual(90);

    const me = await whoami(r.body.token);
    expect(me.status).toBe(200);
    // the credential is the member, with member rights: no admin surfaces
    expect((await call(wsPath(A, "/tokens"), { bearer: r.body.token })).status).toBe(403);
    expect((await call(wsPath(A, "/devices/pairing"), { method: "POST", bearer: r.body.token, body: "{}" })).status).toBe(403);

    const l = await list();
    const mine = l.body.devices.find((d: { id: string }) => d.id === r.body.deviceId);
    expect(mine).toMatchObject({ name: "Test phone", platform: "ios", expired: false, current: false });
    // plaintext is never stored
    const rows = await db.select().from(pairingCodes).where(eq(pairingCodes.userId, A.people.member.id));
    expect(rows.some((x) => x.codeHash === m.body.code)).toBe(false);
  });

  it("a code works once; replays, wrong codes and expired codes all answer the same", async () => {
    const m = await mint();
    const first = await redeem(m.body.code);
    expect(first.status).toBe(200);
    const replay = await redeem(m.body.code);
    const wrong = await redeem("tlpair_this-code-was-never-issued");
    expect(replay.status).toBe(400);
    expect(wrong.status).toBe(400);
    expect(replay.body.error.code).toBe("INVALID_PAIRING_CODE");
    expect(replay.body).toEqual(wrong.body);

    const late = await mint();
    const base = clock.ms();
    setClock(() => base + 5 * 60_000 + 1000);
    const expired = await redeem(late.body.code);
    expect(expired.status).toBe(400);
    expect(expired.body).toEqual(wrong.body);
    resetClock();
    // expiry is purely the clock: back in time, the same code is good
    expect((await redeem(late.body.code)).status).toBe(200);
  });

  it("two simultaneous redemptions of one code produce exactly one device", async () => {
    const m = await mint();
    const before = (await db.select().from(devices).where(eq(devices.userId, A.people.member.id))).length;
    const results = await Promise.all([1, 2, 3, 4].map(() => redeem(m.body.code, "racer")));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    const after = (await db.select().from(devices).where(eq(devices.userId, A.people.member.id))).length;
    expect(after - before).toBe(1);
  });

  it("only a signed-in person mints: not agent keys, PATs, devices or other workspaces", async () => {
    const path = wsPath(A, "/devices/pairing");
    expect((await call(path, { method: "POST", body: "{}" })).status).toBe(401);
    expect((await call(path, { method: "POST", bearer: A.agentKeys.write, body: "{}" })).status).toBe(403);
    expect((await call(path, { method: "POST", bearer: A.pats.write, body: "{}" })).status).toBe(403);
    expect((await call(path, { method: "POST", cookie: bOwner, body: "{}" })).status).toBe(403);
    const dev = await pair("phone");
    expect((await call(path, { method: "POST", bearer: dev.token, body: "{}" })).status).toBe(403);
  });

  it("an unverified email can't pair a device", async () => {
    const x = await mkMember(A, "member");
    await db.update(users).set({ emailVerifiedAt: null }).where(eq(users.id, x.userId));
    const cookie = `tly_session=${await createSession(x.userId, A.ws.id)}`;
    const r = await mint(cookie);
    expect(r.status).toBe(403);
    expect(r.text).toContain("EMAIL_UNVERIFIED");
  });

  it("limits minting speed per person", async () => {
    const x = await mkMember(A, "member");
    await db.update(users).set({ emailVerifiedAt: new Date() }).where(eq(users.id, x.userId));
    const cookie = `tly_session=${await createSession(x.userId, A.ws.id)}`;
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) {
      const r = await mint(cookie);
      codes.push(r.status);
      if (r.status === 201) await redeem(r.body.code, `p${i}`);
    }
    expect(codes.slice(0, 10).every((c) => c === 201)).toBe(true);
    expect(codes.slice(10)).toEqual([429, 429]);
  });

  it("limits unused codes per person", async () => {
    const x = await mkMember(A, "member");
    await db.update(users).set({ emailVerifiedAt: new Date() }).where(eq(users.id, x.userId));
    const cookie = `tly_session=${await createSession(x.userId, A.ws.id)}`;
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) codes.push((await mint(cookie)).status);
    expect(codes).toEqual([201, 201, 201, 201, 201, 429]);
  });

  it("a code minted by someone who has since left the workspace is dead", async () => {
    const x = await mkMember(A, "member");
    await db.update(users).set({ emailVerifiedAt: new Date() }).where(eq(users.id, x.userId));
    const cookie = `tly_session=${await createSession(x.userId, A.ws.id)}`;
    const m = await mint(cookie);
    expect(m.status).toBe(201);
    await db.delete(workspaceMembers).where(eq(workspaceMembers.id, x.memberRowId));
    expect((await redeem(m.body.code)).status).toBe(400);
  });

  it("keeps credential-looking text out of the token name", async () => {
    const dev = await pair("tly_pat_sneaky phone");
    const [t] = await db
      .select({ name: userTokens.name })
      .from(devices)
      .innerJoin(userTokens, eq(userTokens.id, devices.tokenId))
      .where(eq(devices.id, dev.deviceId));
    expect(t!.name.toLowerCase()).not.toContain("tly_");
  });

  it("writes audit events without the code or token", async () => {
    const dev = await pair("audited phone");
    const rows = await db
      .select()
      .from(events)
      .where(and(eq(events.workspaceId, A.ws.id), eq(events.entityType, "device")));
    expect(rows.some((e) => e.action === "device_paired" && e.entityId === dev.deviceId)).toBe(true);
    const all = JSON.stringify(rows);
    expect(all).not.toContain(dev.token);
    expect(all).not.toContain(dev.code);
  });
});

describe("devices", () => {
  it("revoking stops the credential on its very next call and hides the device", async () => {
    const dev = await pair("to revoke");
    expect((await whoami(dev.token)).status).toBe(200);
    const del = await call(wsPath(A, `/devices/${dev.deviceId}`), { method: "DELETE", cookie: member });
    expect(del.status).toBe(200);
    expect((await whoami(dev.token)).status).toBe(401);
    expect((await list()).body.devices.some((d: { id: string }) => d.id === dev.deviceId)).toBe(false);
    expect((await call(wsPath(A, `/devices/${dev.deviceId}`), { method: "DELETE", cookie: member })).status).toBe(404);
  });

  it("nobody revokes or lists someone else's devices, in or out of the workspace", async () => {
    const dev = await pair("mine");
    expect((await call(wsPath(A, `/devices/${dev.deviceId}`), { method: "DELETE", cookie: owner })).status).toBe(404);
    expect((await call(wsPath(A, `/devices/${dev.deviceId}`), { method: "DELETE", cookie: bOwner })).status).toBe(403);
    expect((await call(wsPath(A, "/devices"), { cookie: bOwner })).status).toBe(403);
    expect((await list(owner)).body.devices.some((d: { id: string }) => d.id === dev.deviceId)).toBe(false);
    expect((await call(wsPath(A, `/devices/${dev.deviceId}`), { method: "DELETE", bearer: dev.token })).status).toBe(403);
    expect((await call(wsPath(A, "/devices/not-a-uuid"), { method: "DELETE", cookie: member })).status).toBe(404);
    expect((await whoami(dev.token)).status).toBe(200);
  });

  it("a device can sign itself out; an ordinary PAT is not a device", async () => {
    const dev = await pair("signs out");
    expect((await call(wsPath(A, "/devices/current"), { method: "DELETE", bearer: dev.token })).status).toBe(200);
    expect((await whoami(dev.token)).status).toBe(401);
    const pat = (await createUserToken(A.people.member.id, A.ws.id, "plain pat", ["read", "write"])).token;
    expect((await call(wsPath(A, "/devices/current"), { method: "DELETE", bearer: pat })).status).toBe(404);
    expect((await call(wsPath(A, "/devices/current/rotate"), { method: "POST", bearer: pat, body: "{}" })).status).toBe(404);
    expect((await call(wsPath(A, "/devices/current/rotate"), { method: "POST", cookie: member, body: "{}" })).status).toBe(403);
    expect((await whoami(pat)).status).toBe(200);
  });

  it("a device's token revoked in Settings marks the device as needing to pair again", async () => {
    const dev = await pair("token deleted");
    const [d] = await db.select().from(devices).where(eq(devices.id, dev.deviceId));
    await db.delete(userTokens).where(eq(userTokens.id, d!.tokenId!));
    const row = (await list()).body.devices.find((x: { id: string }) => x.id === dev.deviceId);
    expect(row.expired).toBe(true);
    expect((await whoami(dev.token)).status).toBe(401);
  });

  it("a paired phone can't list devices; that is for people", async () => {
    const dev = await pair("phone lists");
    expect((await call(wsPath(A, "/devices"), { bearer: dev.token })).status).toBe(403);
  });
});

describe("rotation", () => {
  it("swaps the credential; the old one lives ten more minutes and can't rotate again", async () => {
    const dev = await pair("rotating");
    const rot = await call(wsPath(A, "/devices/current/rotate"), { method: "POST", bearer: dev.token, body: "{}" });
    expect(rot.status).toBe(200);
    const next = rot.body.token as string;
    expect(next).toMatch(/^tly_pat_/);
    expect(next).not.toBe(dev.token);
    expect((await whoami(next)).status).toBe(200);
    // lost-response safety: the old token still works for the grace window...
    expect((await whoami(dev.token)).status).toBe(200);
    // ...but only the current one can rotate
    expect((await call(wsPath(A, "/devices/current/rotate"), { method: "POST", bearer: dev.token, body: "{}" })).status).toBe(404);
    const base = clock.ms();
    setClock(() => base + 11 * 60_000);
    expect((await whoami(dev.token)).status).toBe(401);
    expect((await whoami(next)).status).toBe(200);
  });

  it("revoking after a rotation kills both credentials at once", async () => {
    const dev = await pair("rotated then revoked");
    const rot = await call(wsPath(A, "/devices/current/rotate"), { method: "POST", bearer: dev.token, body: "{}" });
    await call(wsPath(A, `/devices/${dev.deviceId}`), { method: "DELETE", cookie: member });
    expect((await whoami(dev.token)).status).toBe(401);
    expect((await whoami(rot.body.token)).status).toBe(401);
  });

  it("never extends a token that was about to lapse, and drops the older grace token", async () => {
    const dev = await pair("chain");
    const r1 = await call(wsPath(A, "/devices/current/rotate"), { method: "POST", bearer: dev.token, body: "{}" });
    const r2 = await call(wsPath(A, "/devices/current/rotate"), { method: "POST", bearer: r1.body.token, body: "{}" });
    expect(r2.status).toBe(200);
    // two rotations back is gone immediately
    expect((await whoami(dev.token)).status).toBe(401);
    expect((await whoami(r1.body.token)).status).toBe(200);
    expect((await whoami(r2.body.token)).status).toBe(200);
  });
});
