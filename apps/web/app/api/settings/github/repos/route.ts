import { NextResponse } from "next/server";
import { proxy } from "@/lib/proxy";

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as {
    fullName?: string;
    action?: string;
    teamKey?: string;
    projectId?: string | null;
  } | null;
  const action = body?.action ?? "connect";
  if (
    !body?.fullName ||
    (action !== "connect" && action !== "disconnect" && action !== "project")
  ) {
    return NextResponse.json(
      {
        error: {
          code: "BAD_REQUEST",
          message: "expected {fullName, action: 'connect'|'disconnect'|'project'}",
        },
      },
      { status: 400 },
    );
  }
  // rebuild the upstream body — the client's `action` discriminator is not
  // part of the API schema
  const upstream = new Request(req.url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(
      action === "connect"
        ? { fullName: body.fullName, teamKey: body.teamKey }
        : action === "project"
          ? { fullName: body.fullName, projectId: body.projectId ?? null }
          : { fullName: body.fullName },
    ),
  });
  return proxy(upstream, `/github/repos/${action}`);
}
