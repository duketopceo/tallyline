import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { API_URL, SESSION_COOKIE } from "@/lib/api";
import { invalidateMeta } from "@/lib/meta";
import { WORKSPACE_COOKIE } from "@/lib/session";
import { upstreamFetch } from "@/lib/upstream";

async function proxy(
  req: Request,
  id: string,
  method: "PATCH" | "DELETE",
) {
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
    `${API_URL}/v1/workspaces/${encodeURIComponent(workspace)}/projects/${encodeURIComponent(id)}`,
    {
      method,
      headers: {
        "content-type": "application/json",
        cookie: `${SESSION_COOKIE}=${session}`,
      },
      ...(method === "PATCH" ? { body: await req.text() } : {}),
    },
  );
  // the sidebar and its project switcher read the cached workspace meta
  if (upstream.ok) invalidateMeta(session);
  const data = (await upstream.json().catch(() => null)) as unknown;
  return NextResponse.json(data, { status: upstream.status });
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return proxy(req, (await params).id, "PATCH");
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return proxy(req, (await params).id, "DELETE");
}
