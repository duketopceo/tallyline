import { generateKeyPairSync, randomBytes, sign, verify, createPublicKey } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { providerToken, type ApnsResult, type ApnsSender } from "./apns.js";
import { ALERT_TEXT, b64url, openHandle, sealHandle, serverKeyId } from "./protocol.js";
import { createRelay } from "./relay.js";

const TOKEN = "a".repeat(64);

function serverKeys() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = Buffer.from(publicKey.export({ format: "jwk" }).x!, "base64url");
  return { raw, privateKey };
}

class FakeApns implements ApnsSender {
  sent: { token: string; env: string; payload: Record<string, unknown> }[] = [];
  next: ApnsResult = { status: 200 };
  async send(token: string, env: "sandbox" | "production", payload: Record<string, unknown>) {
    this.sent.push({ token, env, payload });
    return this.next;
  }
  close() {}
}

let server: Server;
let base: string;
let apns: FakeApns;
let clock: number;
const handleKey = randomBytes(32);

async function start(opts: { perHandle?: number } = {}) {
  apns = new FakeApns();
  const h = createRelay({ handleKey, apns, now: () => clock, ...opts });
  server = createServer((req, res) => void h(req, res));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

beforeEach(async () => {
  clock = Date.UTC(2026, 9, 30, 12, 0, 0);
  await start();
});
afterEach(async () => {
  await new Promise((r) => server.close(r));
});

async function mint(serverKey: Buffer, env = "sandbox") {
  const res = await fetch(`${base}/v1/handles`, {
    method: "POST",
    body: JSON.stringify({ token: TOKEN, environment: env, serverKey: b64url(serverKey) }),
  });
  return { status: res.status, body: (await res.json()) as { handle?: string; error?: { code: string } } };
}

let nonceN = 0;
async function ping(
  keys: ReturnType<typeof serverKeys>,
  handle: string,
  over: Record<string, unknown> = {},
  signWith = keys.privateKey,
) {
  const body = Buffer.from(
    JSON.stringify({ v: 1, handle, kind: "mention", badge: 3, ts: clock, nonce: `nonce-${++nonceN}-${"x".repeat(12)}`, ...over }),
  );
  const res = await fetch(`${base}/v1/push`, {
    method: "POST",
    headers: {
      "x-tallyline-server-key": b64url(keys.raw),
      "x-tallyline-signature": b64url(sign(null, body, signWith)),
    },
    body,
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("handles", () => {
  it("seal and open round-trip, bound to the server key", () => {
    const k = serverKeys();
    const h = sealHandle(handleKey, TOKEN, "production", k.raw);
    expect(h.startsWith("h1.")).toBe(true);
    expect(h).not.toContain(TOKEN);
    expect(openHandle(handleKey, h)).toEqual({ token: TOKEN, env: "production", serverKeyId: serverKeyId(k.raw) });
  });

  it("a tampered handle or another relay's key opens to nothing", () => {
    const h = sealHandle(handleKey, TOKEN, "sandbox", serverKeys().raw);
    const raw = Buffer.from(h.slice(3), "base64url");
    raw[20] = raw[20]! ^ 0xff;
    const flipped = `h1.${b64url(raw)}`;
    expect(openHandle(handleKey, flipped)).toBeNull();
    expect(openHandle(randomBytes(32), h)).toBeNull();
    expect(openHandle(handleKey, "nope")).toBeNull();
  });

  it("minting checks the token, environment and server key", async () => {
    const k = serverKeys();
    expect((await mint(k.raw)).status).toBe(201);
    const bad = await fetch(`${base}/v1/handles`, { method: "POST", body: JSON.stringify({ token: "zz", environment: "sandbox", serverKey: b64url(k.raw) }) });
    expect(bad.status).toBe(400);
    expect((await mint(Buffer.alloc(31))).status).toBe(400);
    expect((await mint(k.raw, "staging")).status).toBe(400);
  });
});

describe("push", () => {
  it("forwards a content-free alert", async () => {
    const k = serverKeys();
    const { body } = await mint(k.raw);
    const r = await ping(k, body.handle!, { issueTitle: "secret plans" });
    expect(r.status).toBe(202);
    expect(apns.sent).toHaveLength(1);
    const sent = apns.sent[0]!;
    expect(sent.token).toBe(TOKEN);
    expect(sent.env).toBe("sandbox");
    expect(sent.payload).toEqual({
      aps: {
        alert: { title: "Tallyline", body: ALERT_TEXT.mention },
        "mutable-content": 1,
        sound: "default",
        category: "mention",
        "thread-id": "mention",
        badge: 3,
      },
      k: "mention",
    });
    expect(JSON.stringify(sent.payload)).not.toContain("secret");
  });

  it("drops a handle sealed for another server", async () => {
    const a = serverKeys();
    const b = serverKeys();
    const { body } = await mint(a.raw);
    const r = await ping(b, body.handle!);
    expect(r.status).toBe(410);
    expect(r.body.gone).toBe(true);
    expect(apns.sent).toHaveLength(0);
  });

  it("drops an unknown handle", async () => {
    const r = await ping(serverKeys(), "h1.garbage");
    expect(r.status).toBe(410);
  });

  it("rejects a bad signature, a stale clock and a replayed nonce", async () => {
    const k = serverKeys();
    const { body } = await mint(k.raw);
    expect((await ping(k, body.handle!, {}, serverKeys().privateKey)).status).toBe(401);
    expect((await ping(k, body.handle!, { ts: clock - 10 * 60_000 })).status).toBe(401);
    expect((await ping(k, body.handle!, { nonce: "same-nonce-0123456789" })).status).toBe(202);
    expect((await ping(k, body.handle!, { nonce: "same-nonce-0123456789" })).status).toBe(409);
  });

  it("rejects unknown kinds and unsigned requests", async () => {
    const k = serverKeys();
    const { body } = await mint(k.raw);
    expect((await ping(k, body.handle!, { kind: "comment_text" })).status).toBe(400);
    const res = await fetch(`${base}/v1/push`, { method: "POST", body: "{}" });
    expect(res.status).toBe(401);
  });

  it("tells the server to forget a device APNs no longer knows", async () => {
    const k = serverKeys();
    const { body } = await mint(k.raw);
    apns.next = { status: 410, reason: "Unregistered" };
    const r = await ping(k, body.handle!);
    expect(r.status).toBe(410);
    expect(r.body).toEqual({ gone: true, reason: "Unregistered" });
  });

  it("rate-limits pings per device", async () => {
    await new Promise((r) => server.close(r));
    await start({ perHandle: 2 });
    const k = serverKeys();
    const { body } = await mint(k.raw);
    expect((await ping(k, body.handle!)).status).toBe(202);
    expect((await ping(k, body.handle!)).status).toBe(202);
    expect((await ping(k, body.handle!)).status).toBe(429);
    clock += 61_000;
    expect((await ping(k, body.handle!)).status).toBe(202);
  });

  it("upstream failure is a 502, not a crash", async () => {
    const k = serverKeys();
    const { body } = await mint(k.raw);
    apns.next = { status: 0, reason: "connection" };
    expect((await ping(k, body.handle!)).status).toBe(502);
    expect((await fetch(`${base}/health`)).status).toBe(200);
  });
});

describe("APNs provider token", () => {
  it("is an ES256 JWT with the team and key ids", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const t = providerToken(privateKey, "TEAM123456", "KEY1234567", 1_800_000_000);
    const [h, c, s] = t.split(".");
    expect(JSON.parse(Buffer.from(h!, "base64url").toString())).toEqual({ alg: "ES256", kid: "KEY1234567" });
    expect(JSON.parse(Buffer.from(c!, "base64url").toString())).toEqual({ iss: "TEAM123456", iat: 1_800_000_000 });
    const ok = verify(
      "sha256",
      Buffer.from(`${h}.${c}`),
      { key: createPublicKey(publicKey.export({ format: "pem", type: "spki" })), dsaEncoding: "ieee-p1363" },
      Buffer.from(s!, "base64url"),
    );
    expect(ok).toBe(true);
  });
});
