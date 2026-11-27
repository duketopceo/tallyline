import { getUmamiConfig } from "./analytics";

// Security headers for the web app. CSP uses a per-request nonce
// (script-src 'nonce-…' 'strict-dynamic'): Next.js stamps the nonce on its own
// framework and page scripts during SSR, which is why the root layout is
// force-dynamic. Static headers (nosniff, framing, referrer) apply to every
// response; HSTS only when the request actually arrived over HTTPS.

function parseOrigin(raw: string | undefined): string | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

export function collectConnectSrc(
  env: Record<string, string | undefined>,
): string[] {
  const origins = new Set<string>();
  const apiUrl = env.NEXT_PUBLIC_API_URL?.trim();
  if (apiUrl) origins.add(apiUrl);
  const sentryOrigin = parseOrigin(env.NEXT_PUBLIC_SENTRY_DSN);
  if (sentryOrigin) origins.add(sentryOrigin);
  const umami = getUmamiConfig(env);
  if (umami?.origin) origins.add(umami.origin);
  return [...origins];
}

export function buildCsp(nonce: string, opts: { dev: boolean; connectSrc?: string[] }): string {
  const connect = ["'self'", ...(opts.connectSrc ?? [])].join(" ");
  const directives = [
    "default-src 'self'",
    // 'unsafe-eval' is dev-only (React debugging); production needs none
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${opts.dev ? " 'unsafe-eval'" : ""}`,
    // React/Recharts emit inline style attributes during SSR, which CSP cannot
    // nonce; scripts are the XSS-critical surface and stay strict
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    `connect-src ${connect}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ];
  return directives.join("; ");
}

export const STATIC_SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
};

export const HSTS_VALUE = "max-age=31536000; includeSubDomains";

// mirrors lib/session.ts requestIsHttps: x-forwarded-proto wins (the web
// container sits behind the proxy/tunnel), else the request URL scheme
export function isHttpsRequest(
  forwardedProto: string | null,
  url: string,
  nodeEnv: string | undefined,
): boolean {
  if (nodeEnv !== "production") return false;
  if (forwardedProto) return forwardedProto.split(",")[0]!.trim() === "https";
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

export function newNonce(): string {
  return btoa(crypto.randomUUID());
}
