import { sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { config_ } from "../env.js";
import { clock } from "./clock.js";

// github_webhook_events retention. The payload is nearly all of the table's
// bytes and nothing reads it once a row is processed (the only reader, the
// installation backfill in routes/github.ts, selects unprocessed rows only),
// so it is nulled after the TTL. The row (delivery_id) is kept past GitHub's
// redelivery window so the unique delivery_id still drops redeliveries, then
// deleted. Unprocessed rows are never touched: they are pending work.

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// GitHub allows manual redelivery for 3 days; a shorter row window would let
// a redelivery be processed twice.
const MIN_ROW_RETENTION_DAYS = 3;

export type RetentionOptions = {
  payloadTtlHours: number;
  rowRetentionDays: number;
  batchSize: number;
};

export type RetentionResult = {
  payloadsCleared: number;
  rowsDeleted: number;
  unprocessedStale: number;
  batches: number;
  maxBatchRows: number;
};

const DEFAULTS = (): RetentionOptions => ({
  payloadTtlHours: config_.webhookEventPayloadTtlHours,
  rowRetentionDays: config_.webhookEventRetentionDays,
  batchSize: 1000,
});

export async function sweepWebhookEvents(
  opts: RetentionOptions = DEFAULTS(),
): Promise<RetentionResult> {
  const { payloadTtlHours, rowRetentionDays, batchSize } = opts;
  if (!(rowRetentionDays >= MIN_ROW_RETENTION_DAYS)) {
    throw new Error(
      `webhook event retention must be >= ${MIN_ROW_RETENTION_DAYS} days (GitHub redelivery window), got ${rowRetentionDays}`,
    );
  }
  if (!(payloadTtlHours > 0) || !(batchSize > 0)) {
    throw new Error("webhook event retention: ttl and batch size must be positive");
  }

  const now = clock.ms();
  const payloadCutoff = new Date(now - payloadTtlHours * HOUR);
  const rowCutoff = new Date(now - rowRetentionDays * DAY);
  const staleCutoff = new Date(now - DAY);
  const result: RetentionResult = {
    payloadsCleared: 0,
    rowsDeleted: 0,
    unprocessedStale: 0,
    batches: 0,
    maxBatchRows: 0,
  };

  const run = async (
    statement: (limit: number) => ReturnType<typeof sql>,
  ): Promise<number> => {
    let total = 0;
    for (;;) {
      const res = await db.execute(statement(batchSize));
      const n = res.rowCount ?? 0;
      if (n === 0) return total;
      result.batches += 1;
      result.maxBatchRows = Math.max(result.maxBatchRows, n);
      total += n;
      if (n < batchSize) return total;
    }
  };

  result.rowsDeleted = await run(
    (limit) => sql`
      DELETE FROM github_webhook_events
      WHERE id IN (
        SELECT id FROM github_webhook_events
        WHERE processed_at IS NOT NULL AND received_at < ${rowCutoff}
        ORDER BY id LIMIT ${limit} FOR UPDATE SKIP LOCKED)`,
  );

  // after the delete, so rows about to go are not rewritten first
  result.payloadsCleared = await run(
    (limit) => sql`
      UPDATE github_webhook_events SET payload = NULL
      WHERE id IN (
        SELECT id FROM github_webhook_events
        WHERE processed_at IS NOT NULL AND payload IS NOT NULL
          AND received_at < ${payloadCutoff}
        ORDER BY id LIMIT ${limit} FOR UPDATE SKIP LOCKED)`,
  );
  const stale = await db.execute<{ n: string }>(sql`
    SELECT count(*) AS n FROM github_webhook_events
    WHERE processed_at IS NULL AND received_at < ${staleCutoff}`);
  result.unprocessedStale = Number(stale.rows[0]?.n ?? 0);
  if (result.unprocessedStale > 0) {
    console.warn(
      `webhook retention: ${result.unprocessedStale} unprocessed github_webhook_events older than 1 day kept`,
    );
  }
  return result;
}
