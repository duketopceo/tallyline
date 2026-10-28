import { createHash } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import { and, eq, lt } from "drizzle-orm";
import { db } from "../db/client.js";
import { idempotencyKeys } from "../db/schema.js";
import { clock } from "../services/clock.js";
import { requireWorkspace } from "../routes/workspaces.js";
import { apiError } from "./errors.js";

// `Idempotency-Key` for mutating routes, so an offline client can retry a write
// after a dropped connection without creating a second issue or comment.
//
// - The key is scoped to (workspace, caller): another user sending the same
//   string gets their own entry.
// - The first request that claims a key runs; a retry with the same key and the
//   same request gets the stored response back (header `Idempotent-Replayed`).
// - The same key with a different method, path or body is refused (422), as is
//   a retry while the first is still running (409, retry shortly).
// - Only successful (2xx) responses are stored. A failure releases the key, so
//   fixing the request and retrying works.
// - An unfinished claim older than a minute is treated as a crashed request and
//   can be taken over.

export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
export const IDEMPOTENCY_STALE_MS = 60_000;
const KEY_RE = /^[A-Za-z0-9._~:-]{8,128}$/;

export const idempotent: MiddlewareHandler = async (c, next) => {
  const key = c.req.header("idempotency-key");
  if (key === undefined) return next();
  if (!KEY_RE.test(key)) {
    return apiError(c, 400, "BAD_IDEMPOTENCY_KEY", "Idempotency-Key must be 8-128 characters of letters, digits and . _ ~ : -");
  }

  // authorization first, so a stored response is never replayed to someone who
  // could not have made the request
  const ws = await requireWorkspace(c);
  const agent = c.get("agentAuth");
  const session = c.get("session");
  const principal = agent ? `agent:${agent.keyId}` : session ? `user:${session.userId}` : "anonymous";
  const scope = `${ws.id}|${principal}`;
  const body = await c.req.text();
  const fingerprint = createHash("sha256")
    .update(`${c.req.method}\n${c.req.path}\n${body}`)
    .digest("hex");

  const now = clock.now();
  if (Math.random() < 0.02) {
    // cheap opportunistic sweep, off the hot path most of the time
    void db
      .delete(idempotencyKeys)
      .where(lt(idempotencyKeys.createdAt, new Date(now.getTime() - IDEMPOTENCY_TTL_MS)))
      .catch(() => undefined);
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    const claimed = await db
      .insert(idempotencyKeys)
      .values({ scope, key, fingerprint, createdAt: now })
      .onConflictDoNothing()
      .returning({ id: idempotencyKeys.id });
    if (claimed.length) {
      const claimId = claimed[0]!.id;
      let res: Response | undefined;
      try {
        await next();
        res = c.res;
      } finally {
        if (res && res.status >= 200 && res.status < 300) {
          const text = await res.clone().text();
          await db
            .update(idempotencyKeys)
            .set({ state: "done", responseStatus: res.status, responseBody: text })
            .where(eq(idempotencyKeys.id, claimId));
        } else {
          // failure or thrown error: release so the client can fix and retry
          await db.delete(idempotencyKeys).where(eq(idempotencyKeys.id, claimId));
        }
      }
      return;
    }

    const [row] = await db
      .select()
      .from(idempotencyKeys)
      .where(and(eq(idempotencyKeys.scope, scope), eq(idempotencyKeys.key, key)))
      .limit(1);
    if (!row) continue; // released between our insert and read: claim again
    if (row.fingerprint !== fingerprint) {
      return apiError(c, 422, "IDEMPOTENCY_KEY_REUSED", "this Idempotency-Key was already used for a different request");
    }
    if (row.state === "done" && row.responseStatus !== null && row.responseBody !== null) {
      return new Response(row.responseBody, {
        status: row.responseStatus,
        headers: { "content-type": "application/json", "idempotent-replayed": "true" },
      });
    }
    if (now.getTime() - row.createdAt.getTime() > IDEMPOTENCY_STALE_MS) {
      // the first attempt never finished: take the claim over once
      await db
        .delete(idempotencyKeys)
        .where(and(eq(idempotencyKeys.id, row.id), eq(idempotencyKeys.state, "in_progress")));
      continue;
    }
    c.header("Retry-After", "1");
    return apiError(c, 409, "IDEMPOTENCY_IN_PROGRESS", "the first request with this Idempotency-Key is still running; retry shortly");
  }
  return apiError(c, 409, "IDEMPOTENCY_IN_PROGRESS", "could not claim this Idempotency-Key; retry shortly");
};
