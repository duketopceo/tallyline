import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { apiError } from "../lib/errors.js";
import {
  findIntegrationByToken,
  ingestGlitchtipAlert,
} from "../services/glitchtip.js";

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

    const rawBody = await c.req.text();
    let body: unknown;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return apiError(c, 400, "MALFORMED_PAYLOAD", "invalid JSON body");
    }

    const outcome = await ingestGlitchtipAlert(integration, rawBody, body);
    return c.json({ ok: true, ...outcome });
  },
);
