import { Hono } from "hono";
import { config_ } from "../env.js";
import { apiError } from "../lib/errors.js";
import { logger, serializeError } from "../lib/logger.js";
import { recordWebhookDelivery } from "../lib/metrics.js";
import { slackEnabled, verifySlackSignature } from "../lib/slack.js";
import { createSlack } from "../services/slack.js";

const slack = createSlack();

interface EventPayload {
  type?: string;
  challenge?: string;
  event_id?: string;
  event?: {
    type?: string;
    [k: string]: unknown;
  };
}

export const slackRoutes = new Hono().post("/slack", async (c) => {
  if (!slackEnabled()) {
    recordWebhookDelivery("slack", "rejected");
    return apiError(c, 503, "SLACK_DISABLED", "slack app not configured");
  }
  const rawBody = await c.req.text();
  const ts = c.req.header("x-slack-request-timestamp");
  const sig = c.req.header("x-slack-signature");
  if (!verifySlackSignature(rawBody, ts, sig, config_.slackSigningSecret)) {
    recordWebhookDelivery("slack", "rejected");
    return apiError(c, 401, "BAD_SIGNATURE", "invalid slack signature");
  }

  const contentType = c.req.header("content-type") ?? "";

  // ── Events API (application/json) ──────────────────────────────
  if (contentType.includes("application/json")) {
    const payload = JSON.parse(rawBody) as EventPayload;
    if (payload.type === "url_verification") {
      recordWebhookDelivery("slack", "accepted");
      return c.json({ challenge: payload.challenge });
    }
    if (payload.type === "event_callback" && payload.event) {
      const ev = payload.event;
      // ack inside Slack's 3s window; the work continues async
      const work =
        ev.type === "reaction_added"
          ? slack.handleReactionAdded(
              ev as Parameters<typeof slack.handleReactionAdded>[0],
            )
          : ev.type === "message"
            ? slack.handleMessage(ev as Parameters<typeof slack.handleMessage>[0])
            : Promise.resolve();
      work.catch((e) => {
        recordWebhookDelivery("slack", "error");
        logger.error("webhook.slack.failed", {
          request_id: c.get("requestId"),
          ...serializeError(e),
        });
      });
      recordWebhookDelivery("slack", "accepted");
      return c.json({ ok: true });
    }
    recordWebhookDelivery("slack", "accepted");
    return c.json({ ok: true });
  }

  // ── slash commands + interactive payloads (form-encoded) ──────
  const form = new URLSearchParams(rawBody);
  if (form.has("command")) {
    // /docket — synchronous: either opens the modal or creates inline
    const result = await slack.handleSlashCommand({
      trigger_id: form.get("trigger_id") ?? undefined,
      text: form.get("text") ?? undefined,
      channel_id: form.get("channel_id") ?? undefined,
      user_id: form.get("user_id") ?? undefined,
      user_name: form.get("user_name") ?? undefined,
    });
    recordWebhookDelivery("slack", "accepted");
    return c.json(result);
  }
  const interaction = form.get("payload");
  if (interaction) {
    const payload = JSON.parse(interaction) as {
      type?: string;
      view?: Parameters<typeof slack.handleViewSubmission>[0]["view"];
      user?: Parameters<typeof slack.handleViewSubmission>[0]["user"];
    };
    if (payload.type === "view_submission") {
      const result = await slack.handleViewSubmission({
        view: payload.view,
        user: payload.user,
      });
      recordWebhookDelivery("slack", "accepted");
      return c.json(result);
    }
    recordWebhookDelivery("slack", "accepted");
    return c.json({ ok: true });
  }

  recordWebhookDelivery("slack", "rejected");
  return apiError(c, 400, "BAD_REQUEST", "unrecognized slack payload");
});
