/**
 * Sign in with Apple as an OAuthProvider for the web redirect flow.
 * Client secret is an ES256 JWT (Apple's requirement), minted from TEAM_ID/KEY_ID/p8.
 */
import { createPrivateKey, createSign } from "node:crypto";
import * as client from "openid-client";
import type { IdentityResult, OAuthProvider } from "./types.js";

const APPLE_ISSUER = "https://appleid.apple.com";
const discoveryCache = new Map<string, Promise<client.Configuration>>();

function discover(clientId: string, clientSecret: string) {
  let p = discoveryCache.get(clientId);
  if (!p) {
    p = client.discovery(new URL(APPLE_ISSUER), clientId, clientSecret);
    discoveryCache.set(clientId, p);
    p.catch(() => discoveryCache.delete(clientId));
  }
  return p;
}

/** Apple client_secret: ES256 JWT, max ~6 months; we mint ~1 day. */
export function mintAppleClientSecret(opts: {
  teamId: string;
  clientId: string;
  keyId: string;
  privateKeyPem: string;
  nowSeconds?: number;
}): string {
  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "ES256", kid: opts.keyId })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      iss: opts.teamId,
      iat: now,
      exp: now + 86_400,
      aud: APPLE_ISSUER,
      sub: opts.clientId,
    }),
  ).toString("base64url");
  const key = createPrivateKey(opts.privateKeyPem);
  const sig = createSign("SHA256").update(`${header}.${payload}`).sign({ key, dsaEncoding: "ieee-p1363" });
  return `${header}.${payload}.${Buffer.from(sig).toString("base64url")}`;
}

export function appleWebReady(env: {
  appleClientId: string;
  appleTeamId: string;
  appleKeyId: string;
  applePrivateKey: string;
}): boolean {
  return !!(env.appleClientId && env.appleTeamId && env.appleKeyId && env.applePrivateKey);
}

export function appleProvider(opts: {
  key: string;
  label: string;
  clientId: string;
  teamId: string;
  keyId: string;
  privateKeyPem: string;
  source: "env" | "db";
}): OAuthProvider {
  const secret = () =>
    mintAppleClientSecret({
      teamId: opts.teamId,
      clientId: opts.clientId,
      keyId: opts.keyId,
      privateKeyPem: opts.privateKeyPem,
    });

  return {
    key: opts.key,
    type: "apple",
    label: opts.label,
    public: {
      clientId: opts.clientId,
      scopes: ["openid", "email", "name"],
      issuer: APPLE_ISSUER,
      source: opts.source,
    },
    async authorizeUrl({ redirectUri, state, nonce, codeChallenge }) {
      const u = new URL("https://appleid.apple.com/auth/authorize");
      u.searchParams.set("client_id", opts.clientId);
      u.searchParams.set("redirect_uri", redirectUri);
      u.searchParams.set("response_type", "code");
      // query works for our GET callback; form_post would need a POST route
      u.searchParams.set("response_mode", "query");
      u.searchParams.set("scope", "openid email name");
      u.searchParams.set("state", state);
      u.searchParams.set("nonce", nonce);
      u.searchParams.set("code_challenge", codeChallenge);
      u.searchParams.set("code_challenge_method", "S256");
      return u.toString();
    },
    async exchange({ code, redirectUri, codeVerifier, nonce }): Promise<IdentityResult> {
      const config = await discover(opts.clientId, secret());
      const callbackUrl = new URL(redirectUri);
      callbackUrl.searchParams.set("code", code);
      const checks: client.AuthorizationCodeGrantChecks = { idTokenExpected: true };
      if (codeVerifier) checks.pkceCodeVerifier = codeVerifier;
      if (nonce) checks.expectedNonce = nonce;
      const tokens = await client.authorizationCodeGrant(config, callbackUrl, checks);
      const claims = tokens.claims();
      if (!claims?.sub) throw new Error("apple id_token missing subject");
      return {
        subject: String(claims.sub),
        email: typeof claims.email === "string" ? claims.email : null,
        emailVerified:
          claims.email_verified === true ||
          claims.email_verified === "true" ||
          typeof claims.email === "string",
        name: typeof claims.name === "string" ? claims.name : null,
        avatarUrl: null,
        hd: null,
      };
    },
  };
}
