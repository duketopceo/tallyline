import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { API_URL, SESSION_COOKIE } from "@/lib/api";
import { WORKSPACE_COOKIE } from "@/lib/session";
import { invalidateMeta } from "@/lib/meta";
import { upstreamFetch } from "@/lib/upstream";

export async function POST(req: Request) {
  const jar = await cookies();
  const session = jar.get(SESSION_COOKIE)?.value;
  const workspace = jar.get(WORKSPACE_COOKIE)?.value;
  if (!session || !workspace) {
    return NextResponse.json(
      { error: { code: "UNAUTHENTICATED", message: "no session" } },
      { status: 401 },
    );
  }
  const upstream = await upstreamFetch(`${API_URL}/v1/workspaces/${workspace}/issues`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: `${SESSION_COOKIE}=${session}`,
    },
    body: await req.text(),
  });
  const data = (await upstream.json().catch(() => null)) as unknown;
  // sidebar counts (triage, review) are cached briefly; a write makes them stale
  invalidateMeta(session);
  return NextResponse.json(data, { status: upstream.status });
}

// list passthrough for "load more" pagination (query string forwarded as-is)
export async function GET(req: Request) {
  const jar = await cookies();
  const session = jar.get(SESSION_COOKIE)?.value;
  const workspace = jar.get(WORKSPACE_COOKIE)?.value;
  if (!session || !workspace) {
    return NextResponse.json(
      { error: { code: "UNAUTHENTICATED", message: "no session" } },
      { status: 401 },
    );
  }
  const qs = new URL(req.url).search;
  const upstream = await upstreamFetch(`${API_URL}/v1/workspaces/${workspace}/issues${qs}`, {
    headers: { cookie: `${SESSION_COOKIE}=${session}` },
    cache: "no-store",
  });
  const data = (await upstream.json().catch(() => null)) as unknown;
  return NextResponse.json(data, { status: upstream.status });
}
