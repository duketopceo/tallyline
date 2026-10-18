import { createHmac } from "node:crypto";
import { eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DAY, NOW, useFrozenClock } from "../../test/clock.js";
import { closeDb, db } from "../db/client.js";
import { runMigrations } from "../db/migrate.js";
import { githubWebhookEvents } from "../db/schema.js";
import { app } from "../index.js";
import { sweepWebhookEvents } from "./retention.js";

const HOUR = 3_600_000;
const OPTS = { payloadTtlHours: 24, rowRetentionDays: 7, batchSize: 100 };

useFrozenClock();

beforeAll(async () => {
  await runMigrations();
});
afterAll(async () => {
  await closeDb();
});
beforeEach(async () => {
  await db.delete(githubWebhookEvents);
});

async function seed(
  deliveryId: string,
  ageMs: number,
  processed: boolean,
  payload: Record<string, unknown> = { big: "payload" },
) {
  const receivedAt = new Date(NOW - ageMs);
  await db.insert(githubWebhookEvents).values({
    deliveryId,
    eventType: "push",
    payload,
    receivedAt,
    processedAt: processed ? receivedAt : null,
  });
}

const row = async (deliveryId: string) =>
  (
    await db
      .select()
      .from(githubWebhookEvents)
      .where(eq(githubWebhookEvents.deliveryId, deliveryId))
  )[0];

describe("sweepWebhookEvents", () => {
  it("clears the payload of a processed row older than 24h and keeps its delivery id", async () => {
    await seed("old", 25 * HOUR, true);
    await seed("fresh", 23 * HOUR, true);
    const r = await sweepWebhookEvents(OPTS);
    expect(r.payloadsCleared).toBe(1);
    const old = await row("old");
    expect(old?.payload).toBeNull();
    expect(old?.deliveryId).toBe("old");
    expect((await row("fresh"))?.payload).toEqual({ big: "payload" });
  });

  it("deletes a processed 8-day-old row and keeps a 6-day-old one", async () => {
    await seed("d8", 8 * DAY, true);
    await seed("d6", 6 * DAY, true);
    const r = await sweepWebhookEvents(OPTS);
    expect(r.rowsDeleted).toBe(1);
    expect(await row("d8")).toBeUndefined();
    const kept = await row("d6");
    expect(kept).toBeDefined();
    expect(kept?.payload).toBeNull(); // past 24h, so cleared but retained
  });

  it("never deletes or clears an unprocessed row, and logs when one is older than a day", async () => {
    await seed("stuck", 9 * DAY, false);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = await sweepWebhookEvents(OPTS);
    expect(r).toMatchObject({ payloadsCleared: 0, rowsDeleted: 0, unprocessedStale: 1 });
    expect((await row("stuck"))?.payload).toEqual({ big: "payload" });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("1 unprocessed"));
    warn.mockRestore();
  });

  it("does not warn when no unprocessed row is older than a day", async () => {
    await seed("recent", 2 * HOUR, false);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = await sweepWebhookEvents(OPTS);
    expect(r.unprocessedStale).toBe(0);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("works in batches no larger than batchSize", async () => {
    for (let i = 0; i < 5; i++) await seed(`b${i}`, 2 * DAY, true);
    for (let i = 0; i < 5; i++) await seed(`x${i}`, 9 * DAY, true);
    const r = await sweepWebhookEvents({ ...OPTS, batchSize: 2 });
    expect(r.payloadsCleared).toBe(5);
    expect(r.rowsDeleted).toBe(5);
    expect(r.batches).toBe(3 + 3); // ceil(5/2) per phase
    expect(r.maxBatchRows).toBeLessThanOrEqual(2);
    expect(await db.select().from(githubWebhookEvents)).toHaveLength(5);
  });

  it("is a no-op on an empty table and idempotent on a swept one", async () => {
    expect(await sweepWebhookEvents(OPTS)).toMatchObject({
      payloadsCleared: 0,
      rowsDeleted: 0,
      unprocessedStale: 0,
    });
    await seed("o", 2 * DAY, true);
    await sweepWebhookEvents(OPTS);
    expect((await sweepWebhookEvents(OPTS)).payloadsCleared).toBe(0);
  });

  it("refuses a row window shorter than GitHub's redelivery window", async () => {
    await seed("recent", 2 * DAY, true);
    await expect(sweepWebhookEvents({ ...OPTS, rowRetentionDays: 1 })).rejects.toThrow(
      /redelivery/,
    );
    expect(await row("recent")).toBeDefined();
  });

  it("still ignores a redelivery of a kept delivery id after its payload was cleared", async () => {
    const secret = "test-webhook-secret";
    const body = JSON.stringify({ zen: "x" });
    const post = () =>
      app.fetch(
        new Request("http://api.test/webhooks/github", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-github-event": "ping",
            "x-github-delivery": "redeliver-1",
            "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(body, "utf8").digest("hex")}`,
          },
          body,
        }),
      );
    expect((await post()).status).toBe(200);
    // age the row past the payload TTL (frozen clock cannot move it itself)
    await db
      .update(githubWebhookEvents)
      .set({ receivedAt: new Date(NOW - 3 * DAY), processedAt: new Date(NOW - 3 * DAY) })
      .where(eq(githubWebhookEvents.deliveryId, "redeliver-1"));
    await sweepWebhookEvents(OPTS);
    expect((await row("redeliver-1"))?.payload).toBeNull();
    const again = await post();
    expect(((await again.json()) as { duplicate?: boolean }).duplicate).toBe(true);
    expect(await db.select().from(githubWebhookEvents).where(isNull(githubWebhookEvents.payload))).toHaveLength(1);
  });
});
