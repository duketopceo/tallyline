import { cookies } from "next/headers";
import { API_URL, SESSION_COOKIE } from "@/lib/api";
import { upstreamFetch } from "@/lib/upstream";
import { DEFAULT_LANDING } from "./landing";

export const WORKSPACE_COOKIE = "tly_ws";

const COOKIE_MAX_AGE = 30 * 24 * 60 * 60;

// `Secure` follows the scheme the request actually arrived over —
// plain-http self-host deploys (LAN, tailnet) must not emit Secure
// cookies or the browser drops them and login silently loops.
export function requestIsHttps(req: Request): boolean {
  if (process.env.NODE_ENV !== "production") return false;
  const proto = req.headers.get("x-forwarded-proto");
  if (proto) return proto === "https";
  try {
    return new URL(req.url).protocol === "https:";
  } catch {
    return true;
  }
}

export async function forwardSessionCookies(
  upstream: Response,
  req: Request,
  workspaceSlug?: string,
): Promise<void> {
  const secure = requestIsHttps(req);
  const setCookie = upstream.headers.get("set-cookie") ?? "";
  const match = setCookie.match(/tly_session=([^;]+)/);
  const jar = await cookies();
  if (match) {
    jar.set(SESSION_COOKIE, match[1]!, {
      httpOnly: true,
      sameSite: "lax",
      secure,
      path: "/",
      maxAge: COOKIE_MAX_AGE,
    });
  }
  let slug = workspaceSlug;
  if (!slug && match) {
    const me = await upstreamFetch(`${API_URL}/v1/auth/me`, {
      headers: { cookie: `${SESSION_COOKIE}=${match[1]}` },
    });
    if (me.ok) {
      slug = ((await me.json()) as { workspaceSlug: string }).workspaceSlug;
    }
  }
  if (slug) {
    jar.set(WORKSPACE_COOKIE, slug, {
      httpOnly: true,
      sameSite: "lax",
      secure,
      path: "/",
      maxAge: COOKIE_MAX_AGE,
    });
  }
}

export async function setWorkspaceCookie(
  slug: string,
  req: Request,
): Promise<void> {
  const jar = await cookies();
  jar.set(WORKSPACE_COOKIE, slug, {
    httpOnly: true,
    sameSite: "lax",
    secure: requestIsHttps(req),
    path: "/",
    maxAge: COOKIE_MAX_AGE,
  });
}

// only `/`-relative paths survive — open-redirect guard for return_to
export function safeReturnTo(v: string | null | undefined): string {
  return v && v.startsWith("/") && !v.startsWith("//") ? v : DEFAULT_LANDING;
}
