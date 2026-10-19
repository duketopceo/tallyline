import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { InvalidTransitionError } from "@tallyline/types";
import { runMigrations } from "./db/migrate.js";
import { config_ } from "./env.js";
import { checkHealth } from "./health.js";
import { apiError, HttpError } from "./lib/errors.js";
import { createAnonymousLimiter, createRateLimiter } from "./lib/rate-limit.js";
import { securityHeaders } from "./lib/security-headers.js";
import { openApiDoc } from "./openapi.js";
import { sweepExpiredCycles } from "./services/cycles.js";
import { tickCycleSchedule } from "./services/cycle-schedule.js";
import { sweepDeliveries } from "./services/outbound.js";
import { sweepStaleDispatches } from "./services/dispatch.js";
import { sweepWebhookEvents } from "./services/retention.js";
import { agentRoutes } from "./routes/agents.js";
import { notificationRoutes } from "./routes/notifications.js";
import { authRoutes, requireSession } from "./routes/auth.js";
import { assistRoutes } from "./routes/assist.js";
import { dispatchRoutes } from "./routes/dispatches.js";
import { eventRoutes } from "./routes/events.js";
import { githubPublicRoutes, githubRoutes } from "./routes/github.js";
import { importRoutes } from "./routes/import.js";
import { inviteAcceptRoutes, inviteRoutes } from "./routes/invites.js";
import { issueRoutes } from "./routes/issues.js";
import { memberRoutes } from "./routes/members.js";
import { mcpRoutes, setMcpInternalFetch } from "./routes/mcp.js";
import { buildMcpOAuthRoutes } from "./routes/mcp-oauth.js";
import { mcpOAuthAdminRoutes } from "./routes/mcp-oauth-admin.js";
import { oauthRoutes } from "./routes/oauth.js";
import { providerRoutes } from "./routes/providers.js";
import { resourceRoutes } from "./routes/resources.js";
import { slackRoutes } from "./routes/slack.js";
import { tokenRoutes } from "./routes/tokens.js";
import { webhookEndpointRoutes } from "./routes/webhook-endpoints.js";
import { webhookRoutes } from "./routes/webhooks.js";
import { whoamiRoutes } from "./routes/whoami.js";
import { workspaceRoutes } from "./routes/workspaces.js";
import { SESSION_COOKIE } from "./services/auth.js";
import { NotFoundError } from "./services/issues.js";

const rateLimiter = createRateLimiter(config_.rateLimitPerMin);
// counts unauthenticated traffic + failed credentials per client IP; health
// probes and HMAC-signed provider webhooks are exempt
const anonymousLimiter = createAnonymousLimiter(
  config_.rateLimitAnonPerMin,
  SESSION_COOKIE,
  {
    // OAuth discovery/token traffic arrives from shared client egress IPs
    // (Claude, ChatGPT) and carries no cookie; it has its own limiters
    skip: (p) =>
      p === "/health" ||
      p.startsWith("/webhooks/") ||
      p.startsWith("/.well-known/") ||
      p.startsWith("/oauth/"),
  },
);

export const app = new Hono()
  .use("*", securityHeaders)
  .use("*", anonymousLimiter)
  .get("/health", async (c) => {
    const report = await checkHealth(config_.databaseUrl);
    return c.json(report, report.status === "ok" ? 200 : 503);
  })
  .get("/openapi.json", (c) => c.json(openApiDoc))
  .route("/", buildMcpOAuthRoutes())
  .route("/", mcpRoutes)
  .route("/webhooks", webhookRoutes)
  .route("/webhooks", slackRoutes)
  .route("/github", githubPublicRoutes)
  .route("/v1/auth", authRoutes)
  .route("/v1/auth", oauthRoutes)
  .route("/v1/auth", inviteAcceptRoutes)
  .route("/v1/auth", providerRoutes)
  .use("/v1/*", requireSession)
  .use("/v1/*", rateLimiter)
  .route("/v1", mcpOAuthAdminRoutes)
  .route("/v1", workspaceRoutes)
  .route("/v1", whoamiRoutes)
  .route("/v1", eventRoutes)
  .route("/v1", issueRoutes)
  .route("/v1", agentRoutes)
  .route("/v1", resourceRoutes)
  .route("/v1", tokenRoutes)
  .route("/v1", memberRoutes)
  .route("/v1", inviteRoutes)
  .route("/v1", notificationRoutes)
  .route("/v1", githubRoutes)
  .route("/v1", importRoutes)
  .route("/v1", webhookEndpointRoutes)
  .route("/v1", dispatchRoutes)
  .route("/v1", assistRoutes)
  .onError((err, c) => {
    if (err instanceof HttpError) {
      return apiError(c, err.status, err.code, err.message);
    }
    if (err instanceof InvalidTransitionError) {
      return apiError(c, 409, err.code, err.message);
    }
    if (err instanceof NotFoundError) {
      return apiError(c, 404, err.code, err.message);
    }
    if (err instanceof HTTPException) {
      return apiError(c, err.status, "HTTP_ERROR", err.message);
    }
    console.error(err);
    return apiError(c, 500, "INTERNAL", "internal server error");
  });

setMcpInternalFetch((req) => app.fetch(req));

if (process.env.NODE_ENV !== "test") {
  await runMigrations();
  setInterval(() => {
    void sweepDeliveries().catch((err) =>
      console.error("webhook sweep failed", err),
    );
  }, 30_000).unref();
  // dispatch ack sweep: fail dispatches that never got acknowledged
  setInterval(() => {
    void sweepStaleDispatches().catch((err) =>
      console.error("dispatch sweep failed", err),
    );
  }, 30_000).unref();
  // cycle boundary sweep: complete expired active cycles unattended
  // then the auto-schedule tick refills upcoming cycles and activates the one
  // now covering the clock; sequenced so a rollover always finds its next cycle
  const cycleTick = () =>
    sweepExpiredCycles()
      .then(() => tickCycleSchedule())
      .catch((err) => console.error("cycle sweep failed", err));
  setInterval(() => void cycleTick(), 60_000).unref();
  void cycleTick();
  // webhook event retention: clear old payloads, delete old rows (daily)
  setInterval(() => {
    void sweepWebhookEvents().catch((err) =>
      console.error("webhook retention sweep failed", err),
    );
  }, 24 * 60 * 60_000).unref();
  void sweepWebhookEvents().catch((err) =>
    console.error("webhook retention sweep failed", err),
  );
  void sweepStaleDispatches().catch((err) =>
    console.error("dispatch sweep failed", err),
  );
  serve({ fetch: app.fetch, port: config_.port }, (info) => {
    console.log(`api listening on http://localhost:${info.port}`);
  });
}
