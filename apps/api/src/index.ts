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
import { SYNC_INTERVAL_MS as GLITCHTIP_SYNC_MS, syncDueLinks } from "./services/glitchtip-sync.js";
import { sweepStaleDispatches } from "./services/dispatch.js";
import { sweepWebhookEvents } from "./services/retention.js";
import { mailer } from "./services/mailer.js";
import { sweepDeletedWorkspaces } from "./services/workspace-lifecycle.js";
import { accountPublicRoutes, accountRoutes } from "./routes/account.js";
import { sweepStaleSessions } from "./services/agent-sessions.js";
import { agentRoutes } from "./routes/agents.js";
import { notificationRoutes } from "./routes/notifications.js";
import { authRoutes, requireSession } from "./routes/auth.js";
import { assistRoutes } from "./routes/assist.js";
import { dispatchRoutes } from "./routes/dispatches.js";
import { agentSessionRoutes } from "./routes/agent-sessions.js";
import { workflowRoutes } from "./routes/workflows.js";
import { eventRoutes } from "./routes/events.js";
import { githubPublicRoutes, githubRoutes } from "./routes/github.js";
import { importRoutes } from "./routes/import.js";
import { glitchtipRoutes } from "./routes/glitchtip.js";
import { glitchtipFeedRoutes } from "./routes/glitchtip-feed.js";
import { portfolioRoutes } from "./routes/portfolio.js";
import { glitchtipWebhookRoutes } from "./routes/glitchtip-webhook.js";
import { intakeRoutes } from "./routes/intake.js";
import { appleAuthRoutes } from "./routes/apple-auth.js";
import { supportRoutes } from "./routes/support.js";
import { intakePublicRoutes } from "./routes/intake-public.js";
import { reporterPublicRoutes } from "./routes/reporters.js";
import { deviceAuthPublicRoutes, deviceAuthWorkspaceRoutes } from "./routes/device-auth.js";
import { aiProviderRoutes } from "./routes/ai-providers.js";
import { inviteAcceptRoutes, inviteRoutes } from "./routes/invites.js";
import { issueRoutes } from "./routes/issues.js";
import { memberRoutes } from "./routes/members.js";
import { mcpRoutes, setMcpInternalFetch } from "./routes/mcp.js";
import { buildMcpOAuthRoutes } from "./routes/mcp-oauth.js";
import { mcpOAuthAdminRoutes } from "./routes/mcp-oauth-admin.js";
import { oauthRoutes } from "./routes/oauth.js";
import { providerRoutes } from "./routes/providers.js";
import { agentInboxRoutes } from "./routes/agent-inbox.js";
import { projectUpdateRoutes } from "./routes/project-updates.js";
import { resourceRoutes } from "./routes/resources.js";
import { slackRoutes } from "./routes/slack.js";
import { systemRoutes } from "./routes/system.js";
import { tokenRoutes } from "./routes/tokens.js";
import { deviceRoutes, devicePublicRoutes } from "./routes/devices.js";
import { pushRoutes } from "./routes/push.js";
import { usageRoutes } from "./routes/usage.js";
import { webhookEndpointRoutes } from "./routes/webhook-endpoints.js";
import { webhookRoutes } from "./routes/webhooks.js";
import { whoamiRoutes } from "./routes/whoami.js";
import { workspaceRoutes } from "./routes/workspaces.js";
import { SESSION_COOKIE } from "./services/auth.js";
import { NotFoundError } from "./services/issues.js";
import { PlanLimitError, PublicPlanLimitError } from "./services/entitlements.js";
import { countApiCall, flushApiCalls, rollupTick } from "./services/usage.js";

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
  // Access log: method, path, status, refusal code, duration. No query strings
  // and no bodies — pairing codes and tokens travel in bodies — so this is
  // safe to keep on in production and enough to tell "no request arrived"
  // apart from "the request was refused, and why".
  .use("*", async (c, next) => {
    const started = performance.now();
    await next();
    if (c.req.path === "/health") return;
    const ms = Math.round(performance.now() - started);
    const code = c.get("errorCode");
    console.log(
      `${c.req.method} ${c.req.path} ${c.res.status}${code ? ` ${code}` : ""} ${ms}ms`,
    );
  })
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
  .route("/webhooks", glitchtipWebhookRoutes)
  .route("/github", githubPublicRoutes)
  .route("/v1/auth", authRoutes)
  .route("/v1/auth", oauthRoutes)
  .route("/v1/auth", inviteAcceptRoutes)
  .route("/v1/auth", deviceAuthPublicRoutes)
  .route("/v1/auth", providerRoutes)
  .route("/v1/auth", accountPublicRoutes)
  .route("/v1/auth", devicePublicRoutes)
  .route("/v1/auth", appleAuthRoutes)
  // public: a per-project intake key is the credential, no session involved.
  // Must stay ABOVE requireSession or an outside app cannot report at all.
  .route("/v1", intakePublicRoutes)
  // public: a reporter handle is a capability token, no session involved.
  // Same rule as intake — this must stay ABOVE requireSession.
  .route("/v1", reporterPublicRoutes)
  .use("/v1/*", requireSession)
  .use("/v1/*", async (c, next) => {
    await next();
    // after authorization: refused requests (401/403, incl. role gates that
    // run after requireWorkspace) never count against the workspace
    const ws = c.get("usageWorkspaceId");
    if (ws && c.res.status !== 401 && c.res.status !== 403) countApiCall(ws);
  })
  .use("/v1/*", rateLimiter)
  .route("/v1", mcpOAuthAdminRoutes)
  .route("/v1", workspaceRoutes)
  .route("/v1", whoamiRoutes)
  .route("/v1", eventRoutes)
  .route("/v1", issueRoutes)
  .route("/v1", intakeRoutes)
  .route("/v1", supportRoutes)
  .route("/v1", glitchtipRoutes)
  .route("/v1", glitchtipFeedRoutes)
  .route("/v1", portfolioRoutes)
  .route("/v1", agentRoutes)
  .route("/v1", resourceRoutes)
  .route("/v1", projectUpdateRoutes)
  .route("/v1", agentInboxRoutes)
  .route("/v1", tokenRoutes)
  .route("/v1", deviceAuthWorkspaceRoutes)
  .route("/v1", deviceRoutes)
  .route("/v1", pushRoutes)
  .route("/v1", aiProviderRoutes)
  .route("/v1", systemRoutes)
  .route("/v1", memberRoutes)
  .route("/v1", inviteRoutes)
  .route("/v1", notificationRoutes)
  .route("/v1", githubRoutes)
  .route("/v1", importRoutes)
  .route("/v1", webhookEndpointRoutes)
  .route("/v1", dispatchRoutes)
  .route("/v1", agentSessionRoutes)
  .route("/v1", workflowRoutes)
  .route("/v1", assistRoutes)
  .route("/v1", accountRoutes)
  .route("/v1", usageRoutes)
  .onError((err, c) => {
    if (err instanceof PlanLimitError) {
      // machine-readable so agents, the CLI and MCP clients can say which
      // limit was hit and what to do (PLAN-059)
      return c.json(
        { error: { code: err.code, message: err.message, ...err.detail } },
        402,
      );
    }
    if (err instanceof PublicPlanLimitError) {
      return c.json({ error: { code: err.code, message: err.message, plan: err.plan } }, 402);
    }
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
  // agent session sweep: pending past ack window / active past idle window
  // single-flight: a slow sweep must not overlap the next tick
  let sessionSweepRunning = false;
  setInterval(() => {
    if (sessionSweepRunning) return;
    sessionSweepRunning = true;
    void sweepStaleSessions()
      .catch((err) => console.error("session sweep failed", err))
      .finally(() => {
        sessionSweepRunning = false;
      });
  }, 10_000).unref();
  // cycle boundary sweep: complete expired active cycles unattended
  // then the auto-schedule tick refills upcoming cycles and activates the one
  // now covering the clock; sequenced so a rollover always finds its next cycle
  const cycleTick = () =>
    sweepExpiredCycles()
      .then(() => tickCycleSchedule())
      .catch((err) => console.error("cycle sweep failed", err));
  setInterval(() => void cycleTick(), 60_000).unref();
  void cycleTick();
  // GlitchTip error feed: pull mapped projects' issues into the cache. One
  // tick at a time, links one after another, so a slow server is never hit in
  // parallel and the sweep never overlaps itself.
  let glitchtipSyncing = false;
  setInterval(() => {
    if (glitchtipSyncing) return;
    glitchtipSyncing = true;
    void syncDueLinks()
      .catch((err) => console.error("glitchtip sync failed", err instanceof Error ? err.name : "error"))
      .finally(() => {
        glitchtipSyncing = false;
      });
  }, GLITCHTIP_SYNC_MS).unref();
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
  // workspace purge job: hard-deletes workspaces whose restore window closed
  // one sweep at a time: a slow purge never overlaps the next tick
  let purging = false;
  const purge = () => {
    if (purging) return;
    purging = true;
    void sweepDeletedWorkspaces()
      .then((ids) => {
        if (ids.length > 0) console.log(`purged ${ids.length} deleted workspace(s)`);
      })
      .catch((err) => console.error("workspace purge failed", err))
      .finally(() => {
        purging = false;
      });
  };
  setInterval(purge, 60 * 60_000).unref();
  purge();
  // fail at boot, not at the first reset request, on a bad mail config
  const mail = mailer();
  if (mail.transport === "log" && process.env.NODE_ENV === "production") {
    console.warn(
      "MAIL_TRANSPORT=log in production: reset and verification links go to this log only",
    );
  }
  // usage metering: API-call counters every minute, daily rollup hourly
  setInterval(() => {
    void flushApiCalls().catch((err) => console.error("usage flush failed", err));
  }, 60_000).unref();
  setInterval(() => {
    void rollupTick().catch((err) => console.error("usage rollup failed", err));
  }, 3_600_000).unref();
  void rollupTick().catch((err) => console.error("usage rollup failed", err));
  serve({ fetch: app.fetch, port: config_.port }, (info) => {
    console.log(`api listening on http://localhost:${info.port}`);
  });
}
