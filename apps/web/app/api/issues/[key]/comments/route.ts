import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { API_URL, SESSION_COOKIE } from "@/lib/api";
import { WORKSPACE_COOKIE } from "@/lib/session";
import { upstreamFetch } from "@/lib/upstream";

// read the thread (helpdesk detail, plan 2026-11-03 U6): comments in order
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ key: string }> },
) {
  const { key } = await params;
  const jar = await cookies();
  const session = jar.get(SESSION_COOKIE)?.value;
  const workspace = jar.get(WORKSPACE_COOKIE)?.value;
  if (!session || !workspace) {
    return NextResponse.json(
      { error: { code: "UNAUTHENTICATED", message: "no session" } },
      { status: 401 },
    );
  }
  const upstream = await upstreamFetch(
    `${API_URL}/v1/workspaces/${workspace}/issues/${encodeURIComponent(key)}/comments`,
    {
      headers: { cookie: `${SESSION_COOKIE}=${session}` },
      cache: "no-store",
    },
  );
  const data = (await upstream.json().catch(() => null)) as unknown;
  return NextResponse.json(data, { status: upstream.status });
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ key: string }> },
) {
  const { key } = await params;
  const jar = await cookies();
  const session = jar.get(SESSION_COOKIE)?.value;
  const workspace = jar.get(WORKSPACE_COOKIE)?.value;
  if (!session || !workspace) {
    return NextResponse.json(
      { error: { code: "UNAUTHENTICATED", message: "no session" } },
      { status: 401 },
    );
  }
  const upstream = await upstreamFetch(
    `${API_URL}/v1/workspaces/${workspace}/issues/${key}/comments`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: `${SESSION_COOKIE}=${session}`,
      },
      body: await req.text(),
    },
  );
  const data = (await upstream.json().catch(() => null)) as unknown;
  return NextResponse.json(data, { status: upstream.status });
}
