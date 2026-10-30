import { createPrivateKey, createPublicKey, hkdfSync, randomBytes, sign, type KeyObject } from "node:crypto";
import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { db } from "../db/client.js";
import { devices, notificationKinds, pushPreferences } from "../db/schema.js";
import { config_ } from "../env.js";
import { clock } from "./clock.js";
import { unreadCount } from "./notifications.js";

// S4-U3: content-free pings to phones through the Tallyline push relay
// (apps/push-relay, docs/push.md). Off unless TALLYLINE_PUSH_RELAY_URL is set.
//
// What leaves this server per ping: the relay handle the phone gave us, the
// notification kind, the unread count and a nonce, signed with this server's
// Ed25519 key. Never an issue key, title, comment or person's name. The app
// fetches the real item from this server after the ping arrives.

export type PushKind = (typeof notificationKinds)[number];
export const PUSH_KINDS: readonly PushKind[] = notificationKinds;

const PKCS8_ED25519 = Buffer.from("302e020100300506032b657004220420", "hex");
const TIMEOUT_MS = 5_000;

let cached: { secret: string; key: KeyObject; pub: string } | null = null;

/** this server's signing key, derived from AUTH_SECRET_KEY (JWT_SECRET in dev).
 *  Rotating that secret changes the key; phones re-register on next launch. */
function signingKey(): { key: KeyObject; pub: string } {
  const secret = config_.authSecretKey || config_.jwtSecret;
  if (cached?.secret === secret) return cached;
  const seed = Buffer.from(hkdfSync("sha256", secret, "tallyline", "push-relay signing v1", 32));
  const key = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, seed]), format: "der", type: "pkcs8" });
  const x = createPublicKey(key).export({ format: "jwk" }).x;
  if (!x) throw new Error("could not derive the push signing key");
  cached = { secret, key, pub: x };
  return cached;
}

/** the relay base URL, or null when push is off or the URL is unusable */
export function relayUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.TALLYLINE_PUSH_RELAY_URL?.trim();
  if (!raw) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";
  if (u.protocol !== "https:" && !(local && u.protocol === "http:")) return null;
  return u.toString().replace(/\/+$/, "");
}

export interface PushConfig {
  enabled: boolean;
  relayUrl: string | null;
  serverKey: string | null;
  kinds: readonly PushKind[];
}

export function pushConfig(): PushConfig {
  const url = relayUrl();
  return {
    enabled: url !== null,
    relayUrl: url,
    serverKey: url ? signingKey().pub : null,
    kinds: PUSH_KINDS,
  };
}

// --- preferences ---------------------------------------------------------------

export interface PushPrefs {
  disabledKinds: PushKind[];
  quietStart: number | null;
  quietEnd: number | null;
  tz: string | null;
}

const DEFAULT_PREFS: PushPrefs = { disabledKinds: [], quietStart: null, quietEnd: null, tz: null };

export async function getPrefs(workspaceId: string, userId: string): Promise<PushPrefs> {
  const [r] = await db
    .select()
    .from(pushPreferences)
    .where(and(eq(pushPreferences.workspaceId, workspaceId), eq(pushPreferences.userId, userId)));
  if (!r) return { ...DEFAULT_PREFS };
  return {
    disabledKinds: r.disabledKinds.filter((k): k is PushKind => (PUSH_KINDS as readonly string[]).includes(k)),
    quietStart: r.quietStart,
    quietEnd: r.quietEnd,
    tz: r.tz,
  };
}

export async function setPrefs(workspaceId: string, userId: string, p: PushPrefs): Promise<PushPrefs> {
  const row = { ...p, disabledKinds: [...new Set(p.disabledKinds)], updatedAt: clock.now() };
  await db
    .insert(pushPreferences)
    .values({ workspaceId, userId, ...row })
    .onConflictDoUpdate({ target: [pushPreferences.workspaceId, pushPreferences.userId], set: row });
  return getPrefs(workspaceId, userId);
}

/** minutes after local midnight in `tz`, or null for an unknown zone */
function localMinutes(at: Date, tz: string): number | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(at);
    const h = Number(parts.find((x) => x.type === "hour")?.value);
    const m = Number(parts.find((x) => x.type === "minute")?.value);
    return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : null;
  } catch {
    return null;
  }
}

/** inside the quiet window? A window may wrap midnight (22:00 to 07:00). */
export function isQuiet(p: PushPrefs, at: Date): boolean {
  if (p.quietStart === null || p.quietEnd === null || !p.tz || p.quietStart === p.quietEnd) return false;
  const m = localMinutes(at, p.tz);
  if (m === null) return false;
  return p.quietStart < p.quietEnd ? m >= p.quietStart && m < p.quietEnd : m >= p.quietStart || m < p.quietEnd;
}

export function isValidTimeZone(tz: string): boolean {
  return localMinutes(new Date(0), tz) !== null;
}

// --- device handles --------------------------------------------------------------

export async function setDeviceHandle(deviceId: string, handle: string | null, env: "sandbox" | "production" | null) {
  await db
    .update(devices)
    .set({ pushHandle: handle, pushEnv: env, pushUpdatedAt: clock.now() })
    .where(eq(devices.id, deviceId));
}

// --- sending ---------------------------------------------------------------------

export type RelayFetch = (url: string, init: RequestInit) => Promise<Response>;
let relayFetch: RelayFetch = (url, init) => fetch(url, init);
/** tests swap the network for a fake relay */
export function setRelayFetch(f: RelayFetch | null): void {
  relayFetch = f ?? ((url, init) => fetch(url, init));
}

export interface Ping {
  v: 1;
  handle: string;
  kind: PushKind;
  badge: number;
  ts: number;
  nonce: string;
}

export function signPing(p: Ping): { body: string; headers: Record<string, string> } {
  const { key, pub } = signingKey();
  const body = JSON.stringify(p);
  return {
    body,
    headers: {
      "content-type": "application/json",
      "x-tallyline-server-key": pub,
      "x-tallyline-signature": sign(null, Buffer.from(body), key).toString("base64url"),
    },
  };
}

/** returns how many pings the relay accepted. Never throws for relay trouble. */
export async function pushToUsers(workspaceId: string, userIds: string[], kind: PushKind): Promise<number> {
  const base = relayUrl();
  if (!base || userIds.length === 0) return 0;
  const rows = await db
    .select({ id: devices.id, userId: devices.userId, handle: devices.pushHandle })
    .from(devices)
    .where(
      and(
        eq(devices.workspaceId, workspaceId),
        inArray(devices.userId, userIds),
        isNull(devices.revokedAt),
        isNotNull(devices.pushHandle),
      ),
    );
  if (rows.length === 0) return 0;

  let accepted = 0;
  const now = clock.now();
  const byUser = new Map<string, typeof rows>();
  for (const r of rows) byUser.set(r.userId, [...(byUser.get(r.userId) ?? []), r]);
  for (const [userId, list] of byUser) {
    const prefs = await getPrefs(workspaceId, userId);
    if (prefs.disabledKinds.includes(kind) || isQuiet(prefs, now)) continue;
    const badge = await unreadCount(workspaceId, userId);
    for (const d of list) {
      if (!d.handle) continue;
      const signed = signPing({ v: 1, handle: d.handle, kind, badge, ts: now.getTime(), nonce: randomBytes(16).toString("base64url") });
      try {
        const res = await relayFetch(`${base}/v1/push`, {
          method: "POST",
          headers: signed.headers,
          body: signed.body,
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (res.status === 202) accepted += 1;
        else if (res.status === 410) {
          // the relay or APNs no longer knows this phone; forget the handle
          // only if it hasn't been replaced meanwhile
          await db
            .update(devices)
            .set({ pushHandle: null, pushEnv: null, pushUpdatedAt: clock.now() })
            .where(and(eq(devices.id, d.id), eq(devices.pushHandle, d.handle)));
        } else {
          console.warn(`push: relay answered ${res.status} for one device`);
        }
      } catch {
        console.warn("push: relay unreachable");
      }
    }
  }
  return accepted;
}
