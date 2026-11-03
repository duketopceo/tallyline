import { describe, expect, it } from "vitest";
import { signSentryBody, verifySentrySignature } from "./sentry.js";

const SECRET = "sentry-test-signing-secret";

describe("verifySentrySignature", () => {
  const body = JSON.stringify({ action: "triggered" });

  it("accepts the HMAC Sentry sends", () => {
    expect(verifySentrySignature(body, signSentryBody(body, SECRET), SECRET)).toBe(true);
  });

  it("accepts an uppercase signature and a sha256= prefix", () => {
    const sig = signSentryBody(body, SECRET);
    expect(verifySentrySignature(body, sig.toUpperCase(), SECRET)).toBe(true);
    expect(verifySentrySignature(body, `sha256=${sig}`, SECRET)).toBe(true);
  });

  it("refuses a body that changed after signing", () => {
    const sig = signSentryBody(body, SECRET);
    expect(verifySentrySignature(`${body} `, sig, SECRET)).toBe(false);
  });

  it("refuses a signature made with another secret", () => {
    expect(
      verifySentrySignature(body, signSentryBody(body, "other"), SECRET),
    ).toBe(false);
  });

  it("refuses a missing, empty or malformed signature", () => {
    for (const header of [undefined, "", "nope", "z".repeat(64), "a".repeat(63)]) {
      expect(verifySentrySignature(body, header, SECRET)).toBe(false);
    }
  });

  it("refuses everything when no secret is configured", () => {
    expect(verifySentrySignature(body, signSentryBody(body, SECRET), "")).toBe(false);
    expect(verifySentrySignature(body, signSentryBody(body, SECRET), undefined)).toBe(false);
  });
});
