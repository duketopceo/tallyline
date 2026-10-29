// Pages that a signed-out person reaches from outside the app (a connector
// consent screen, the CLI's device approval) must come back to the same page,
// with its query, once they have signed in. Everything else lands on the
// default page after login. Same-origin paths only.
const ROUND_TRIP = ["/oauth/", "/device"];

export function loginReturnQuery(pathname: string, search: string): string {
  const hit = ROUND_TRIP.some((p) =>
    p.endsWith("/") ? pathname.startsWith(p) : pathname === p,
  );
  return hit ? `?return_to=${encodeURIComponent(`${pathname}${search}`)}` : "";
}
