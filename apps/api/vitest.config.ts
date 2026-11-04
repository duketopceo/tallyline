import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["./test/require-safe-db.ts", "./test/global-setup.ts"],
    setupFiles: ["./test/setup-file.ts"],
    env: {
      GITHUB_WEBHOOK_SECRET: "test-webhook-secret",
      SENTRY_SIGNING_SECRET: "test-sentry-signing-secret",
      GITHUB_APP_SLUG: "tallyline-test",
      SLACK_BOT_TOKEN: "xoxb-test-token",
      SLACK_SIGNING_SECRET: "test-slack-secret",
      SLACK_WORKSPACE_SLUG: "slack-test",
      // the shared test process is one "client": disable the IP limiters for
      // the integration suites (rate-limit.test.ts exercises them directly)
      RATE_LIMIT_ANON_PER_MIN: "0",
      RATE_LIMIT_AUTH_PER_MIN: "0",
      TRUSTED_PROXY: "1",
      // existing tests deliver to 127.0.0.1 listeners; net-guard tests flip it off
      TALLYLINE_WEBHOOK_ALLOW_PRIVATE: "1",
    },
  },
});
