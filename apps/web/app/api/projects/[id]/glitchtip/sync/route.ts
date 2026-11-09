import { proxy } from "@/lib/proxy";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  return proxy(req, `/projects/${encodeURIComponent(id)}/glitchtip/sync`);
}
