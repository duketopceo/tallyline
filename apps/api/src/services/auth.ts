import {
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import { and, eq, gt } from "drizzle-orm";
import { db } from "../db/client.js";
import { sessions, users, workspaces } from "../db/schema.js";
import { clock } from "./clock.js";

export const SESSION_COOKIE = "tly_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("base64url");
  const hash = scryptSync(password, salt, 64).toString("base64url");
  return `scrypt$${salt}$${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [algo, salt, hash] = stored.split("$");
  if (algo !== "scrypt" || !salt || !hash) return false;
  const candidate = scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, "base64url");
  return (
    candidate.length === expected.length &&
    timingSafeEqual(candidate, expected)
  );
}

export async function createSession(userId: string, workspaceId: string) {
  const token = randomBytes(32).toString("base64url");
  const tokenHash = hashToken(token);
  await db.insert(sessions).values({
    userId,
    workspaceId,
    tokenHash,
    expiresAt: new Date(clock.ms() + SESSION_TTL_MS),
  });
  return token;
}

export async function sessionFromToken(token: string) {
  const tokenHash = hashToken(token);
  const [row] = await db
    .select({
      sessionId: sessions.id,
      userId: sessions.userId,
      workspaceId: sessions.workspaceId,
      email: users.email,
      name: users.name,
      emailVerifiedAt: users.emailVerifiedAt,
      workspaceSlug: workspaces.slug,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .innerJoin(workspaces, eq(workspaces.id, sessions.workspaceId))
    .where(
      and(
        eq(sessions.tokenHash, tokenHash),
        gt(sessions.expiresAt, clock.now()),
      ),
    );
  return row ?? null;
}

export async function destroySession(token: string) {
  await db.delete(sessions).where(eq(sessions.tokenHash, hashToken(token)));
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
