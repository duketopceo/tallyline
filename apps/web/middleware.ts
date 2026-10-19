import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { checkOrigin } from "@/lib/csrf";
import { middlewareRedirect } from "@/lib/redirect";
import { isPublicPath } from "@/lib/public-paths";
import {
  buildCsp,
  HSTS_VALUE,
  isHttpsRequest,
  newNonce,
  STATIC_SECURITY_HEADERS,
} from "@/lib/security-headers";


function withSecurityHeaders(req: NextRequest, res: NextResponse, csp?: string) {
  for (const [k, v] of Object.entries(STATIC_SECURITY_HEADERS)) res.headers.set(k, v);
  if (csp) res.headers.set("Content-Security-Policy", csp);
  if (isHttpsRequest(req.headers.get("x-forwarded-proto"), req.url, process.env.NODE_ENV)) {
    res.headers.set("Strict-Transport-Security", HSTS_VALUE);
  }
  return res;
}

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  // every web write under /api/ — one gate, so a new route cannot skip it
  if (pathname.startsWith("/api/")) {
    const refused = checkOrigin(req);
    if (refused) {
      refused.headers.set("cache-control", "no-store");
      return withSecurityHeaders(req, refused);
    }
  }
  const nonce = newNonce();
  const csp = buildCsp(nonce, {
    dev: process.env.NODE_ENV === "development",
    connectSrc: process.env.NEXT_PUBLIC_API_URL ? [process.env.NEXT_PUBLIC_API_URL] : [],
  });
  // Next.js reads the nonce from the request's CSP header during SSR
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);
  const pass = () =>
    withSecurityHeaders(req, NextResponse.next({ request: { headers: requestHeaders } }), csp);

  if (isPublicPath(pathname)) {
    return pass();
  }
  if (!req.cookies.get("tly_session")) {
    // the MCP consent page round-trips through login (same-origin path only)
    const returnTo = pathname.startsWith("/oauth/")
      ? `?return_to=${encodeURIComponent(`${pathname}${req.nextUrl.search}`)}`
      : "";
    return withSecurityHeaders(req, middlewareRedirect(req, `/login${returnTo}`));
  }
  return pass();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image).*)"],
};
