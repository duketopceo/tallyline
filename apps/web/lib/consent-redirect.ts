// Where the OAuth consent screen may send the browser after a decision. The API
// has already pinned the URL to the client's registered redirect URI; this is
// the last guard before `window.location.assign`.
//
// Allowed: http(s), and an RFC 8252 private-use scheme (reverse-domain, so it
// contains a dot: `app.tallyline.ios:/oauth/callback`). Never `javascript:`,
// `data:`, `file:` and the like, which have no dot. Keep in step with
// `isPrivateUseScheme` in apps/api/src/services/mcp-oauth.ts.
const PRIVATE_USE_SCHEME = /^[a-z][a-z0-9+-]*(\.[a-z0-9+-]+)+$/;

export function isNavigableRedirect(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol === "https:" || u.protocol === "http:") return true;
  const scheme = u.protocol.replace(/:$/, "");
  return scheme.length <= 128 && PRIVATE_USE_SCHEME.test(scheme);
}
