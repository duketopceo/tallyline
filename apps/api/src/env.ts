import { config } from "dotenv";

config({ path: new URL("../../../.env", import.meta.url) });

const env = (key: string, fallback?: string): string => {
  const value = process.env[key] ?? fallback;
  if (value === undefined) {
    throw new Error(`Missing required env var: ${key}`);
  }
  return value;
};

export const config_ = {
  port: Number(env("API_PORT", "4000")),
  databaseUrl: env(
    "DATABASE_URL",
    "postgresql://postgres:postgres@localhost:5432/docketry",
  ),
  redisUrl: env("REDIS_URL", "redis://localhost:6380"),
  jwtSecret: env("JWT_SECRET", "docketry-dev-secret-change-me"),
  rateLimitPerMin: Number(env("RATE_LIMIT_PER_MIN", "600")),
  apiBaseUrl: env("API_BASE_URL", "http://localhost:4000"),
  githubAppSlug: env("GITHUB_APP_SLUG", ""),
  githubWebhookSecret: env("GITHUB_WEBHOOK_SECRET", ""),
  githubAppId: env("GITHUB_APP_ID", ""),
  // PEM may arrive env-encoded with literal \n separators (common for
  // GitHub App keys in .env files / secret stores)
  githubAppPrivateKey: env("GITHUB_APP_PRIVATE_KEY", "").replace(
    /\\n/g,
    "\n",
  ),
} as const;
