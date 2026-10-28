import { zValidator } from "@hono/zod-validator";
import { and, eq, gt, lt, type SQL } from "drizzle-orm";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { events } from "../db/schema.js";
import { apiError } from "../lib/errors.js";
import { decodeCursor, encodeCursor } from "../lib/pagination.js";
import {
  feedEventsQuery,
  subscribeEvents,
  toFeedEvent,
} from "../services/event-hub.js";
import { agentKeyActive, onAgentKeyEnded } from "../services/agents.js";
import { requireWorkspace } from "./workspaces.js";

// v0.3 realtime: one shared poller per process fans committed events out to
// every SSE connection (see services/event-hub.ts). Each stream still does
// its own backlog drain from `Last-Event-ID`/`?after=` and its own
// heartbeat — the only per-connection DB work is the initial replay.

let heartbeatMs = 15_000;
/** test hook: shorten the heartbeat (which also re-validates agent keys) */
export function setStreamHeartbeatMs(ms: number): void {
  heartbeatMs = ms;
}
const BATCH_SIZE = 200;

const listQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const syncQuerySchema = z.object({
  since: z.coerce.number().int().nonnegative().default(0),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const eventRoutes = new Hono()
  .get(
    "/workspaces/:ws/events",
    zValidator("query", listQuerySchema),
    async (c) => {
      const ws = await requireWorkspace(c);
      const q = c.req.valid("query");

      // events.id (bigserial) is the total order — newest-first, `id` alone
      // is a sufficient cursor.
      const filters: SQL[] = [eq(events.workspaceId, ws.id)];
      if (q.cursor) {
        const cur = decodeCursor(q.cursor);
        const id = cur ? Number(cur.id) : Number.NaN;
        if (!Number.isSafeInteger(id) || id < 1) {
          return apiError(c, 400, "BAD_CURSOR", "invalid cursor");
        }
        filters.push(lt(events.id, id));
      }

      const rows = await feedEventsQuery(and(...filters), "desc", q.limit + 1);
      const hasMore = rows.length > q.limit;
      const page = hasMore ? rows.slice(0, q.limit) : rows;
      const last = page.at(-1);
      return c.json({
        events: page.map(toFeedEvent),
        nextCursor:
          hasMore && last
            ? encodeCursor({
                createdAt: last.createdAt.toISOString(),
                id: String(last.id),
              })
            : null,
      });
    },
  )
  // ── Plan L7: Delta sync read path ──────────────────────────────
  .get(
    "/workspaces/:ws/sync",
    zValidator("query", syncQuerySchema),
    async (c) => {
      const ws = await requireWorkspace(c);
      const q = c.req.valid("query");
      const rows = await feedEventsQuery(
        and(eq(events.workspaceId, ws.id), gt(events.id, q.since)),
        "asc",
        q.limit + 1,
      );
      const hasMore = rows.length > q.limit;
      const page = hasMore ? rows.slice(0, q.limit) : rows;
      const last = page.at(-1);
      return c.json({
        events: page.map((r) => ({ ...toFeedEvent(r), id: r.id })),
        nextCursor: hasMore && last ? String(last.id) : null,
      });
    },
  )
  .get("/workspaces/:ws/events/stream", async (c) => {
    const ws = await requireWorkspace(c);

    // Resume: EventSource sends `Last-Event-ID` on reconnect; `?after=` is the
    // equivalent knob for curl/CLI/MCP tails.
    const afterRaw = c.req.query("after") ?? c.req.header("last-event-id");
    let lastSeen = 0;
    if (afterRaw !== undefined) {
      const n = Number(afterRaw);
      if (!Number.isSafeInteger(n) || n < 0) {
        return apiError(c, 400, "BAD_CURSOR", "invalid event id");
      }
      lastSeen = n;
    }

    const reqSignal = c.req.raw.signal;
    // agent credentials: the stream must not outlive the key
    const keyId = c.get("agentAuth")?.keyId ?? null;
    return streamSSE(c, async (stream) => {
      // One stop signal covering request abort AND response-body cancel
      // (either fires on client disconnect, depending on runtime).
      const stopper = new AbortController();
      const stop = () => stopper.abort();
      stream.onAbort(stop);
      if (reqSignal.aborted) stopper.abort();
      else reqSignal.addEventListener("abort", stop, { once: true });
      const done = stopper.signal;
      const offKeyEnded = keyId ? onAgentKeyEnded(keyId, stop) : () => undefined;

      const write = async (row: Parameters<typeof toFeedEvent>[0]) => {
        if (row.id <= lastSeen) return; // dedup vs the backlog drain
        lastSeen = row.id;
        await stream.writeSSE({
          id: String(row.id),
          data: JSON.stringify(toFeedEvent(row)),
        });
      };

      // subscribe first so rows committed mid-drain arrive via the hub and
      // dedup against `lastSeen` instead of being missed
      const unsubscribe = subscribeEvents(ws.id, (row) => {
        void write(row).catch(() => undefined);
      });

      // flush the headers now: a resume with nothing to replay would otherwise
      // sit silent until the first heartbeat and EventSource.onopen would lag
      await stream.write(`: open\n\n`);

      // backlog drain — this connection's only polling work
      for (;;) {
        const rows = await feedEventsQuery(
          and(eq(events.workspaceId, ws.id), gt(events.id, lastSeen)),
          "asc",
          BATCH_SIZE,
        );
        for (const row of rows) await write(row);
        if (rows.length < BATCH_SIZE || done.aborted) break;
      }

      // heartbeat — keeps proxies/NATs from reaping an idle connection
      const heartbeat = setInterval(() => {
        if (done.aborted) return;
        if (keyId) {
          // revoked or expired (or ended in another process): close
          void agentKeyActive(keyId)
            .then((ok) => {
              if (!ok) stop();
            })
            .catch(() => undefined);
        }
        void stream.write(`: hb\n\n`).catch(() => undefined);
      }, heartbeatMs);

      await new Promise<void>((resolve) => {
        if (done.aborted) resolve();
        else done.addEventListener("abort", () => resolve(), { once: true });
      });

      clearInterval(heartbeat);
      offKeyEnded();
      unsubscribe();
      reqSignal.removeEventListener("abort", stop);
    });
  });
