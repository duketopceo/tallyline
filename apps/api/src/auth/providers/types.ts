import { assertResolvesPublic } from "../../lib/net-guard.js";

// Shared provider contract (KTD7). IdentityResult is the only thing the
// resolver consumes — provider access/refresh tokens are fetched, used,
// and discarded (Scope Boundaries).
export interface IdentityResult {
  subject: string;
  email: string | null;
  emailVerified: boolean;
  name: string | null;
  avatarUrl: string | null;
  hd: string | null; // hosted-domain claim (google/oidc) for domain matching
}

export interface AuthorizeParams {
  redirectUri: string;
  state: string;
  nonce: string;
  codeChallenge: string;
}

export interface ExchangeParams {
  code: string;
  redirectUri: string;
  codeVerifier: string | null;
  nonce: string | null;
}

export interface OAuthProvider {
  key: string;
  type: "github" | "google" | "oidc" | "apple";
  label: string;
  /** non-secret config surfaced to /v1/auth/methods + admin views */
  public: { clientId: string; scopes: string[]; issuer: string | null; source: "env" | "db" };
  authorizeUrl(p: AuthorizeParams): string | Promise<string>;
  exchange(p: ExchangeParams): Promise<IdentityResult>;
}

export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

// egress seam: production uses the SSRF-guarded fetch below; tests inject a
// stub so round-trips never leave the process.
const guardedFetch: FetchLike = async (url, init) => {
  await assertPublicUrl(url);
  const res = await fetch(url, init as RequestInit);
  return {
    ok: res.ok,
    status: res.status,
    json: () => res.json() as Promise<unknown>,
    text: () => res.text(),
  };
};

let fetchImpl: FetchLike = guardedFetch;

export function oauthFetch(): FetchLike {
  return fetchImpl;
}

export function __setProviderFetchForTests(f: FetchLike | null) {
  fetchImpl = f ?? guardedFetch;
}

// SSRF guard for provider-facing egress (KTD10): https-only, and DNS must
// not resolve to loopback/private/link-local/metadata space (shared policy
// in lib/net-guard.ts, also used for webhook + dispatch endpoints). The validated
// origin is what we dial — no check/connect race.
const PRIVATE_HOSTS = new Set(["localhost", "metadata.google.internal"]);
export async function assertPublicUrl(raw: string): Promise<void> {
  const url = new URL(raw);
  if (url.protocol !== "https:") {
    throw new Error(`provider endpoint must be https: ${url.host}`);
  }
  const host = url.hostname.toLowerCase();
  if (PRIVATE_HOSTS.has(host) || host.endsWith(".internal")) {
    throw new Error(`provider endpoint host is not public: ${host}`);
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(":")) {
    throw new Error(`provider endpoint must use a hostname, not an IP: ${host}`);
  }
  await assertResolvesPublic(host, "provider endpoint");
}
