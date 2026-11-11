import { createHash, createSign, generateKeyPairSync, type KeyObject } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AppleAuthError, APPLE_ISSUER, verifyAppleIdentityToken } from "./apple-identity.js";

function b64url(buf: Buffer | string): string {
  const b = typeof buf === "string" ? Buffer.from(buf, "utf8") : buf;
  return b.toString("base64url");
}

function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

function mintToken(opts: {
  privateKey: KeyObject;
  kid: string;
  claims: Record<string, unknown>;
}): string {
  const header = b64url(JSON.stringify({ alg: "RS256", kid: opts.kid }));
  const payload = b64url(JSON.stringify(opts.claims));
  const sig = createSign("RSA-SHA256").update(`${header}.${payload}`).sign({ key: opts.privateKey });
  return `${header}.${payload}.${b64url(sig)}`;
}

describe("verifyAppleIdentityToken", () => {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "test-kid", alg: "RS256", use: "sig" };
  const fetchJwks = async () => ({ keys: [jwk as JsonWebKey] });
  const rawNonce = "client-nonce-1";
  const bundle = "app.tallyline.ios";
  const now = 1_700_000_000;

  function goodClaims(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      iss: APPLE_ISSUER,
      aud: bundle,
      exp: now + 600,
      sub: "apple-sub-abc",
      email: "luke@example.com",
      email_verified: "true",
      nonce: sha256Hex(rawNonce),
      ...extra,
    };
  }

  function omit(claims: Record<string, unknown>, ...keys: string[]): Record<string, unknown> {
    const copy = { ...claims };
    for (const key of keys) delete copy[key];
    return copy;
  }

  it("accepts a valid identity token", async () => {
    const token = mintToken({ privateKey, kid: "test-kid", claims: goodClaims() });
    const claims = await verifyAppleIdentityToken(token, {
      audiences: [bundle],
      rawNonce,
      fetchJwks,
      nowSeconds: now,
    });
    expect(claims).toEqual({
      subject: "apple-sub-abc",
      email: "luke@example.com",
      emailVerified: true,
    });
  });

  it("rejects wrong audience", async () => {
    const token = mintToken({ privateKey, kid: "test-kid", claims: goodClaims() });
    await expect(
      verifyAppleIdentityToken(token, {
        audiences: ["com.other.app"],
        rawNonce,
        fetchJwks,
        nowSeconds: now,
      }),
    ).rejects.toBeInstanceOf(AppleAuthError);
  });

  it("rejects bad nonce", async () => {
    const token = mintToken({ privateKey, kid: "test-kid", claims: goodClaims() });
    await expect(
      verifyAppleIdentityToken(token, {
        audiences: [bundle],
        rawNonce: "other-nonce",
        fetchJwks,
        nowSeconds: now,
      }),
    ).rejects.toMatchObject({ code: "bad_nonce" });
  });

  it("rejects expired tokens", async () => {
    const token = mintToken({
      privateKey,
      kid: "test-kid",
      claims: goodClaims({ exp: now - 1 }),
    });
    await expect(
      verifyAppleIdentityToken(token, {
        audiences: [bundle],
        rawNonce,
        fetchJwks,
        nowSeconds: now,
      }),
    ).rejects.toMatchObject({ code: "expired" });
  });

  it("accepts email_verified as boolean true", async () => {
    const token = mintToken({
      privateKey,
      kid: "test-kid",
      claims: goodClaims({ email_verified: true }),
    });
    const claims = await verifyAppleIdentityToken(token, {
      audiences: [bundle],
      rawNonce,
      fetchJwks,
      nowSeconds: now,
    });
    expect(claims.emailVerified).toBe(true);
    expect(claims.subject).toBe("apple-sub-abc");
  });

  it("does not treat a missing or false email_verified as verified", async () => {
    const withoutFlag = omit(goodClaims(), "email_verified");
    for (const claims of [withoutFlag, goodClaims({ email_verified: "false" })]) {
      const token = mintToken({ privateKey, kid: "test-kid", claims });
      const verified = await verifyAppleIdentityToken(token, {
        audiences: [bundle],
        rawNonce,
        fetchJwks,
        nowSeconds: now,
      });
      expect(verified.subject).toBe("apple-sub-abc");
      expect(verified.emailVerified).toBe(false);
    }
  });

  it("returns a null email when the token has no email claim", async () => {
    const claims = omit(goodClaims(), "email", "email_verified");
    const token = mintToken({ privateKey, kid: "test-kid", claims });
    const verified = await verifyAppleIdentityToken(token, {
      audiences: [bundle],
      rawNonce,
      fetchJwks,
      nowSeconds: now,
    });
    expect(verified).toEqual({
      subject: "apple-sub-abc",
      email: null,
      emailVerified: false,
    });
  });

  it("rejects a signature from a different key", async () => {
    const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const token = mintToken({
      privateKey: other.privateKey,
      kid: "test-kid",
      claims: goodClaims(),
    });
    await expect(
      verifyAppleIdentityToken(token, {
        audiences: [bundle],
        rawNonce,
        fetchJwks,
        nowSeconds: now,
      }),
    ).rejects.toMatchObject({ code: "bad_signature" });
  });

  it("rejects an unknown kid", async () => {
    const token = mintToken({ privateKey, kid: "missing-kid", claims: goodClaims() });
    await expect(
      verifyAppleIdentityToken(token, {
        audiences: [bundle],
        rawNonce,
        fetchJwks,
        nowSeconds: now,
      }),
    ).rejects.toMatchObject({ code: "unknown_kid" });
  });

  it("rejects alg none", async () => {
    const header = b64url(JSON.stringify({ alg: "none", kid: "test-kid" }));
    const payload = b64url(JSON.stringify(goodClaims()));
    const token = `${header}.${payload}.`;
    await expect(
      verifyAppleIdentityToken(token, {
        audiences: [bundle],
        rawNonce,
        fetchJwks,
        nowSeconds: now,
      }),
    ).rejects.toMatchObject({ code: "bad_alg" });
  });
});
