import { isIP } from "node:net";

// Project icons are resolved once, server-side, and stored as a URL. No
// third-party fetch happens here (or on the client beyond the <img> load), so
// there is no SSRF surface: we only construct or validate URLs.

const MAX_LEN = 2048;
const GITHUB_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

/** Avatar URL for the owner of a GitHub `owner/repo` full name, or null. */
export function githubOwnerIconUrl(fullName: string): string | null {
  const owner = fullName.split("/")[0] ?? "";
  if (!fullName.includes("/") || !GITHUB_OWNER.test(owner)) return null;
  return `https://github.com/${owner}.png?size=64`;
}

/** Accepts only public-looking https URLs without credentials; returns the normalized href. */
export function normalizeIconUrl(raw: string): string | null {
  if (raw.length > MAX_LEN) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.username || u.password) return null;
  const host = u.hostname.toLowerCase();
  if (!host.includes(".") || isIP(host.replace(/^\[|\]$/g, "")) !== 0) return null;
  if (host === "localhost" || /\.(localhost|local|internal|localdomain)$/.test(host)) return null;
  return u.href;
}
