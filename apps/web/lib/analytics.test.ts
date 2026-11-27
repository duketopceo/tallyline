import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_UMAMI_SCRIPT_URL,
  getUmamiConfig,
  sanitizeAnalyticsProps,
  trackEvent,
} from "./analytics";

const savedWebsiteId = process.env.NEXT_PUBLIC_UMAMI_WEBSITE_ID;

afterEach(() => {
  if (savedWebsiteId === undefined) delete process.env.NEXT_PUBLIC_UMAMI_WEBSITE_ID;
  else process.env.NEXT_PUBLIC_UMAMI_WEBSITE_ID = savedWebsiteId;
  vi.unstubAllGlobals();
});

describe("getUmamiConfig", () => {
  it("returns null when NEXT_PUBLIC_UMAMI_WEBSITE_ID is unset (off for self-hosters)", () => {
    expect(getUmamiConfig({})).toBeNull();
    expect(getUmamiConfig({ NEXT_PUBLIC_UMAMI_WEBSITE_ID: "   " })).toBeNull();
  });

  it("uses the default first-party script URL when only website ID is set", () => {
    expect(getUmamiConfig({ NEXT_PUBLIC_UMAMI_WEBSITE_ID: "site-123" })).toEqual({
      websiteId: "site-123",
      scriptUrl: DEFAULT_UMAMI_SCRIPT_URL,
      origin: "https://analytics.tallyline.app",
    });
  });

  it("honors a custom script URL and supports same-origin relative paths", () => {
    expect(
      getUmamiConfig({
        NEXT_PUBLIC_UMAMI_WEBSITE_ID: "site-123",
        NEXT_PUBLIC_UMAMI_SCRIPT_URL: "https://stats.example.com/umami.js",
      }),
    ).toEqual({
      websiteId: "site-123",
      scriptUrl: "https://stats.example.com/umami.js",
      origin: "https://stats.example.com",
    });

    expect(
      getUmamiConfig({
        NEXT_PUBLIC_UMAMI_WEBSITE_ID: "site-123",
        NEXT_PUBLIC_UMAMI_SCRIPT_URL: "/u/script.js",
      }),
    ).toEqual({
      websiteId: "site-123",
      scriptUrl: "/u/script.js",
      origin: null,
    });
  });

  it("rejects invalid script URL schemes", () => {
    expect(
      getUmamiConfig({
        NEXT_PUBLIC_UMAMI_WEBSITE_ID: "site-123",
        NEXT_PUBLIC_UMAMI_SCRIPT_URL: "javascript:alert(1)",
      }),
    ).toBeNull();
  });
});

describe("sanitizeAnalyticsProps", () => {
  it("drops PII keys while keeping safe aggregate properties", () => {
    expect(
      sanitizeAnalyticsProps({
        surface: "command_palette",
        count: 3,
        email: "alice@example.com",
        userName: "alice",
        token: "secret",
      }),
    ).toEqual({ surface: "command_palette", count: 3 });
  });
});

describe("trackEvent", () => {
  it("is a no-op when unconfigured", () => {
    delete process.env.NEXT_PUBLIC_UMAMI_WEBSITE_ID;
    const track = vi.fn();
    vi.stubGlobal("window", { umami: { track } });
    trackEvent("issue_created", { source: "quick_add" });
    expect(track).not.toHaveBeenCalled();
  });

  it("forwards sanitized events when configured and loaded", () => {
    process.env.NEXT_PUBLIC_UMAMI_WEBSITE_ID = "site-123";
    const track = vi.fn();
    vi.stubGlobal("window", { umami: { track } });
    trackEvent("issue_created", { source: "quick_add", email: "drop@me.test" });
    expect(track).toHaveBeenCalledWith("issue_created", { source: "quick_add" });
  });
});
