import { createHmac, timingSafeEqual } from "node:crypto";

// Sentry signs every webhook delivery with the integration's client secret:
// `sentry-hook-signature` is the hex HMAC-SHA256 of the raw request body.
// A signature is checked before the payload is parsed, so a forged or unsigned
// delivery never reaches the normaliser.
export const SENTRY_SIGNATURE_HEADER = "sentry-hook-signature";

export function verifySentrySignature(
  rawBody: string,
  header: string | undefined,
  secret: string | undefined,
): boolean {
  if (!secret || !header) return false;
  // tolerate a "sha256=" prefix, which other Sentry-adjacent senders add
  const given = header.trim().toLowerCase().replace(/^sha256=/, "");
  if (!/^[0-9a-f]{64}$/.test(given)) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(given, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

export function signSentryBody(rawBody: string, secret: string): string {
  return createHmac("sha256", secret).update(rawBody).digest("hex");
}
