export const SECRET_TTL_MS = 5 * 60_000;

interface VisibilityDoc {
  hidden: boolean;
  addEventListener(type: "visibilitychange", fn: () => void): void;
  removeEventListener(type: "visibilitychange", fn: () => void): void;
}

/**
 * A revealed secret must not linger on screen: drop it after the TTL or as
 * soon as the tab is hidden. Returns the cleanup.
 */
export function armSecretExpiry(doc: VisibilityDoc, expire: () => void): () => void {
  const onVisibility = () => {
    if (doc.hidden) expire();
  };
  const timer = setTimeout(expire, SECRET_TTL_MS);
  doc.addEventListener("visibilitychange", onVisibility);
  return () => {
    clearTimeout(timer);
    doc.removeEventListener("visibilitychange", onVisibility);
  };
}

/** the e2e hook is not shipped in production builds */
export function secretTestId(nodeEnv: string | undefined): string | undefined {
  return nodeEnv === "production" ? undefined : "secret-value";
}
