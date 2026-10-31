import { proxy } from "@/lib/proxy";

export async function PATCH(req: Request, { params }: { params: Promise<{ key: string; sid: string }> }) {
  const { key, sid } = await params;
  return proxy(req, `/issues/${encodeURIComponent(key)}/suggestions/${encodeURIComponent(sid)}`);
}
