import type { ErrorEvent } from "@sentry/node";
import { describe, expect, it } from "vitest";
import {
  initMcpTelemetry,
  isMcpTelemetryEnabled,
  scrubMcpEvent,
} from "./telemetry.js";

describe("MCP server telemetry", () => {
  it("is a zero-op when SENTRY_DSN is unset", () => {
    expect(initMcpTelemetry({})).toBe(false);
    expect(initMcpTelemetry({ SENTRY_DSN: "  " })).toBe(false);
    expect(isMcpTelemetryEnabled()).toBe(false);
  });

  it("scrubs auth headers, cookies, webhook URLs, and OAuth query params", () => {
    const event: ErrorEvent = {
      type: undefined,
      request: {
        url: "https://api.tallyline.app/webhooks/glitchtip/sec123?code=abc",
        cookies: { session: "secret" },
        headers: {
          authorization: "Bearer tly_secret_token",
          "x-tallyline-token": "tly_agent_key",
          cookie: "tly_session=xyz",
        },
      },
      user: { email: "bob@example.com", ip_address: "198.51.100.1" },
    };

    const scrubbed = scrubMcpEvent(event);
    expect(scrubbed.request?.headers?.authorization).toBe("[REDACTED]");
    expect(scrubbed.request?.headers?.["x-tallyline-token"]).toBe("[REDACTED]");
    expect(scrubbed.request?.headers?.cookie).toBe("[REDACTED]");
    expect(scrubbed.request?.cookies).toBeUndefined();
    expect(scrubbed.request?.url).not.toContain("sec123");
    expect(scrubbed.request?.url).not.toContain("abc");
    expect(scrubbed.user?.email).toBeUndefined();
    expect(scrubbed.user?.ip_address).toBeUndefined();
  });
});
