/**
 * Verify an Apple identity token (SIWA) against Apple's JWKS.
 * Port of the Nimbus verifier: iss, aud, exp, nonce (sha256 of raw nonce), RS256.
 */
import { createHash, createPublicKey, createVerify } from "node:crypto";
import { oauthFetch } from "./providers/types.js";

export const APPLE_ISSUER = "https://appleid.apple.com";
export const APPLE_JWKS_URL = "https://appleid.apple.com/auth/keys";

export class AppleAuthError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "AppleAuthError";
  }
}

export type AppleJwksFetcher = () => Promise<{ keys: JsonWebKey[] }>;

export interface AppleClaims {
  subject: string;
  email: string | null;
  emailVerified: boolean;
}

const defaultJwksFetcher: AppleJwksFetcher = async () => {
  const res = await oauthFetch()(APPLE_JWKS_URL);
  if (!res.ok) throw new AppleAuthError("jwks_fetch_failed");
  return res.json() as Promise<{ keys: JsonWebKey[] }>;
};

function b64urlToBuf(s: string): Buffer {
  const p = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  return Buffer.from(p, "base64");
}

function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

function parseJwt(token: string) {
  const parts = token.split(".");
  if (parts.length !== 3) throw new AppleAuthError("malformed_token");
  try {
    return {
      header: JSON.parse(b64urlToBuf(parts[0]!).toString("utf8")) as { alg: string; kid?: string },
      payload: JSON.parse(b64urlToBuf(parts[1]!).toString("utf8")) as Record<string, unknown>,
      signingInput: `${parts[0]}.${parts[1]}`,
      signature: b64urlToBuf(parts[2]!),
    };
  } catch {
    throw new AppleAuthError("malformed_token");
  }
}

/**
 * @param audiences — accepted `aud` values (iOS bundle id(s) and/or Services ID)
 * @param rawNonce — the nonce the client generated; Apple embeds sha256(rawNonce) as hex
 */
export async function verifyAppleIdentityToken(
  token: string,
  opts: {
    audiences: string[];
    rawNonce: string;
    fetchJwks?: AppleJwksFetcher;
    nowSeconds?: number;
  },
): Promise<AppleClaims> {
  if (!opts.audiences.length) throw new AppleAuthError("no_audience_configured");
  if (!opts.rawNonce) throw new AppleAuthError("bad_nonce");

  const { header, payload, signingInput, signature } = parseJwt(token);
  if (header.alg !== "RS256" || !header.kid) throw new AppleAuthError("bad_alg");

  const jwks = await (opts.fetchJwks ?? defaultJwksFetcher)();
  const jwk = jwks.keys.find((k) => (k as { kid?: string }).kid === header.kid);
  if (!jwk) throw new AppleAuthError("unknown_kid");

  const key = createPublicKey({ key: jwk as object, format: "jwk" });
  const ok = createVerify("RSA-SHA256").update(signingInput).verify(key, signature);
  if (!ok) throw new AppleAuthError("bad_signature");

  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (payload.iss !== APPLE_ISSUER) throw new AppleAuthError("bad_issuer");

  const aud = payload.aud;
  const audOk =
    (typeof aud === "string" && opts.audiences.includes(aud)) ||
    (Array.isArray(aud) && aud.some((a) => typeof a === "string" && opts.audiences.includes(a)));
  if (!audOk) throw new AppleAuthError("bad_audience");

  if (typeof payload.exp !== "number" || payload.exp <= now) throw new AppleAuthError("expired");
  if (payload.nonce !== sha256Hex(opts.rawNonce)) throw new AppleAuthError("bad_nonce");
  if (typeof payload.sub !== "string" || !payload.sub) throw new AppleAuthError("no_sub");

  const email = typeof payload.email === "string" ? payload.email : null;
  // Apple may omit email_verified; treat presence of email as verified for SIWA
  const emailVerified =
    payload.email_verified === true ||
    payload.email_verified === "true" ||
    (email !== null && payload.email_verified !== false && payload.email_verified !== "false");

  return { subject: payload.sub, email, emailVerified: !!email && emailVerified };
}
