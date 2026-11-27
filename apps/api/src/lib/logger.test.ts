import { describe, expect, it } from "vitest";
import { logger, redactUrl, setLogSink, type LogEntry } from "./logger.js";

describe("redactUrl", () => {
  it("redacts GlitchTip webhook secrets in path", () => {
    expect(redactUrl("/webhooks/glitchtip/super-secret-token-123")).toBe(
      "/webhooks/glitchtip/[REDACTED]",
    );
    expect(redactUrl("https://api.tallyline.app/webhooks/glitchtip/abc999")).toBe(
      "https://api.tallyline.app/webhooks/glitchtip/[REDACTED]",
    );
  });

  it("redacts public intake keys and reporter capability tokens", () => {
    expect(redactUrl("/v1/intake/tlintake_secret_key")).toBe("/v1/intake/[REDACTED]");
    expect(redactUrl("/v1/reporters/rep_capability_token")).toBe("/v1/reporters/[REDACTED]");
  });

  it("redacts OAuth callback query parameters and tokens", () => {
    expect(
      redactUrl("/v1/auth/oauth/github/callback?code=gho_secret&state=csrf123"),
    ).toBe("/v1/auth/oauth/github/callback?code=%5BREDACTED%5D&state=%5BREDACTED%5D");
    expect(
      redactUrl("https://api.tallyline.app/v1/auth/oauth/google/callback?access_token=ya29.xxx#id_token=jwt"),
    ).toBe("https://api.tallyline.app/v1/auth/oauth/google/callback?access_token=%5BREDACTED%5D#[REDACTED]");
  });

  it("preserves non-sensitive paths and query params", () => {
    expect(redactUrl("/v1/workspaces/acme/issues?status=open&limit=20")).toBe(
      "/v1/workspaces/acme/issues?status=open&limit=20",
    );
  });
});

describe("structured JSON logger", () => {
  it("emits valid JSON with timestamp, level, msg, request_id and redacted path", () => {
    const lines: string[] = [];
    const restore = setLogSink((_level, line) => lines.push(line));
    try {
      logger.info("http.request", {
        request_id: "req-42",
        method: "POST",
        path: "/webhooks/glitchtip/secret-xyz",
        status: 200,
      });
    } finally {
      restore();
    }

    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!) as LogEntry;
    expect(parsed.level).toBe("info");
    expect(parsed.msg).toBe("http.request");
    expect(parsed.request_id).toBe("req-42");
    expect(parsed.path).toBe("/webhooks/glitchtip/[REDACTED]");
    expect(Number.isNaN(Date.parse(parsed.timestamp))).toBe(false);
  });
});
