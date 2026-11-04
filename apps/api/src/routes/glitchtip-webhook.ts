import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { config_ } from "../env.js";
import { apiError } from "../lib/errors.js";
import { createKeyedLimiter } from "../lib/rate-limit.js";
import { SENTRY_SIGNATURE_HEADER, verifySentrySignature } from "../lib/sentry.js";
import {
  findIntegrationByToken,
  ingestGlitchtipAlert,
  ingestSentryAlert,
} from "../services/glitchtip.js";
import { isSentryAlert } from "../services/intake-normalize.js";

// Limits are keyed on the integration id the token resolves to, never the
// client IP: GlitchTip delivers every workspace's alerts from one address, so
// an IP key would let one noisy integration throttle all the others.
export const glitchtipDeliveryLimiter = createKeyedLimiter(
  () => config_.glitchtipRatePerMin,
  60_000,
  { prefix: "gt-deliveries" },
);
export const glitchtipIssueLimiter = createKeyedLimiter(
  () => config_.glitchtipIssuesPerHour,
  3_600_000,
  { prefix: "gt-issues" },
);

// Public receiver for GlitchTip alert webhooks. GlitchTip cannot sign or add
// headers, so the per-workspace secret is the last path segment; only its
// sha256 is stored. Unknown, rotated and disabled tokens are all 404.
export const glitchtipWebhookRoutes = new Hono().post(
  "/glitchtip/:token",
  bodyLimit({
    maxSize: 256 * 1024,
    onError: (c) =>
      apiError(c, 413, "PAYLOAD_TOO_LARGE", "alert body exceeds 256 KB"),
  }),
  async (c) => {
    const integration = await findIntegrationByToken(c.req.param("token"));
    if (!integration) return apiError(c, 404, "NOT_FOUND", "not found");

    // every delivery to a known integration counts, valid or not, so a
    // looping alert rule or a leaked URL cannot flood the endpoint
    const tooMany =
      (await glitchtipDeliveryLimiter.hit(c, integration.id)) ??
      (await glitchtipIssueLimiter.guard(c, integration.id));
    if (tooMany) return tooMany;

    const rawBody = await c.req.text();

    // Sentry signs every delivery; the check runs on the raw bytes before
    // anything is parsed. GlitchTip cannot sign, so it keeps the URL secret
    // and never sends this header.
    const signature = c.req.header(SENTRY_SIGNATURE_HEADER);
    if (signature !== undefined) {
      if (!config_.sentrySigningSecret) {
        return apiError(
          c,
          503,
          "SENTRY_NOT_CONFIGURED",
          "Sentry webhooks need SENTRY_SIGNING_SECRET on this server",
        );
      }
      if (!verifySentrySignature(rawBody, signature, config_.sentrySigningSecret)) {
        return apiError(c, 401, "INVALID_SIGNATURE", "bad webhook signature");
      }
    }

    let body: unknown;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return apiError(c, 400, "MALFORMED_PAYLOAD", "invalid JSON body");
    }

    if (isSentryAlert(body) && signature === undefined) {
      return apiError(c, 401, "INVALID_SIGNATURE", "bad webhook signature");
    }

    const outcome = isSentryAlert(body)
      ? await ingestSentryAlert(integration, rawBody, body)
      : await ingestGlitchtipAlert(integration, rawBody, body);
    // only newly created issues spend the hourly budget; occurrences folded
    // onto an existing issue are cheap
    for (const r of outcome.results) {
      if (r.status === "created") await glitchtipIssueLimiter.hit(c, integration.id);
    }
    return c.json({ ok: true, ...outcome });
  },
);
