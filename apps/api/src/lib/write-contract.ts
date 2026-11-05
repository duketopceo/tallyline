import type { Context } from "hono";
import { HttpError } from "./errors.js";

// Write contract C6, optimistic concurrency. A client that read an issue at
// `version` N may send `If-Match: N` (a bare integer, or the quoted/weak ETag
// form) with its write. If the issue has moved on, the write is refused with
// `409 STALE_WRITE` and the current server issue, nothing is written. A write
// without `If-Match` carries no precondition, so clients that predate the
// contract behave exactly as before.

const IF_MATCH_RE = /^(?:W\/)?"?(\d{1,9})"?$/;

/** The version a client expects, or undefined when it sent no precondition. */
export function expectedVersion(c: Context): number | undefined {
  const raw = c.req.header("if-match");
  if (raw === undefined) return undefined;
  const m = IF_MATCH_RE.exec(raw.trim());
  if (!m) {
    throw new HttpError(400, "BAD_IF_MATCH", "If-Match must be the issue version as an integer");
  }
  return Number(m[1]);
}

/** The 409 body: the STALE_DIFF shape (`error` plus the current server state). */
export function staleWriteResponse(c: Context, current: { version: number }) {
  c.set("errorCode", "STALE_WRITE");
  return c.json(
    {
      error: {
        code: "STALE_WRITE",
        message: "the issue changed since you read it; review the current version and choose to keep your change or use theirs",
      },
      issue: current,
    },
    409,
  );
}
