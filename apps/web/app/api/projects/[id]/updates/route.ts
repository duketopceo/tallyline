import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { API_URL, SESSION_COOKIE } from "@/lib/api";
import { WORKSPACE_COOKIE } from "@/lib/session";
import { upstreamFetch } from "@/lib/upstream";

// Same-origin bridge for the project page's status composer: `?draft=1` reads
// the event-log draft, a POST posts an update as the signed-in member.
async function proxy(req: Request, id: string, method: "GET" | "POST") {
  const jar = await cookies();
  const session = jar.get(SESSION_COOKIE)?.value;
  const workspace = jar.get(WORKSPACE_COOKIE)?.value;
  if (!session || !workspace) {
    return NextResponse.json(
      { error: { code: "UNAUTHENTICATED", message: "no session" } },
      { status: 401 },
    );
  }
  const tail = method === "GET" ? "update-draft" : "updates";
  const upstream = await upstreamFetch(
    `${API_URL}/v1/workspaces/${encodeURIComponent(workspace)}/projects/${encodeURIComponent(id)}/${tail}`,
    {
      method,
      headers: {
        "content-type": "application/json",
        cookie: `${SESSION_COOKIE}=${session}`,
      },
      ...(method === "POST" ? { body: await req.text() } : {}),
    },
  );
  const data = (await upstream.json().catch(() => null)) as unknown;
  return NextResponse.json(data, { status: upstream.status });
}

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return proxy(req, (await ctx.params).id, "GET");
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return proxy(req, (await ctx.params).id, "POST");
}
