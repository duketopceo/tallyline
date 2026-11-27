import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../db/client.js";
import { githubWebhookEvents } from "../db/schema.js";
import { config_ } from "../env.js";
import { HttpError } from "../lib/errors.js";
import { verifyGitHubSignature } from "../lib/github.js";
import { logger, serializeError } from "../lib/logger.js";
import { recordWebhookDelivery } from "../lib/metrics.js";
import { processGithubEvent } from "../services/github-automation.js";
import { clock } from "../services/clock.js";

export const webhookRoutes = new Hono().post("/github", async (c) => {
  if (!config_.githubWebhookSecret) {
    recordWebhookDelivery("github", "rejected");
    throw new HttpError(503, "GITHUB_NOT_CONFIGURED", "webhook secret not set");
  }

  const rawBody = await c.req.raw.text();
  const signature = c.req.header("x-hub-signature-256");
  if (!verifyGitHubSignature(rawBody, signature, config_.githubWebhookSecret)) {
    recordWebhookDelivery("github", "rejected");
    throw new HttpError(401, "INVALID_SIGNATURE", "bad webhook signature");
  }

  const deliveryId = c.req.header("x-github-delivery");
  const eventType = c.req.header("x-github-event");
  if (!deliveryId || !eventType) {
    recordWebhookDelivery("github", "rejected");
    throw new HttpError(400, "MALFORMED_DELIVERY", "missing delivery headers");
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    recordWebhookDelivery("github", "rejected");
    throw new HttpError(400, "MALFORMED_PAYLOAD", "invalid JSON body");
  }

  // dedupe: replayed deliveries are dropped and logged
  const [inserted] = await db
    .insert(githubWebhookEvents)
    .values({ deliveryId, eventType, payload })
    .onConflictDoNothing({ target: githubWebhookEvents.deliveryId })
    .returning({ id: githubWebhookEvents.id });
  if (!inserted) {
    recordWebhookDelivery("github", "duplicate");
    logger.warn("webhook.github.duplicate", {
      request_id: c.get("requestId"),
      delivery_id: deliveryId,
    });
    return c.json({ ok: true, duplicate: true });
  }

  try {
    const consumed = await processGithubEvent(eventType, payload);
    if (consumed) {
      await db
        .update(githubWebhookEvents)
        .set({ processedAt: clock.now() })
        .where(eq(githubWebhookEvents.deliveryId, deliveryId));
    }
    recordWebhookDelivery("github", "accepted");
  } catch (err) {
    // delivery stays unprocessed for a later sweep — never fail the webhook
    recordWebhookDelivery("github", "error");
    logger.error("webhook.github.failed", {
      request_id: c.get("requestId"),
      event_type: eventType,
      delivery_id: deliveryId,
      ...serializeError(err),
    });
  }

  return c.json({ ok: true });
});
