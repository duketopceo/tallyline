import { defineConfig } from "@playwright/test";
import { assertSafeTestEnv } from "../../apps/api/test/db-guard.js";

// Never boot the api/web servers (which migrate and write DATABASE_URL)
// against the default dev stack.
assertSafeTestEnv();

// Non-default ports: a dev api/web on :4000/:3100 must never be adopted.
const WEB_PORT = process.env.E2E_WEB_PORT ?? "3110";
const API_PORT = process.env.E2E_API_PORT ?? "4100";

export default defineConfig({
  testDir: "./tests",
  timeout: 45_000,
  // first visit to a route compiles it under `next dev`; give assertions room
  expect: { timeout: 10_000 },
  retries: 0,
  workers: 1,
  reporter: [["list"]],
  globalSetup: "./global-setup.ts",
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    storageState: "tests/.auth/session.json",
  },
  webServer: [
    {
      command: "pnpm dev",
      cwd: "../../apps/api",
      port: Number(API_PORT),
      env: {
        API_PORT,
        // The whole suite runs as ONE signed-in session, and the per-identity
        // limiter (default 600/min, keyed on user+session) is a production
        // abuse guard these specs do not exercise (it has its own unit tests).
        // A busy minute, e.g. the 12-item triage burst after a run of SSR
        // pages, trips it and the page renders "Triage did not load" or
        // "not changed: retry in Ns". Lift the cap for the harness only; the
        // limiter code path stays on.
        RATE_LIMIT_PER_MIN: "100000",
        API_BASE_URL: `http://localhost:${API_PORT}`,
        WEB_URL: `http://localhost:${WEB_PORT}`,
      },
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: `pnpm exec next dev -p ${WEB_PORT}`,
      cwd: "../../apps/web",
      port: Number(WEB_PORT),
      env: {
        NEXT_PUBLIC_API_URL: `http://localhost:${API_PORT}`,
        API_INTERNAL_URL: `http://localhost:${API_PORT}`,
      },
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
