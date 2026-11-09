import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { API_URL } from "@/lib/api";
import { redirectTo } from "@/lib/redirect";
import { upstreamFetch } from "@/lib/upstream";
import {
  forwardSessionCookies,
  safeReturnTo,
  setWorkspaceCookie,
} from "@/lib/session";
import { LOGIN_NONCE_COOKIE } from "@/app/api/auth/methods/route";
import { DEFAULT_LANDING } from "@/lib/landing";

interface Exchange {
  purpose: "login" | "pending-bootstrap" | "pending-link";
  returnTo?: string;
  workspaceSlug?: string;
  memberships?: { workspaceSlug: string }[];
  context?: { pendingEmail: string; linkProviderKey: string; linkProviderLabel: string };
}

async function exchange(code: string, loginNonce: string | undefined, bootstrap?: object) {
  return upstreamFetch(`${API_URL}/v1/auth/oauth/exchange`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, login_nonce: loginNonce, bootstrap }),
  });
}

// GET: the OAuth code lands here from the API's provider callback — exchange
// it for a session, replay cookies onto the web origin, branch on purpose.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  if (!code) {
    return redirectTo("/login?error=exchange");
  }
  const jar = await cookies();
  const loginNonce = jar.get(LOGIN_NONCE_COOKIE)?.value;
  const upstream = await exchange(code, loginNonce);
  const data = (await upstream.json().catch(() => null)) as Exchange | null;

  if (upstream.status === 409 && data?.purpose === "pending-link") {
    const provider = data.context?.linkProviderKey ?? "";
    return redirectTo(
      `/link?code=${encodeURIComponent(code)}&provider=${encodeURIComponent(provider)}`,
    );
  }
  if (upstream.ok && data?.purpose === "pending-bootstrap") {
    return redirectTo(`/bootstrap?code=${encodeURIComponent(code)}`);
  }
  if (!upstream.ok || !data || data.purpose !== "login") {
    return redirectTo("/login?error=exchange");
  }

  await forwardSessionCookies(upstream, req, data.workspaceSlug);
  const destination = safeReturnTo(data.returnTo);

  // multi-membership: the session's bound workspace may not match tly_ws —
  // send the user through the chooser when there's a real choice to make
  const memberships = data.memberships ?? [];
  if (memberships.length > 1 && destination === DEFAULT_LANDING) {
    return redirectTo("/workspaces");
  }
  return redirectTo(destination);
}

// POST: pending-bootstrap completion — the bootstrap page collected
// workspace/team names; finish the exchange and return where to land.
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as {
    code?: string;
    bootstrap?: { workspaceSlug: string; workspaceName: string; teamKey?: string };
  } | null;
  if (!body?.code || !body.bootstrap) {
    return NextResponse.json(
      { error: { code: "BAD_REQUEST", message: "code + bootstrap payload required" } },
      { status: 400 },
    );
  }
  const jar = await cookies();
  const loginNonce = jar.get(LOGIN_NONCE_COOKIE)?.value;
  const upstream = await exchange(body.code, loginNonce, body.bootstrap);
  const data = (await upstream.json().catch(() => null)) as Exchange | null;
  if (!upstream.ok || !data || data.purpose !== "login") {
    const status = upstream.ok ? 502 : upstream.status;
    return NextResponse.json(
      data ?? { error: { code: "EXCHANGE_FAILED", message: "bootstrap exchange failed" } },
      { status },
    );
  }
  await forwardSessionCookies(upstream, req, data.workspaceSlug);
  if (data.workspaceSlug) await setWorkspaceCookie(data.workspaceSlug, req);
  return NextResponse.json({ ok: true, returnTo: safeReturnTo(data.returnTo) });
}
