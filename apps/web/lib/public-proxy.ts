import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { API_URL, SESSION_COOKIE } from "@/lib/api";
import { WORKSPACE_COOKIE } from "@/lib/session";
import { upstreamFetch } from "@/lib/upstream";

// Bridges for the account-lifecycle flows.

/** unauthenticated POST to a fixed /v1/auth path (reset, verify) */
export async function publicPost(req: Request, upstreamPath: string): Promise<NextResponse> {
  const upstream = await upstreamFetch(`${API_URL}${upstreamPath}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: await req.text(),
  });
  const data = (await upstream.json().catch(() => null)) as unknown;
  return NextResponse.json(data, { status: upstream.status });
}

/**
 * Streams a JSON export download straight through (never buffered in the
 * web tier). `workspace` prefixes the active workspace path.
 */
export async function downloadPassthrough(
  upstreamPath: string,
  opts: { workspace: boolean },
): Promise<Response> {
  const jar = await cookies();
  const session = jar.get(SESSION_COOKIE)?.value;
  if (!session) {
    return NextResponse.json({ error: { code: "UNAUTHENTICATED", message: "no session" } }, { status: 401 });
  }
  let path = upstreamPath;
  if (opts.workspace) {
    const ws = jar.get(WORKSPACE_COOKIE)?.value;
    if (!ws) {
      return NextResponse.json({ error: { code: "NO_WORKSPACE", message: "no active workspace" } }, { status: 400 });
    }
    path = `/v1/workspaces/${ws}${upstreamPath}`;
  }
  const upstream = await upstreamFetch(`${API_URL}${path}`, {
    headers: { cookie: `${SESSION_COOKIE}=${session}` },
    cache: "no-store",
  });
  const headers = new Headers({ "cache-control": "no-store" });
  for (const h of ["content-type", "content-disposition"]) {
    const v = upstream.headers.get(h);
    if (v) headers.set(h, v);
  }
  return new Response(upstream.body, { status: upstream.status, headers });
}
