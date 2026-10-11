// Paths the middleware lets through without a session. "/" is matched exactly:
// a prefix match on "/" would make every route public.
const EXACT = new Set(["/", "/favicon.ico", "/icon.svg", "/apple-icon.png"]);
const PREFIXES = [
  "/login",
  "/bootstrap",
  "/join",
  "/link",
  "/_next/",
  "/api/",
  "/brand/",
  "/marketing/",
  "/opengraph-image",
  "/twitter-image",
];

export function isPublicPath(pathname: string): boolean {
  if (EXACT.has(pathname)) return true;
  return PREFIXES.some((p) =>
    p.endsWith("/") ? pathname.startsWith(p) : pathname === p || pathname.startsWith(`${p}/`) || pathname.startsWith(`${p}.`) || pathname.startsWith(`${p}?`),
  );
}
