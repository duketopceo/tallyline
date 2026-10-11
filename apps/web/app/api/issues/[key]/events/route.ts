import { proxy } from "@/lib/proxy";

export async function GET(req: Request, { params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  return proxy(req, `/issues/${encodeURIComponent(key)}/events`);
}
