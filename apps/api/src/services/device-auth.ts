import { createHash, randomBytes, randomInt } from "node:crypto";
import { and, eq, lt, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { deviceAuthorizations, events } from "../db/schema.js";
import { clock } from "./clock.js";
import { createUserToken } from "./tokens.js";

// RFC 8628 device authorization for headless clients (the CLI first).
//
// Why this exists: OAuth access tokens are audience-bound to /mcp and cannot
// call /v1, so a CLI cannot sign in through the OAuth server. Instead the human
// approves in the browser and the CLI receives a personal access token (the same
// credential Settings -> Tokens mints, with the same scopes rules).

export const DEVICE_TTL_S = 600;
export const DEVICE_INTERVAL_S = 5;
const SLOW_DOWN_STEP_S = 5;
export const MAX_PENDING_PER_IP = 20;

// no vowels (no accidental words) and no look-alikes (0/O, 1/I/L)
const ALPHABET = "BCDFGHJKMNPQRSTVWXZ23456789";
const CODE_LEN = 8;

export const DEVICE_PAT_TTL_DAYS = 90;

export function hashDeviceCode(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

/** "bcdf-g2h3" / " BCDFG2H3 " -> "BCDFG2H3"; anything else stays unmatched. */
export function normalizeUserCode(raw: string): string {
  return raw.replace(/[\s-]/g, "").toUpperCase();
}

export function formatUserCode(normalized: string): string {
  return `${normalized.slice(0, 4)}-${normalized.slice(4)}`;
}

function newUserCode(): string {
  let out = "";
  for (let i = 0; i < CODE_LEN; i++) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}

export interface DeviceStart {
  deviceCode: string;
  userCode: string; // display form XXXX-XXXX
  expiresIn: number;
  interval: number;
}

export class DeviceAuthError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 429,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "DeviceAuthError";
  }
}

const cleanClientName = (raw: unknown): string => {
  const s = typeof raw === "string" ? raw.replace(/[\u0000-\u001f\u007f]/g, " ").trim() : "";
  return (s || "Tallyline CLI").slice(0, 80);
};

export async function startDeviceAuthorization(input: {
  clientName?: unknown;
  requestIp: string;
}): Promise<DeviceStart> {
  const now = clock.now();
  // opportunistic sweep: finished handshakes older than an hour are noise
  await db
    .delete(deviceAuthorizations)
    .where(lt(deviceAuthorizations.expiresAt, new Date(now.getTime() - 3_600_000)));

  const [{ n } = { n: 0 }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(deviceAuthorizations)
    .where(
      and(
        eq(deviceAuthorizations.requestIp, input.requestIp),
        eq(deviceAuthorizations.status, "pending"),
        sql`${deviceAuthorizations.expiresAt} > ${now}`,
      ),
    );
  if (n >= MAX_PENDING_PER_IP) {
    throw new DeviceAuthError(429, "RATE_LIMITED", "too many sign-in codes are waiting; try again in a few minutes");
  }

  const deviceCode = randomBytes(32).toString("base64url");
  for (let attempt = 0; attempt < 5; attempt++) {
    const userCode = newUserCode();
    // a live code must be unique; a collision just draws a new one
    const live = await db
      .select({ id: deviceAuthorizations.id })
      .from(deviceAuthorizations)
      .where(
        and(
          eq(deviceAuthorizations.userCode, userCode),
          sql`${deviceAuthorizations.expiresAt} > ${now}`,
        ),
      )
      .limit(1);
    if (live.length) continue;
    await db.insert(deviceAuthorizations).values({
      deviceCodeHash: hashDeviceCode(deviceCode),
      userCode,
      clientName: cleanClientName(input.clientName),
      requestIp: input.requestIp,
      intervalS: DEVICE_INTERVAL_S,
      expiresAt: new Date(now.getTime() + DEVICE_TTL_S * 1000),
    });
    return {
      deviceCode,
      userCode: formatUserCode(userCode),
      expiresIn: DEVICE_TTL_S,
      interval: DEVICE_INTERVAL_S,
    };
  }
  throw new DeviceAuthError(429, "RATE_LIMITED", "couldn't make a sign-in code; try again");
}

export interface PendingView {
  clientName: string;
  requestIp: string | null;
  requestedAt: Date;
  expiresAt: Date;
}

// Uniform "no such code" for wrong, expired, already-decided and used codes, so
// the approve endpoints are not an oracle for what codes exist.
const NOT_FOUND = () =>
  new DeviceAuthError(404, "NOT_FOUND", "that code isn't valid; start again from the app that showed it");

async function pendingByUserCode(raw: string) {
  const code = normalizeUserCode(raw);
  if (code.length !== CODE_LEN) throw NOT_FOUND();
  const [row] = await db
    .select()
    .from(deviceAuthorizations)
    .where(
      and(
        eq(deviceAuthorizations.userCode, code),
        eq(deviceAuthorizations.status, "pending"),
        sql`${deviceAuthorizations.expiresAt} > ${clock.now()}`,
      ),
    )
    .limit(1);
  if (!row) throw NOT_FOUND();
  return row;
}

export async function lookupPending(rawUserCode: string): Promise<PendingView> {
  const row = await pendingByUserCode(rawUserCode);
  return {
    clientName: row.clientName,
    requestIp: row.requestIp,
    requestedAt: row.createdAt,
    expiresAt: row.expiresAt,
  };
}

export async function decide(input: {
  userCode: string;
  decision: "approve" | "deny";
  userId: string;
  workspaceId: string;
  scopes: string[];
}): Promise<void> {
  const row = await pendingByUserCode(input.userCode);
  // compare-and-set so two tabs can't both decide
  const decided = await db
    .update(deviceAuthorizations)
    .set(
      input.decision === "approve"
        ? {
            status: "approved",
            userId: input.userId,
            approvedWorkspaceId: input.workspaceId,
            scopes: input.scopes,
            decidedAt: clock.now(),
          }
        : { status: "denied", decidedAt: clock.now() },
    )
    .where(and(eq(deviceAuthorizations.id, row.id), eq(deviceAuthorizations.status, "pending")))
    .returning({ id: deviceAuthorizations.id });
  if (!decided.length) throw NOT_FOUND();
  await db.insert(events).values({
    workspaceId: input.workspaceId,
    actorType: "human",
    actorId: input.userId,
    action: input.decision === "approve" ? "device_authorized" : "device_denied",
    entityType: "device_authorization",
    entityId: row.id,
    after: { client: row.clientName },
  });
}

export type PollResult =
  | { kind: "token"; token: string; scopes: string[]; workspaceId: string }
  | { kind: "error"; error: "authorization_pending" | "slow_down" | "access_denied" | "expired_token"; interval?: number };

/**
 * The polling endpoint. RFC 8628 §3.5 errors; the token is minted only on the
 * single poll that wins the approved -> consumed compare-and-set, so replaying
 * the device code returns `expired_token`, never a second credential.
 */
export async function pollDeviceAuthorization(deviceCode: string): Promise<PollResult> {
  const now = clock.now();
  const hash = hashDeviceCode(deviceCode);
  const [row] = await db
    .select()
    .from(deviceAuthorizations)
    .where(eq(deviceAuthorizations.deviceCodeHash, hash))
    .limit(1);
  if (!row || row.status === "consumed" || row.expiresAt <= now) {
    return { kind: "error", error: "expired_token" };
  }
  if (row.status === "denied") return { kind: "error", error: "access_denied" };

  // polling faster than the interval is told to slow down, and pays for it
  if (row.lastPolledAt && now.getTime() - row.lastPolledAt.getTime() < row.intervalS * 1000) {
    const interval = row.intervalS + SLOW_DOWN_STEP_S;
    await db
      .update(deviceAuthorizations)
      .set({ intervalS: interval, lastPolledAt: now })
      .where(eq(deviceAuthorizations.id, row.id));
    return { kind: "error", error: "slow_down", interval };
  }
  await db.update(deviceAuthorizations).set({ lastPolledAt: now }).where(eq(deviceAuthorizations.id, row.id));

  if (row.status === "pending") return { kind: "error", error: "authorization_pending" };

  // approved: win the consume race, then mint
  const won = await db
    .update(deviceAuthorizations)
    .set({ status: "consumed" })
    .where(and(eq(deviceAuthorizations.id, row.id), eq(deviceAuthorizations.status, "approved")))
    .returning({ id: deviceAuthorizations.id });
  if (!won.length || !row.userId || !row.approvedWorkspaceId) return { kind: "error", error: "expired_token" };
  const { token } = await createUserToken(
    row.userId,
    row.approvedWorkspaceId,
    `${row.clientName} (device sign-in)`,
    row.scopes,
    new Date(now.getTime() + DEVICE_PAT_TTL_DAYS * 86_400_000),
  );
  return { kind: "token", token, scopes: row.scopes, workspaceId: row.approvedWorkspaceId };
}
