import { describe, expect, it } from "vitest";
import { isPublicPath } from "./public-paths";

describe("isPublicPath", () => {
  it("treats the landing page and auth pages as public", () => {
    for (const p of ["/", "/login", "/login/sso", "/bootstrap", "/join/abc", "/link/x"]) {
      expect(isPublicPath(p), p).toBe(true);
    }
  });
  it("treats account-recovery, trust pages and security.txt as public", () => {
    for (const p of ["/forgot-password", "/reset-password", "/verify-email", "/privacy", "/terms", "/security", "/status", "/.well-known/security.txt"]) {
      expect(isPublicPath(p), p).toBe(true);
    }
  });
  it("treats static assets and metadata images as public", () => {
    for (const p of ["/_next/static/a.js", "/api/auth/methods", "/favicon.ico", "/brand/mark.svg", "/landing/board-dark.webp", "/opengraph-image.png", "/twitter-image.png"]) {
      expect(isPublicPath(p), p).toBe(true);
    }
  });
  it("keeps every app route behind a session (regression: '/' prefix-matched everything)", () => {
    for (const p of ["/my-issues", "/issues", "/board", "/settings/agents", "/integrations/github/callback", "/activity", "/loginx", "/joined", "/privacy-settings", "/statuses"]) {
      expect(isPublicPath(p), p).toBe(false);
    }
  });
});
