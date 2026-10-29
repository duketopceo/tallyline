import { NextResponse } from "next/server";
import { CODE_RE, SLUG_RE } from "@/lib/device-code";
import { proxy } from "@/lib/proxy";

// browser -> web -> API bridge for the CLI device approval page. The
// workspace is the one the person picked on the page (not the active one), so
// it is validated here before it becomes part of an upstream path.
function target(ws: string, code: string): string | null {
  if (!SLUG_RE.test(ws) || !CODE_RE.test(code)) return null;
  return `/v1/workspaces/${ws}/device/${encodeURIComponent(code)}`;
}

const bad = () =>
  NextResponse.json(
    { error: { code: "NOT_FOUND", message: "that code is not valid" } },
    { status: 404, headers: { "cache-control": "no-store" } },
  );

type Ctx = { params: Promise<{ ws: string; code: string }> };

export async function GET(req: Request, ctx: Ctx) {
  const { ws, code } = await ctx.params;
  const path = target(ws, code);
  return path ? proxy(req, path, { workspace: false }) : bad();
}

export async function POST(req: Request, ctx: Ctx) {
  const { ws, code } = await ctx.params;
  const path = target(ws, code);
  return path ? proxy(req, path, { workspace: false }) : bad();
}
