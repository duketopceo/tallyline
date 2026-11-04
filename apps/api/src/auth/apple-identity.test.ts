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

  function goodClaims(extra: Record<string, unknown> = {}) {
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
});
