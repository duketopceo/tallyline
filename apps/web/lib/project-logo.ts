// Project logos are stored as a public https URL (the API validates the same
// shape before it writes). This turns what the person typed into that URL, so
// a pasted host, a full URL and a path inside the site all work. A bare file
// name ("mark.svg") is read as a path in the site, not as a host.

const IMAGE_EXT = /\.(svg|png|jpe?g|gif|webp|avif|ico)$/i;

function isHostLike(value: string): boolean {
  if (value.startsWith("//")) return true;
  const first = value.split("/")[0] ?? "";
  if (value.includes("/")) return first.includes(".");
  return first.includes(".") && !IMAGE_EXT.test(first);
}

export function normalizeLogoInput(raw: string): string | null {
  const value = raw.trim();
  if (!value || value.length > 2048) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) && !/^https?:\/\//i.test(value)) return null;
  let candidate = value;
  if (candidate.startsWith("//")) candidate = `https:${candidate}`;
  else if (!/^https?:\/\//i.test(candidate) && isHostLike(candidate)) {
    candidate = `https://${candidate}`;
  }
  try {
    const url = new URL(candidate, `${window.location.origin}/`);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    // the site itself is https, so a same-origin http URL becomes https
    if (url.protocol === "http:" && url.host === window.location.host) url.protocol = "https:";
    return url.href;
  } catch {
    return null;
  }
}

/** True when the value is already an absolute https URL the API will accept. */
export function isPublicLogoUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}
