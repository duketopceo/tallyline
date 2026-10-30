import { proxy } from "@/lib/proxy";

type Ctx = { params: Promise<{ key: string }> };
const path = async ({ params }: Ctx) => `/issues/${encodeURIComponent((await params).key)}/suggestions`;

export async function GET(req: Request, ctx: Ctx) {
  return proxy(req, await path(ctx));
}

export async function POST(req: Request, ctx: Ctx) {
  return proxy(req, await path(ctx));
}
