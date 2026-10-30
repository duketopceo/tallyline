import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
// the real relay, in-process: proves the server's signature and the relay's
// check agree byte for byte
import { createRelay } from "../../../push-relay/src/relay.js";
import type { ApnsResult, ApnsSender } from "../../../push-relay/src/apns.js";
import { db } from "../db/client.js";
import { devices } from "../db/schema.js";
import { app } from "../index.js";
import type { MemoryRateStore } from "../lib/rate-limit.js";
import { settleBackground } from "../services/background.js";
import { clock, resetClock, setClock } from "../services/clock.js";
import { notifyUsers } from "../services/notifications.js";
import { isQuiet, pushToUsers } from "../services/push.js";
import { newSession, seedTenant, type Tenant } from "../../test/tenants.js";
import { pairMintLimiter } from "./devices.js";

// S4-U3: content-free pings through the relay. Off unless configured.

class FakeApns implements ApnsSender {
  sent: { token: string; payload: Record<string, unknown> }[] = [];
  next: ApnsResult = { status: 200 };
  async send(token: string, _env: "sandbox" | "production", payload: Record<string, unknown>) {
    this.sent.push({ token, payload });
    return this.next;
  }
  close() {}
}

const DEVICE_TOKEN = "ab".repeat(32);
let A: Tenant;
let owner: string;
let relay: Server;
let relayBase: string;
let apns: FakeApns;

beforeAll(async () => {
  A = await seedTenant("push-a", "PSA");
  owner = `tly_session=${await newSession(A, "owner")}`;
  apns = new FakeApns();
  const h = createRelay({ handleKey: randomBytes(32), apns, now: clock.ms });
  relay = createServer((req, res) => void h(req, res));
  await new Promise<void>((r) => relay.listen(0, "127.0.0.1", r));
  relayBase = `http://127.0.0.1:${(relay.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise((r) => relay.close(r));
});
afterEach(async () => {
  await settleBackground();
  delete process.env.TALLYLINE_PUSH_RELAY_URL;
  resetClock();
  apns.sent = [];
  apns.next = { status: 200 };
  await db.update(devices).set({ pushHandle: null, pushEnv: null }).where(eq(devices.workspaceId, A.ws.id));
  (pairMintLimiter.store as MemoryRateStore).buckets.clear();
});

const on = () => {
  process.env.TALLYLINE_PUSH_RELAY_URL = relayBase;
};

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
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    body = { _text: text };
  }
  return { status: res.status, body };
};
const ws = (s: string) => `/v1/workspaces/${A.ws.slug}${s}`;

async function pairPhone() {
  const m = await call(ws("/devices/pairing"), { method: "POST", cookie: owner, body: "{}" });
  const r = await call("/v1/auth/pair/redeem", {
    method: "POST",
    body: JSON.stringify({ code: m.body.code, deviceName: "Test phone", platform: "ios" }),
  });
  return { token: r.body.token as string, deviceId: r.body.deviceId as string };
}

/** the app's side: config → relay handle → hand it to the server */
async function registerPush(token: string) {
  const cfg = await call(ws("/push/config"), { bearer: token });
  expect(cfg.body.enabled).toBe(true);
  const h = await fetch(`${relayBase}/v1/handles`, {
    method: "POST",
    body: JSON.stringify({ token: DEVICE_TOKEN, environment: "sandbox", serverKey: cfg.body.serverKey }),
  });
  const { handle } = (await h.json()) as { handle: string };
  const put = await call(ws("/devices/current/push"), {
    method: "PUT",
    bearer: token,
    body: JSON.stringify({ handle, environment: "sandbox" }),
  });
  expect(put.status).toBe(200);
  return handle;
}

const ownerId = () => A.people.owner.id;

describe("push off (default)", () => {
  it("config says off and a device can't register", async () => {
    const { token } = await pairPhone();
    const cfg = await call(ws("/push/config"), { cookie: owner });
    expect(cfg.body).toMatchObject({ enabled: false, relayUrl: null, serverKey: null });
    const put = await call(ws("/devices/current/push"), {
      method: "PUT",
      bearer: token,
      body: JSON.stringify({ handle: "h1.x", environment: "sandbox" }),
    });
    expect(put.status).toBe(409);
    expect(await pushToUsers(A.ws.id, [ownerId()], "mention")).toBe(0);
  });

  it("a plain-http relay that isn't local is refused, so push stays off", async () => {
    process.env.TALLYLINE_PUSH_RELAY_URL = "http://relay.example.test";
    const cfg = await call(ws("/push/config"), { cookie: owner });
    expect(cfg.body.enabled).toBe(false);
  });
});

describe("push on", () => {
  it("a notification sends a content-free ping with the unread count", async () => {
    on();
    const { token } = await pairPhone();
    await registerPush(token);
    await notifyUsers(A.ws.id, [ownerId()], { kind: "mention" });
    await settleBackground();
    expect(apns.sent).toHaveLength(1);
    const p = apns.sent[0]!;
    expect(p.token).toBe(DEVICE_TOKEN);
    const text = JSON.stringify(p.payload);
    expect(text).not.toContain(A.ws.slug);
    expect(text).not.toContain(A.sentinel);
    expect(text).not.toMatch(/PSA-\d/);
    const aps = p.payload.aps as { badge: number; category: string };
    expect(aps.category).toBe("mention");
    expect(aps.badge).toBeGreaterThanOrEqual(1);
  });

  it("respects turned-off kinds and quiet hours", async () => {
    on();
    const { token } = await pairPhone();
    await registerPush(token);
    const bad = await call(ws("/push/preferences"), {
      method: "PUT",
      cookie: owner,
      body: JSON.stringify({ disabledKinds: [], quietStart: 60, quietEnd: 120, tz: null }),
    });
    expect(bad.status).toBe(400);
    const badTz = await call(ws("/push/preferences"), {
      method: "PUT",
      cookie: owner,
      body: JSON.stringify({ disabledKinds: [], quietStart: null, quietEnd: null, tz: "Mars/Olympus" }),
    });
    expect(badTz.status).toBe(400);

    const set = await call(ws("/push/preferences"), {
      method: "PUT",
      cookie: owner,
      body: JSON.stringify({ disabledKinds: ["assigned"], quietStart: 22 * 60, quietEnd: 7 * 60, tz: "UTC" }),
    });
    expect(set.status).toBe(200);
    expect(set.body).toEqual({ disabledKinds: ["assigned"], quietStart: 1320, quietEnd: 420, tz: "UTC" });

    setClock(() => Date.parse("2026-10-30T12:00:00Z"));
    expect(await pushToUsers(A.ws.id, [ownerId()], "assigned")).toBe(0);
    expect(await pushToUsers(A.ws.id, [ownerId()], "mention")).toBe(1);
    setClock(() => Date.parse("2026-10-30T23:30:00Z"));
    expect(await pushToUsers(A.ws.id, [ownerId()], "mention")).toBe(0);

    await call(ws("/push/preferences"), {
      method: "PUT",
      cookie: owner,
      body: JSON.stringify({ disabledKinds: [], quietStart: null, quietEnd: null, tz: null }),
    });
  });

  it("a revoked device is dropped", async () => {
    on();
    const { token, deviceId } = await pairPhone();
    await registerPush(token);
    expect((await call(ws(`/devices/${deviceId}`), { method: "DELETE", cookie: owner })).status).toBe(200);
    const [d] = await db.select().from(devices).where(eq(devices.id, deviceId));
    expect(d!.pushHandle).toBeNull();
    expect(await pushToUsers(A.ws.id, [ownerId()], "mention")).toBe(0);
    expect(apns.sent).toHaveLength(0);
  });

  it("forgets a phone APNs no longer knows", async () => {
    on();
    const { token, deviceId } = await pairPhone();
    await registerPush(token);
    apns.next = { status: 410, reason: "Unregistered" };
    await pushToUsers(A.ws.id, [ownerId()], "mention");
    const [d] = await db.select().from(devices).where(eq(devices.id, deviceId));
    expect(d!.pushHandle).toBeNull();
  });

  it("the device can turn its own push off", async () => {
    on();
    const { token, deviceId } = await pairPhone();
    await registerPush(token);
    expect((await call(ws("/devices/current/push"), { method: "DELETE", bearer: token })).status).toBe(200);
    const [d] = await db.select().from(devices).where(eq(devices.id, deviceId));
    expect(d!.pushHandle).toBeNull();
  });

  it("a dead relay never blocks the write", async () => {
    on();
    const { token } = await pairPhone();
    await registerPush(token);
    const dead = createServer();
    await new Promise<void>((r) => dead.listen(0, "127.0.0.1", r));
    const port = (dead.address() as AddressInfo).port;
    await new Promise((r) => dead.close(r));
    process.env.TALLYLINE_PUSH_RELAY_URL = `http://127.0.0.1:${port}`;
    const t0 = Date.now();
    expect(await notifyUsers(A.ws.id, [ownerId()], { kind: "mention" })).toBe(1);
    expect(Date.now() - t0).toBeLessThan(1000);
    await settleBackground();
  });
});

describe("quiet hours", () => {
  const p = (s: number, e: number) => ({ disabledKinds: [], quietStart: s, quietEnd: e, tz: "America/Denver" });
  it("wraps midnight in the person's own zone", () => {
    // 05:30 UTC = 23:30 MDT (Oct 30, 2026)
    expect(isQuiet(p(22 * 60, 7 * 60), new Date("2026-10-30T05:30:00Z"))).toBe(true);
    expect(isQuiet(p(22 * 60, 7 * 60), new Date("2026-10-30T18:00:00Z"))).toBe(false);
    expect(isQuiet(p(9 * 60, 17 * 60), new Date("2026-10-30T18:00:00Z"))).toBe(true);
    expect(isQuiet({ ...p(0, 0) }, new Date())).toBe(false);
  });
});
