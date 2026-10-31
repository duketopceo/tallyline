import { proxy } from "@/lib/proxy";

export async function DELETE(req: Request, { params }: { params: Promise<{ key: string; rid: string }> }) {
  const { key, rid } = await params;
  return proxy(req, `/issues/${encodeURIComponent(key)}/relations/${encodeURIComponent(rid)}`);
}
