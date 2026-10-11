import { proxy } from "@/lib/proxy";

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return proxy(req, `/views/${encodeURIComponent(id)}`);
}
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return proxy(req, `/views/${encodeURIComponent(id)}`);
}
