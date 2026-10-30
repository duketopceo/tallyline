import { proxy } from "@/lib/proxy";

// Same-origin bridge for the project page's status composer: GET reads the
// event-log draft, POST posts an update as the signed-in member.
type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  return proxy(req, `/projects/${encodeURIComponent(id)}/update-draft`);
}

export async function POST(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  return proxy(req, `/projects/${encodeURIComponent(id)}/updates`);
}
