import type { ErrorEvent } from "@sentry/node";
import { describe, expect, it } from "vitest";
import {
  initRelayTelemetry,
  isRelayTelemetryEnabled,
  scrubRelayEvent,
} from "./telemetry.js";

describe("push-relay telemetry", () => {
  it("is a zero-op when SENTRY_DSN is unset", () => {
    expect(initRelayTelemetry({})).toBe(false);
    expect(initRelayTelemetry({ SENTRY_DSN: "" })).toBe(false);
    expect(isRelayTelemetryEnabled()).toBe(false);
  });

  it("scrubs auth headers, cookies, APNs device tokens, handles, and webhook secrets", () => {
    const event: ErrorEvent = {
      type: undefined,
      request: {
        url: "https://relay.tallyline.app/webhooks/glitchtip/secret-1?token=abc",
        cookies: { sid: "raw" },
        headers: {
          authorization: "Bearer apns-jwt",
          cookie: "sid=raw",
          "x-tallyline-signature": "sig-bytes",
        },
      },
      extra: {
        deviceToken: "deadbeef01234567",
        pushHandle: "sealed-handle-blob",
        status: 202,
      },
      user: { email: "u@example.com", ip_address: "192.0.2.1" },
    };

    const scrubbed = scrubRelayEvent(event);
    expect(scrubbed.request?.headers?.authorization).toBe("[REDACTED]");
    expect(scrubbed.request?.headers?.cookie).toBe("[REDACTED]");
    expect(scrubbed.request?.headers?.["x-tallyline-signature"]).toBe("[REDACTED]");
    expect(scrubbed.request?.cookies).toBeUndefined();
    expect(scrubbed.request?.url).not.toContain("secret-1");
    expect(scrubbed.request?.url).not.toContain("abc");
    expect(scrubbed.extra?.deviceToken).toBe("[REDACTED]");
    expect(scrubbed.extra?.pushHandle).toBe("[REDACTED]");
    expect(scrubbed.extra?.status).toBe(202);
    expect(scrubbed.user?.email).toBeUndefined();
    expect(scrubbed.user?.ip_address).toBeUndefined();
  });
});
