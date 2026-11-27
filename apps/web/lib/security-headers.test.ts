import { describe, expect, it } from "vitest";
import { buildCsp, collectConnectSrc, isHttpsRequest, newNonce } from "./security-headers";

describe("buildCsp", () => {
  it("is nonce + strict-dynamic for scripts, no unsafe-eval in production", () => {
    const csp = buildCsp("abc123", { dev: false });
    expect(csp).toContain("script-src 'self' 'nonce-abc123' 'strict-dynamic'");
    expect(csp).not.toContain("unsafe-eval");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("default-src 'self'");
  });
  it("allows unsafe-eval in dev only", () => {
    expect(buildCsp("n", { dev: true })).toContain("'unsafe-eval'");
  });
  it("adds extra connect-src origins", () => {
    expect(buildCsp("n", { dev: false, connectSrc: ["https://api.example.com"] })).toContain(
      "connect-src 'self' https://api.example.com",
    );
  });
});

describe("isHttpsRequest", () => {
  it("is false outside production", () => {
    expect(isHttpsRequest("https", "https://x.test/", "development")).toBe(false);
  });
  it("honors x-forwarded-proto, then the URL scheme", () => {
    expect(isHttpsRequest("https", "http://x.test/", "production")).toBe(true);
    expect(isHttpsRequest("http", "https://x.test/", "production")).toBe(false);
    expect(isHttpsRequest(null, "https://x.test/", "production")).toBe(true);
    expect(isHttpsRequest(null, "http://x.test/", "production")).toBe(false);
  });
});

describe("newNonce", () => {
  it("is unique per call", () => {
    expect(newNonce()).not.toBe(newNonce());
  });
});

describe("collectConnectSrc", () => {
  it("returns empty when no optional origins are configured", () => {
    expect(collectConnectSrc({})).toEqual([]);
  });

  it("collects API, Sentry DSN, and Umami origins when opted in", () => {
    expect(
      collectConnectSrc({
        NEXT_PUBLIC_API_URL: "https://api.tallyline.app",
        NEXT_PUBLIC_SENTRY_DSN: "https://abc123@errors.tallyline.app/1",
        NEXT_PUBLIC_UMAMI_WEBSITE_ID: "site-123",
        NEXT_PUBLIC_UMAMI_SCRIPT_URL: "https://analytics.tallyline.app/script.js",
      }),
    ).toEqual([
      "https://api.tallyline.app",
      "https://errors.tallyline.app",
      "https://analytics.tallyline.app",
    ]);
  });
});
