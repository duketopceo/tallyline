import { proxy } from "@/lib/proxy";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return proxy(req, `/agent-sessions/${encodeURIComponent((await params).id)}`);
}
