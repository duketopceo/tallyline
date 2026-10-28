import { randomBytes } from "node:crypto";
import { and, count, desc, eq, gt, inArray, isNull, lt, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { devices, events, pairingCodes, userTokens, workspaceMembers, workspaces } from "../db/schema.js";
import { HttpError } from "../lib/errors.js";
import { clock } from "./clock.js";
import { hashToken } from "./tokens.js";

export const PAIRING_CODE_TTL_S = 5 * 60;
export const DEVICE_TOKEN_TTL_DAYS = 90;
/** how long the replaced token keeps working after a rotation */
export const ROTATION_GRACE_MS = 10 * 60 * 1000;
const MAX_PENDING_CODES = 5;
const DEVICE_SCOPES = ["read", "write"];

export type Platform = "ios" | "android" | "other";

export class DeviceError extends HttpError {}

async function emit(workspaceId: string, actorId: string, action: string, entityId: string, after: Record<string, unknown>) {
  await db.insert(events).values({
    workspaceId,
    actorType: "human",
    actorId,
    action,
    entityType: "device",
    entityId,
    after,
  });
}

const expiryFromNow = () => new Date(clock.now().getTime() + DEVICE_TOKEN_TTL_DAYS * 86_400_000);

/** A token name shows up in Settings: keep it readable and never look like a credential. */
function tokenName(deviceName: string): string {
  return `Device: ${deviceName.replace(/tly_/gi, "")}`.slice(0, 120);
}

export async function mintPairingCode(workspaceId: string, userId: string) {
  const now = clock.now();
  // housekeeping: stale rows of this person only
  await db
    .delete(pairingCodes)
    .where(and(eq(pairingCodes.userId, userId), lt(pairingCodes.expiresAt, new Date(now.getTime() - 86_400_000))));
  const [pending] = await db
    .select({ n: count() })
    .from(pairingCodes)
    .where(
      and(
        eq(pairingCodes.userId, userId),
        eq(pairingCodes.workspaceId, workspaceId),
        isNull(pairingCodes.consumedAt),
        gt(pairingCodes.expiresAt, now),
      ),
    );
  if ((pending?.n ?? 0) >= MAX_PENDING_CODES) {
    throw new DeviceError(
      429,
      "TOO_MANY_PAIRING_CODES",
      "you already have several unused pairing codes; use one of them or wait a few minutes",
    );
  }
  const code = `tlpair_${randomBytes(18).toString("base64url")}`;
  const expiresAt = new Date(now.getTime() + PAIRING_CODE_TTL_S * 1000);
  await db.insert(pairingCodes).values({ workspaceId, userId, codeHash: hashToken(code), expiresAt });
  return { code, expiresAt, expiresIn: PAIRING_CODE_TTL_S };
}

const BAD_CODE = new DeviceError(
  400,
  "INVALID_PAIRING_CODE",
  "that pairing code didn't work. It may have expired or already been used; make a new one and scan it again",
);

/**
 * Turn a pairing code into a device and its credential. Wrong, expired,
 * replayed and revoked-member codes all answer identically.
 */
export async function redeemPairingCode(input: { code: string; deviceName: string; platform: Platform }) {
  const now = clock.now();
  const [claimed] = await db
    .update(pairingCodes)
    .set({ consumedAt: now })
    .where(
      and(
        eq(pairingCodes.codeHash, hashToken(input.code)),
        isNull(pairingCodes.consumedAt),
        gt(pairingCodes.expiresAt, now),
      ),
    )
    .returning();
  if (!claimed) throw BAD_CODE;

  const [member] = await db
    .select({ wsName: workspaces.name, wsSlug: workspaces.slug, deletedAt: workspaces.deletedAt })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
    .where(and(eq(workspaceMembers.userId, claimed.userId), eq(workspaceMembers.workspaceId, claimed.workspaceId)));
  if (!member || member.deletedAt) throw BAD_CODE;

  const name = input.deviceName.trim();
  const token = `tly_pat_${randomBytes(24).toString("base64url")}`;
  const expiresAt = expiryFromNow();
  const device = await db.transaction(async (tx) => {
    const [t] = await tx
      .insert(userTokens)
      .values({
        userId: claimed.userId,
        workspaceId: claimed.workspaceId,
        name: tokenName(name),
        tokenHash: hashToken(token),
        scopes: DEVICE_SCOPES,
        expiresAt,
      })
      .returning({ id: userTokens.id });
    const [d] = await tx
      .insert(devices)
      .values({
        workspaceId: claimed.workspaceId,
        userId: claimed.userId,
        name,
        platform: input.platform,
        tokenId: t!.id,
      })
      .returning({ id: devices.id });
    return d!;
  });
  await emit(claimed.workspaceId, claimed.userId, "device_paired", device.id, { name, platform: input.platform });
  return {
    token,
    expiresAt,
    scopes: DEVICE_SCOPES,
    deviceId: device.id,
    userId: claimed.userId,
    workspace: { slug: member.wsSlug, name: member.wsName },
  };
}

export async function listDevices(workspaceId: string, userId: string, currentTokenId: string | null) {
  const rows = await db
    .select({
      id: devices.id,
      name: devices.name,
      platform: devices.platform,
      createdAt: devices.createdAt,
      tokenId: devices.tokenId,
      lastUsedAt: userTokens.lastUsedAt,
      expiresAt: userTokens.expiresAt,
    })
    .from(devices)
    .leftJoin(userTokens, eq(userTokens.id, devices.tokenId))
    .where(and(eq(devices.workspaceId, workspaceId), eq(devices.userId, userId), isNull(devices.revokedAt)))
    .orderBy(desc(devices.createdAt));
  const now = clock.now().getTime();
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    platform: r.platform,
    pairedAt: r.createdAt.toISOString(),
    lastUsedAt: r.lastUsedAt?.toISOString() ?? null,
    expiresAt: r.expiresAt?.toISOString() ?? null,
    // a lapsed or deleted credential: the phone needs to pair again
    expired: !r.tokenId || (r.expiresAt ? r.expiresAt.getTime() <= now : false),
    current: currentTokenId !== null && r.tokenId === currentTokenId,
  }));
}

async function killTokens(ids: (string | null)[]) {
  const real = ids.filter((i): i is string => !!i);
  if (real.length) await db.delete(userTokens).where(inArray(userTokens.id, real));
}

/** Revoke one of the caller's devices: its credential stops working on the very next call. */
export async function revokeDevice(workspaceId: string, userId: string, deviceId: string): Promise<boolean> {
  const [d] = await db
    .select()
    .from(devices)
    .where(
      and(
        eq(devices.id, deviceId),
        eq(devices.workspaceId, workspaceId),
        eq(devices.userId, userId),
        isNull(devices.revokedAt),
      ),
    );
  if (!d) return false;
  await db.update(devices).set({ revokedAt: clock.now(), tokenId: null, prevTokenId: null }).where(eq(devices.id, d.id));
  await killTokens([d.tokenId, d.prevTokenId]);
  await emit(workspaceId, userId, "device_revoked", d.id, { name: d.name });
  return true;
}

export async function deviceForToken(workspaceId: string, userId: string, tokenId: string) {
  const [d] = await db
    .select()
    .from(devices)
    .where(
      and(
        eq(devices.tokenId, tokenId),
        eq(devices.workspaceId, workspaceId),
        eq(devices.userId, userId),
        isNull(devices.revokedAt),
      ),
    );
  return d ?? null;
}

/**
 * Swap a device's credential for a fresh 90-day one. The old one keeps working
 * for ten minutes so a response lost on a bad network doesn't lock the phone
 * out; only the current credential can rotate.
 */
export async function rotateDevice(workspaceId: string, userId: string, tokenId: string) {
  const d = await deviceForToken(workspaceId, userId, tokenId);
  if (!d) {
    throw new DeviceError(404, "NOT_A_DEVICE", "this credential isn't a paired device");
  }
  const token = `tly_pat_${randomBytes(24).toString("base64url")}`;
  const expiresAt = expiryFromNow();
  const graceEnds = new Date(clock.now().getTime() + ROTATION_GRACE_MS);
  await db.transaction(async (tx) => {
    // compare-and-swap on the current token: two racing rotations can't both win
    const [fresh] = await tx
      .insert(userTokens)
      .values({
        userId,
        workspaceId,
        name: tokenName(d.name),
        tokenHash: hashToken(token),
        scopes: DEVICE_SCOPES,
        expiresAt,
      })
      .returning({ id: userTokens.id });
    const swapped = await tx
      .update(devices)
      .set({ tokenId: fresh!.id, prevTokenId: tokenId })
      .where(and(eq(devices.id, d.id), eq(devices.tokenId, tokenId)))
      .returning({ id: devices.id });
    if (!swapped.length) throw new DeviceError(409, "ROTATION_RACE", "this device was just rotated; use the newer credential");
    if (d.prevTokenId) await tx.delete(userTokens).where(eq(userTokens.id, d.prevTokenId));
    // never extend a token that was about to lapse anyway
    await tx
      .update(userTokens)
      .set({ expiresAt: sql`least(${userTokens.expiresAt}, ${graceEnds.toISOString()}::timestamptz)` })
      .where(eq(userTokens.id, tokenId));
  });
  await emit(workspaceId, userId, "device_rotated", d.id, { name: d.name });
  return { token, expiresAt, scopes: DEVICE_SCOPES };
}
