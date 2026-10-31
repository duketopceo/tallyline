import { proxy } from "@/lib/proxy";

export async function GET(req: Request, { params }: { params: Promise<{ key: string }> }) {
  return proxy(req, `/issues/${encodeURIComponent((await params).key)}/agent-sessions`);
}
