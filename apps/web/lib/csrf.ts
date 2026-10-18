import { NextResponse } from "next/server";

// Cookie-authenticated bridge routes forward the session to the API, so a
// cross-site form or fetch must not be able to drive them. Browsers always
// label a cross-origin mutation with Origin and/or Sec-Fetch-Site.
// Returns a rejection response, or null when the request may proceed.
export function checkBridgeRequest(req: Request): NextResponse | null {
  const method = req.method.toUpperCase();
  if (method === "GET" || method === "HEAD") return null;

  const deny = (status: number, code: string, message: string) =>
    NextResponse.json({ error: { code, message } }, { status });

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
  if (!sameOrigin) return deny(403, "FORBIDDEN_ORIGIN", "cross-origin request refused");

  const hasBody = method !== "DELETE" || req.headers.has("content-type");
  if (hasBody && !/^application\/json\b/i.test(req.headers.get("content-type") ?? "")) {
    return deny(415, "UNSUPPORTED_MEDIA_TYPE", "content-type must be application/json");
  }
  return null;
}
