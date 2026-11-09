import { proxy } from "@/lib/proxy";

// Same-origin bridge for the project page's error panel: read the cached
// health, map the project to a GlitchTip project, or remove the mapping.
type Ctx = { params: Promise<{ id: string }> };

async function upstream(ctx: Ctx) {
  const { id } = await ctx.params;
  return `/projects/${encodeURIComponent(id)}/glitchtip`;
}

export async function GET(req: Request, ctx: Ctx) {
  return proxy(req, await upstream(ctx));
}

export async function PUT(req: Request, ctx: Ctx) {
  return proxy(req, await upstream(ctx));
}

export async function DELETE(req: Request, ctx: Ctx) {
  return proxy(req, await upstream(ctx));
}
