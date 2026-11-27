import type { ErrorEvent } from "@sentry/node";
import { describe, expect, it } from "vitest";
import { initTelemetry, isTelemetryEnabled, scrubSentryEvent } from "./telemetry.js";

describe("API telemetry", () => {
  it("is a complete zero-op when SENTRY_DSN is unset", () => {
    expect(initTelemetry({ dsn: "" })).toBe(false);
    expect(initTelemetry({ dsn: "   " })).toBe(false);
    expect(initTelemetry({})).toBe(false);
    expect(isTelemetryEnabled()).toBe(false);
  });

  it("scrubs secrets, headers, cookies, webhook URLs, OAuth tokens, and user PII", () => {
    const event: ErrorEvent = {
      type: undefined,
      request: {
        url: "https://api.tallyline.app/webhooks/glitchtip/gt-secret-99?code=oauth_code&state=s1",
        query_string: "access_token=tok_123&safe=1",
        cookies: { tly_session: "raw-session-cookie" },
        headers: {
          authorization: "Bearer super-secret-jwt",
          cookie: "tly_session=raw-session-cookie",
          "x-hub-signature-256": "sha256=deadbeef",
          "user-agent": "tallyline-test",
        },
      },
      user: {
        id: "user-1",
        email: "alice@example.com",
        ip_address: "203.0.113.10",
        username: "alice",
      },
      extra: {
        oauthToken: "gho_secret",
        nested: { api_key: "key_123", ok: "visible" },
      },
      breadcrumbs: [
        {
          message: "POST /webhooks/glitchtip/gt-secret-99 Authorization: Bearer abc.def",
          data: { url: "https://api.tallyline.app/v1/auth/oauth/github/callback?code=xyz" },
        },
      ],
      exception: {
        values: [
          {
            value: "Failed calling https://api.tallyline.app/webhooks/glitchtip/gt-secret-99 with Bearer tok123",
          },
        ],
      },
    };

    const scrubbed = scrubSentryEvent(event);
    expect(scrubbed.request?.headers?.authorization).toBe("[REDACTED]");
    expect(scrubbed.request?.headers?.cookie).toBe("[REDACTED]");
    expect(scrubbed.request?.headers?.["x-hub-signature-256"]).toBe("[REDACTED]");
    expect(scrubbed.request?.headers?.["user-agent"]).toBe("tallyline-test");
    expect(scrubbed.request?.cookies).toBeUndefined();
    expect(scrubbed.request?.url).not.toContain("gt-secret-99");
    expect(scrubbed.request?.url).not.toContain("oauth_code");
    expect(scrubbed.request?.query_string).not.toContain("tok_123");
    expect(scrubbed.user?.id).toBe("user-1");
    expect(scrubbed.user?.email).toBeUndefined();
    expect(scrubbed.user?.ip_address).toBeUndefined();
    expect(scrubbed.user?.username).toBeUndefined();
    expect(scrubbed.extra?.oauthToken).toBe("[REDACTED]");
    expect((scrubbed.extra?.nested as Record<string, unknown>).api_key).toBe("[REDACTED]");
    expect((scrubbed.extra?.nested as Record<string, unknown>).ok).toBe("visible");
    expect(scrubbed.breadcrumbs?.[0]?.message).not.toContain("gt-secret-99");
    expect(scrubbed.breadcrumbs?.[0]?.message).not.toContain("abc.def");
    expect(scrubbed.breadcrumbs?.[0]?.data?.url).not.toContain("xyz");
    expect(scrubbed.exception?.values?.[0]?.value).not.toContain("gt-secret-99");
    expect(scrubbed.exception?.values?.[0]?.value).not.toContain("tok123");
  });
});
