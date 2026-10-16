import { readEnv } from "@tallyline/types";
import { config } from "dotenv";
import { parseKeyExpiryDays } from "./lib/key-expiry.js";
import { assertProductionSecrets, DEV_JWT_SECRET } from "./lib/startup-guard.js";

config({ path: new URL("../../../.env", import.meta.url) });

const env = (key: string, fallback?: string): string => {
  const value = readEnv(process.env, key) ?? fallback;
  if (value === undefined) {
    throw new Error(`Missing required env var: ${key}`);
  }
  return value;
};

// production boot refuses unset/default/weak secrets (see lib/startup-guard.ts)
assertProductionSecrets({
  nodeEnv: process.env.NODE_ENV,
  jwtSecret: readEnv(process.env, "JWT_SECRET"),
  authSecretKey: readEnv(process.env, "AUTH_SECRET_KEY"),
});

const apiBaseUrl = env("API_BASE_URL", "http://localhost:4000").replace(/\/+$/, "");

export const config_ = {
  port: Number(env("API_PORT", "4000")),
  databaseUrl: env(
    "DATABASE_URL",
    "postgresql://postgres:postgres@localhost:5432/tallyline",
  ),
  jwtSecret: env("JWT_SECRET", DEV_JWT_SECRET),
  rateLimitPerMin: Number(env("RATE_LIMIT_PER_MIN", "600")),
  // expiry applied to a newly minted or rotated agent key when the caller
  // gives none (days; 0 = keys never expire by default)
  agentKeyDefaultExpiryDays: parseKeyExpiryDays(
    readEnv(process.env, "AGENT_KEY_DEFAULT_EXPIRY_DAYS"),
  ),
  // unauthenticated traffic per client IP (and failed-credential attempts)
  rateLimitAnonPerMin: Number(env("RATE_LIMIT_ANON_PER_MIN", "120")),
  // login / bootstrap / invite-accept / OAuth start+callback per client IP
  rateLimitAuthPerMin: Number(env("RATE_LIMIT_AUTH_PER_MIN", "30")),
  // dispatch ack window: a dispatch still `queued` this long is dead —
  // delivery retries (max ~7.5 min) must finish inside it. 0 disables.
  dispatchAckTimeoutMs: Number(env("DISPATCH_ACK_TIMEOUT_MS", "600000")),
  // agent session windows (plan L1): first activity must land inside the
  // ack window (Linear uses 10 s); an active session quiet past the idle
  // window is marked stale. 0 disables either sweep.
  sessionAckTimeoutMs: Number(env("SESSION_ACK_TIMEOUT_MS", "10000")),
  sessionIdleTimeoutMs: Number(env("SESSION_IDLE_TIMEOUT_MS", "1800000")),
  apiBaseUrl,
  // MCP remote endpoint + OAuth authorization server (PLAN-010/011). The
  // issuer is apiBaseUrl; the resource is the canonical MCP endpoint URL that
  // access tokens are audience-bound to.
  mcpResourceUrl: env("MCP_RESOURCE_URL", `${apiBaseUrl}/mcp`).replace(/\/+$/, ""),
  // browser Origins allowed to call /mcp (DNS-rebinding guard); requests with
  // no Origin (every non-browser MCP client) are always allowed
  mcpAllowedOrigins: env(
    "MCP_ALLOWED_ORIGINS",
    "https://claude.ai,https://chatgpt.com",
  )
    .split(",")
    .map((o) => o.trim().replace(/\/+$/, ""))
    .filter(Boolean),
  // github_webhook_events retention (services/retention.ts): payloads are
  // cleared after the TTL; rows (delivery ids) are deleted after the window.
  webhookEventPayloadTtlHours: Number(env("WEBHOOK_EVENT_PAYLOAD_TTL_HOURS", "24")),
  webhookEventRetentionDays: Number(env("WEBHOOK_EVENT_RETENTION_DAYS", "7")),
  githubAppSlug: env("GITHUB_APP_SLUG", ""),
  githubWebhookSecret: env("GITHUB_WEBHOOK_SECRET", ""),

  githubAppId: env("GITHUB_APP_ID", ""),
  // PEM may arrive env-encoded with literal \n separators (common for
  // GitHub App keys in .env files / secret stores)
  githubAppPrivateKey: env("GITHUB_APP_PRIVATE_KEY", "").replace(
    /\\n/g,
    "\n",
  ),

  // Slack app — empty means every slack surface is off
  slackBotToken: env("SLACK_BOT_TOKEN", ""),
  slackSigningSecret: env("SLACK_SIGNING_SECRET", ""),
  // the tallyline workspace this Slack app reports into
  slackWorkspaceSlug: env("SLACK_WORKSPACE_SLUG", ""),
  slackIntakeEmoji: env("SLACK_INTAKE_EMOJI", "ticket"),

  // oauth / web origins
  webUrl: env("WEB_URL", "http://localhost:3100").replace(/\/$/, ""),
  // honors CF-Connecting-IP / x-forwarded-for / x-forwarded-proto — only set
  // behind a real reverse proxy or Cloudflare (spoofable otherwise)
  trustedProxy: ["1", "true", "yes"].includes(
    env("TRUSTED_PROXY", "").toLowerCase(),
  ),

  // auth feature flags
  authSecretKey: env("AUTH_SECRET_KEY", ""),
  authDisablePassword: ["1", "true", "yes"].includes(
    env("AUTH_DISABLE_PASSWORD", "").toLowerCase(),
  ),
  authAccountLinking: env("AUTH_ACCOUNT_LINKING", "auto") as
    | "auto"
    | "login"
    | "disabled",
  authAllowedEmailDomains: env("AUTH_ALLOWED_EMAIL_DOMAINS", "")
    .split(",")
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean),
  // default OFF: on an internet-facing install auto-join is open membership
  authAutoJoinSingleWorkspace: ["1", "true", "yes"].includes(
    env("AUTH_AUTO_JOIN_SINGLE_WORKSPACE", "").toLowerCase(),
  ),
  // default OFF: only instance admins may create workspaces; 1 lets any
  // signed-in human do so (self-host teams that want self-serve orgs)
  allowWorkspaceCreate: ["1", "true", "yes"].includes(
    env("TALLYLINE_ALLOW_WORKSPACE_CREATE", "").toLowerCase(),
  ),

  // oauth providers — empty client id = provider absent
  githubClientId: env("GITHUB_CLIENT_ID", ""),
  githubClientSecret: env("GITHUB_CLIENT_SECRET", ""),
  googleClientId: env("GOOGLE_CLIENT_ID", ""),
  googleClientSecret: env("GOOGLE_CLIENT_SECRET", ""),
  oidcIssuer: env("OIDC_ISSUER", ""),
  oidcClientId: env("OIDC_CLIENT_ID", ""),
  oidcClientSecret: env("OIDC_CLIENT_SECRET", ""),
  oidcDisplayName: env("OIDC_DISPLAY_NAME", ""),
  oidcScopes: env("OIDC_SCOPES", "email profile"),

  // auth — instance admins get provider settings + always-admin rights;
  // when unset, the bootstrap owner is the fallback admin (KTD10)
  authAdminEmails: env("AUTH_ADMIN_EMAILS", "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean),

  // transactional mail (password reset, email verification, notices).
  // log = default: messages go to the server log and, outside production,
  // to the in-memory dev inbox. smtp = SMTP_URL (smtp:// with STARTTLS or
  // smtps://). cloudflare = Cloudflare Email Sending REST API.
  mailTransport: env("MAIL_TRANSPORT", "log").trim().toLowerCase(),
  mailFrom: env("MAIL_FROM", "Tallyline <no-reply@tallyline.invalid>"),
  smtpUrl: env("SMTP_URL", ""),
  cloudflareAccountId: env("CLOUDFLARE_ACCOUNT_ID", ""),
  cloudflareEmailApiToken: env("CLOUDFLARE_EMAIL_API_TOKEN", ""),
  // workspace soft-delete window before the purge job hard deletes
  workspacePurgeDays: Number(env("WORKSPACE_PURGE_DAYS", "7")),
  // hosted plans + limits (PLAN-059). Default OFF: self-host is
  // self_host_unlimited and no limit is ever enforced. BILLING=on reads
  // workspaces.plan and enforces the numbers in src/plans.ts.
  billing: ["1", "true", "yes", "on"].includes(env("BILLING", "").toLowerCase()),

  // LLM assist — entirely opt-in; empty key means every llm surface is off
  llmApiKey: env("TALLYLINE_LLM_API_KEY", ""),
  llmBaseUrl: env("TALLYLINE_LLM_BASE_URL", "https://openrouter.ai/api/v1"),
  // cheap-by-default per the spend ceiling; override for your budget
  llmModel: env("TALLYLINE_LLM_MODEL", "google/gemini-2.5-flash-lite"),
} as const;
