// Opt-in first-party Umami analytics helper.
// Strictly gated on NEXT_PUBLIC_UMAMI_WEBSITE_ID: completely off for self-hosters
// and never sends PII.

export const DEFAULT_UMAMI_SCRIPT_URL = "https://analytics.tallyline.app/script.js";

export interface UmamiConfig {
  websiteId: string;
  scriptUrl: string;
  origin: string | null;
}

export type AnalyticsPropValue = string | number | boolean;
export type AnalyticsProps = Record<string, AnalyticsPropValue>;

const PII_KEY_RE =
  /(email|name|phone|ip|address|token|password|secret|cookie|authorization|user_?id|username)/i;

export function getUmamiConfig(
  env: Record<string, string | undefined> = process.env,
): UmamiConfig | null {
  const websiteId = env.NEXT_PUBLIC_UMAMI_WEBSITE_ID?.trim();
  if (!websiteId) return null;

  const rawScriptUrl = env.NEXT_PUBLIC_UMAMI_SCRIPT_URL?.trim() || DEFAULT_UMAMI_SCRIPT_URL;
  let origin: string | null = null;
  if (rawScriptUrl.startsWith("/")) {
    origin = null;
  } else {
    try {
      const parsed = new URL(rawScriptUrl);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        return null;
      }
      origin = parsed.origin;
    } catch {
      return null;
    }
  }

  return {
    websiteId,
    scriptUrl: rawScriptUrl,
    origin,
  };
}

export function sanitizeAnalyticsProps(props?: AnalyticsProps): AnalyticsProps | undefined {
  if (!props) return undefined;
  const clean: AnalyticsProps = {};
  let hasAny = false;
  for (const [key, value] of Object.entries(props)) {
    if (PII_KEY_RE.test(key)) continue;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      clean[key] = value;
      hasAny = true;
    }
  }
  return hasAny ? clean : undefined;
}

interface UmamiWindow extends Window {
  umami?: {
    track: (event: string, data?: AnalyticsProps) => void;
  };
}

/**
 * Emit a zero-PII first-party Umami custom event.
 * No-op on the server, when Umami is unconfigured, or when the script has not loaded.
 */
export function trackEvent(name: string, props?: AnalyticsProps): void {
  if (typeof window === "undefined") return;
  if (!process.env.NEXT_PUBLIC_UMAMI_WEBSITE_ID?.trim()) return;
  const umami = (window as UmamiWindow).umami;
  if (!umami || typeof umami.track !== "function") return;
  const clean = sanitizeAnalyticsProps(props);
  if (clean) {
    umami.track(name, clean);
  } else {
    umami.track(name);
  }
}
