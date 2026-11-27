import type { ErrorEvent } from "@sentry/browser";
import { describe, expect, it } from "vitest";
import {
  initWebTelemetry,
  isWebTelemetryEnabled,
  scrubBrowserEvent,
} from "./telemetry";

describe("web telemetry", () => {
  it("is a zero-op when NEXT_PUBLIC_SENTRY_DSN is unset", () => {
    expect(initWebTelemetry("")).toBe(false);
    expect(initWebTelemetry("   ")).toBe(false);
    expect(initWebTelemetry(undefined)).toBe(false);
    expect(isWebTelemetryEnabled()).toBe(false);
  });

  it("scrubs headers, cookies, webhook secrets, OAuth query params, and user PII", () => {
    const event: ErrorEvent = {
      type: undefined,
      request: {
        url: "https://tallyline.app/v1/auth/oauth/github/callback?code=gho_123&state=st_456",
        cookies: { tly_session: "sess" },
        headers: {
          authorization: "Bearer jwt_secret",
          cookie: "tly_session=sess",
        },
      },
      user: {
        id: "u-1",
        email: "person@example.com",
        ip_address: "203.0.113.5",
        username: "person",
      },
      breadcrumbs: [
        { message: "fetch /webhooks/glitchtip/gt_tok_789" },
      ],
    };

    const scrubbed = scrubBrowserEvent(event);
    expect(scrubbed.request?.headers?.authorization).toBe("[REDACTED]");
    expect(scrubbed.request?.headers?.cookie).toBe("[REDACTED]");
    expect(scrubbed.request?.cookies).toBeUndefined();
    expect(scrubbed.request?.url).not.toContain("gho_123");
    expect(scrubbed.request?.url).not.toContain("st_456");
    expect(scrubbed.breadcrumbs?.[0]?.message).not.toContain("gt_tok_789");
    expect(scrubbed.user?.id).toBe("u-1");
    expect(scrubbed.user?.email).toBeUndefined();
    expect(scrubbed.user?.ip_address).toBeUndefined();
    expect(scrubbed.user?.username).toBeUndefined();
  });
});
