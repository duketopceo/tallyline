import { proxy } from "@/lib/proxy";

type Ctx = { params: Promise<{ id: string; issueId: string }> };

export async function POST(req: Request, ctx: Ctx) {
  const { id, issueId } = await ctx.params;
  return proxy(
    req,
    `/projects/${encodeURIComponent(id)}/glitchtip/issues/${encodeURIComponent(issueId)}/ticket`,
  );
}
