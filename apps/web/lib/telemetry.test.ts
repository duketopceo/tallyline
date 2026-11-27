import { afterEach, describe, expect, it, vi } from "vitest";
import {
  captureWebException,
  disposeWebTelemetry,
  initWebTelemetry,
  isWebTelemetryEnabled,
  parseSentryDsn,
  scrubBrowserEvent,
  type WebErrorEvent,
} from "./telemetry";

describe("web telemetry", () => {
  afterEach(() => {
    disposeWebTelemetry();
    vi.unstubAllGlobals();
  });

  it("is a zero-op when NEXT_PUBLIC_SENTRY_DSN is unset", () => {
    expect(initWebTelemetry("")).toBe(false);
    expect(initWebTelemetry("   ")).toBe(false);
    expect(initWebTelemetry(undefined)).toBe(false);
    expect(isWebTelemetryEnabled()).toBe(false);
  });

  it("parses a GlitchTip/Sentry DSN into a store endpoint URL", () => {
    const parsed = parseSentryDsn("https://abc123@errors.tallyline.app/7");
    expect(parsed).toEqual({
      publicKey: "abc123",
      storeUrl:
        "https://errors.tallyline.app/api/7/store/?sentry_key=abc123&sentry_version=7&sentry_client=tallyline-web%2F1.0",
    });
    expect(parseSentryDsn("not-a-dsn")).toBeNull();
  });

  it("sends POST with X-Sentry-Auth and scrubbed payload, then tears down cleanly", () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    expect(initWebTelemetry("https://abc123@errors.tallyline.app/7")).toBe(true);
    expect(isWebTelemetryEnabled()).toBe(true);

    captureWebException(new Error("Request to /webhooks/glitchtip/secret_tok failed with Bearer jwt_123"));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "https://errors.tallyline.app/api/7/store/?sentry_key=abc123&sentry_version=7&sentry_client=tallyline-web%2F1.0",
    );
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["X-Sentry-Auth"]).toBe(
      "Sentry sentry_version=7, sentry_key=abc123, sentry_client=tallyline-web/1.0",
    );
    const body = JSON.parse(String(init.body)) as WebErrorEvent;
    expect(body.exception?.values?.[0]?.value).not.toContain("secret_tok");
    expect(body.exception?.values?.[0]?.value).not.toContain("jwt_123");

    disposeWebTelemetry();
    expect(isWebTelemetryEnabled()).toBe(false);
    captureWebException(new Error("after dispose"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("scrubs headers, cookies, webhook secrets, OAuth query params, and user PII without mutating input", () => {
    const event: WebErrorEvent = {
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
    expect(event.user?.email).toBe("person@example.com");
  });
});
