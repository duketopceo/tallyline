import { NextResponse } from "next/server";

// Relative-Location redirect — never build redirect targets from req.url.
// Behind a reverse proxy or tunnel the request Host can be the upstream
// name (e.g. localhost:3100), which would leak into absolute redirects and
// send the browser to an unreachable origin. A relative Location resolves
// against whatever origin the browser actually requested.
export function redirectTo(path: string, status = 307): NextResponse {
  const res = new NextResponse(null, { status });
  res.headers.set("location", path);
  return res;
}

// Middleware variant. Next's production edge runtime throws
// `TypeError: Invalid URL` on a relative Location from middleware, so build an
// absolute one from the Host header the browser sent (the tunnel forwards it
// unchanged). X-Forwarded-Host is ignored: a client could set it to another
// origin and turn the login redirect into an open redirect.
export function middlewareRedirect(req: Request, path: string, status = 307): NextResponse {
  if (!path.startsWith("/") || path.startsWith("//")) {
    throw new Error("middlewareRedirect only accepts same-origin paths");
  }
  const reqUrl = new URL(req.url);
  const forwarded = req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const proto = forwarded === "https" || forwarded === "http" ? forwarded : reqUrl.protocol.replace(":", "");
  const host = req.headers.get("host") ?? reqUrl.host;
  const res = new NextResponse(null, { status });
  res.headers.set("location", new URL(path, `${proto}://${host}`).toString());
  return res;
}
