import { cookies } from "next/headers";
import { type NextRequest, NextResponse } from "next/server";
import { API_URL, SESSION_COOKIE } from "@/lib/api";
import { WORKSPACE_COOKIE } from "@/lib/session";
import { upstreamFetch } from "@/lib/upstream";

export const dynamic = "force-dynamic";

// Roadmap pulse refresh: same session, same workspace, `?since=` passed through.
export async function GET(req: NextRequest) {
  const jar = await cookies();
  const session = jar.get(SESSION_COOKIE)?.value;
  const workspace = jar.get(WORKSPACE_COOKIE)?.value;
  if (!session || !workspace) {
    return NextResponse.json(
      { error: { code: "UNAUTHENTICATED", message: "no session" } },
      { status: 401 },
    );
  }
  const url = new URL(`${API_URL}/v1/workspaces/${encodeURIComponent(workspace)}/roadmap/summary`);
  const since = req.nextUrl.searchParams.get("since");
  if (since) url.searchParams.set("since", since);
  const upstream = await upstreamFetch(url, {
    headers: { cookie: `${SESSION_COOKIE}=${session}` },
    cache: "no-store",
  });
  const data = (await upstream.json().catch(() => undefined)) as unknown;
  if (data === undefined) {
    return NextResponse.json(
      { error: { code: "BAD_UPSTREAM", message: "roadmap summary was not JSON" } },
      { status: 502 },
    );
  }
  return NextResponse.json(data, { status: upstream.status });
}
