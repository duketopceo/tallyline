import { cookies } from "next/headers";
import { upstreamFetch } from "@/lib/upstream";

export const API_URL =
  process.env.API_INTERNAL_URL ??
  process.env.NEXT_PUBLIC_API_URL ??
  "http://localhost:4000";

export const SESSION_COOKIE = "tly_session";

export async function api<T>(
  path: string,
  init?: RequestInit,
): Promise<{ ok: boolean; status: number; data: T | null }> {
  const jar = await cookies();
  const session = jar.get(SESSION_COOKIE)?.value;
  const res = await upstreamFetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(session ? { cookie: `${SESSION_COOKIE}=${session}` } : {}),
      ...init?.headers,
    },
    cache: "no-store",
  });
  const data = (await res.json().catch(() => null)) as T | null;
  // error envelopes ({error:{…}}) must never reach callers as truthy data —
  // a truthy-but-error payload renders a broken shell (zero-membership
  // bounce depends on this)
  return { ok: res.ok, status: res.status, data: res.ok ? data : null };
}

// browser-reachable API origin — NEXT_PUBLIC_API_URL, never the docker
// hostname API_INTERNAL_URL resolves to on compose
export const PUBLIC_API_URL =
  process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export interface Me {
  userId: string;
  workspaceSlug: string;
  name: string;
  email: string;
  emailVerified?: boolean;
  memberships: {
    workspaceId: string;
    workspaceSlug: string;
    workspaceName?: string;
    role: string;
    deletedAt?: string | null;
    purgeAfter?: string | null;
  }[];
  activeWorkspaceSlug: string;
  isInstanceAdmin: boolean;
}
