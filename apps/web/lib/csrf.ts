import { NextResponse } from "next/server";

// Cookie-authenticated bridge routes forward the session to the API, so a
// cross-site form or fetch must not be able to drive them. Browsers always
// label a cross-origin mutation with Origin and/or Sec-Fetch-Site.
// Returns a rejection response, or null when the request may proceed.
const deny = (status: number, code: string, message: string) =>
  NextResponse.json({ error: { code, message } }, { status });

const isRead = (req: Request) => ["GET", "HEAD"].includes(req.method.toUpperCase());

// Origin / Sec-Fetch-Site half only. middleware.ts applies it to every
// /api/* write so no route can forget it (login, logout and bootstrap
// included: a forged cross-site login is a login-CSRF).
export function checkOrigin(req: Request): NextResponse | null {
  if (isRead(req)) return null;
  const site = req.headers.get("sec-fetch-site");
  let sameOrigin = site === "same-origin";
  if (!sameOrigin && site === null) {
    const origin = req.headers.get("origin");
    const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? new URL(req.url).host;
    if (origin && host) {
      try {
        sameOrigin = new URL(origin).host === host;
      } catch {
        sameOrigin = false;
      }
    }
  }
  return sameOrigin ? null : deny(403, "FORBIDDEN_ORIGIN", "cross-origin request refused");
}

// Origin check plus the JSON content-type rule, for the bridge routes that
// forward a JSON body (proxy() and the OAuth consent route).
export function checkBridgeRequest(req: Request): NextResponse | null {
  const refused = checkOrigin(req);
  if (refused) return refused;
  if (isRead(req)) return null;
  const method = req.method.toUpperCase();
  const hasBody = method !== "DELETE" || req.headers.has("content-type");
  if (hasBody && !/^application\/json\b/i.test(req.headers.get("content-type") ?? "")) {
    return deny(415, "UNSUPPORTED_MEDIA_TYPE", "content-type must be application/json");
  }
  return null;
}
