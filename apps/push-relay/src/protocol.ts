import { createCipheriv, createDecipheriv, createHash, createPublicKey, randomBytes, verify } from "node:crypto";

// Wire protocol between a Tallyline server, the iOS app and this relay.
//
// 1. The app asks APNs for a device token, then POSTs it to the relay with the
//    public key of the server it is paired with. The relay answers with a
//    sealed handle: AES-256-GCM over {token, environment, server key hash}.
//    The relay stores nothing.
// 2. The app gives the handle to its own server.
// 3. To ping the phone, the server POSTs {handle, kind, badge, ts, nonce} and
//    signs the exact body bytes with its Ed25519 key. The relay checks the
//    signature, the clock, the nonce, and that the handle was sealed for that
//    same server key, then forwards a content-free alert to APNs.
//
// A leaked handle is useless to any other server; a server can only reach
// phones that chose to give it a handle.

export const KINDS = ["assigned", "mention", "review_pending", "dispatch_failed"] as const;
export type Kind = (typeof KINDS)[number];
export type ApnsEnv = "sandbox" | "production";

export const HANDLE_PREFIX = "h1.";
export const MAX_SKEW_MS = 5 * 60_000;

export const b64url = (b: Buffer): string => b.toString("base64url");
export const fromB64url = (s: string): Buffer => Buffer.from(s, "base64url");

/** short stable id for a server key; what a handle is bound to */
export function serverKeyId(rawPublicKey: Buffer): string {
  return b64url(createHash("sha256").update(rawPublicKey).digest().subarray(0, 16));
}

export function parseHandleKey(b64: string): Buffer {
  const k = Buffer.from(b64, "base64");
  if (k.length !== 32) throw new Error("PUSH_RELAY_HANDLE_KEY must be 32 bytes, base64");
  return k;
}

interface HandleBody {
  t: string;
  e: ApnsEnv;
  s: string;
  i: number;
}

export function sealHandle(key: Buffer, token: string, env: ApnsEnv, serverKey: Buffer, now = Date.now()): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(Buffer.from(HANDLE_PREFIX));
  const body: HandleBody = { t: token, e: env, s: serverKeyId(serverKey), i: Math.floor(now / 1000) };
  const ct = Buffer.concat([c.update(JSON.stringify(body), "utf8"), c.final()]);
  return HANDLE_PREFIX + b64url(Buffer.concat([iv, ct, c.getAuthTag()]));
}

export interface OpenHandle {
  token: string;
  env: ApnsEnv;
  serverKeyId: string;
}

export function openHandle(key: Buffer, handle: string): OpenHandle | null {
  if (!handle.startsWith(HANDLE_PREFIX) || handle.length > 1024) return null;
  const raw = fromB64url(handle.slice(HANDLE_PREFIX.length));
  if (raw.length < 12 + 16 + 2) return null;
  try {
    const d = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
    d.setAAD(Buffer.from(HANDLE_PREFIX));
    d.setAuthTag(raw.subarray(raw.length - 16));
    const pt = Buffer.concat([d.update(raw.subarray(12, raw.length - 16)), d.final()]).toString("utf8");
    const b = JSON.parse(pt) as Partial<HandleBody>;
    if (typeof b.t !== "string" || (b.e !== "sandbox" && b.e !== "production") || typeof b.s !== "string") return null;
    return { token: b.t, env: b.e, serverKeyId: b.s };
  } catch {
    return null;
  }
}

/** Ed25519 raw 32-byte public key → KeyObject, or null */
export function ed25519Public(raw: Buffer) {
  if (raw.length !== 32) return null;
  try {
    return createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: b64url(raw) }, format: "jwk" });
  } catch {
    return null;
  }
}

export function verifyBody(rawPublicKey: Buffer, body: Buffer, signature: Buffer): boolean {
  const k = ed25519Public(rawPublicKey);
  if (!k || signature.length !== 64) return false;
  try {
    return verify(null, body, k, signature);
  } catch {
    return false;
  }
}

export const DEVICE_TOKEN = /^[0-9a-f]{64,200}$/i;

export interface PingBody {
  v: 1;
  handle: string;
  kind: Kind;
  badge?: number;
  ts: number;
  nonce: string;
}

export function parsePing(text: string): PingBody | null {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  if (o.v !== 1 || typeof o.handle !== "string" || typeof o.ts !== "number" || typeof o.nonce !== "string") return null;
  if (!(KINDS as readonly unknown[]).includes(o.kind)) return null;
  if (o.nonce.length < 16 || o.nonce.length > 64) return null;
  if (o.badge !== undefined && (typeof o.badge !== "number" || !Number.isInteger(o.badge) || o.badge < 0 || o.badge > 99_999)) {
    return null;
  }
  const out: PingBody = { v: 1, handle: o.handle, kind: o.kind as Kind, ts: o.ts, nonce: o.nonce };
  if (typeof o.badge === "number") out.badge = o.badge;
  return out;
}

/** What the phone sees. Generic text per kind; the app's notification
 *  service extension fetches the real item from the person's own server. */
export const ALERT_TEXT: Record<Kind, string> = {
  assigned: "Something was assigned to you",
  mention: "You were mentioned",
  review_pending: "A review is waiting for you",
  dispatch_failed: "An agent run needs attention",
};

export function apnsPayload(kind: Kind, badge?: number): Record<string, unknown> {
  const aps: Record<string, unknown> = {
    alert: { title: "Tallyline", body: ALERT_TEXT[kind] },
    "mutable-content": 1,
    sound: "default",
    category: kind,
    "thread-id": kind,
  };
  if (badge !== undefined) aps.badge = badge;
  return { aps, k: kind };
}
