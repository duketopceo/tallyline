import { proxy } from "@/lib/proxy";

// disconnect one linked sign-in method (the API refuses the last one)
export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return proxy(req, `/v1/me/identities/${encodeURIComponent(id)}`, { workspace: false });
}
