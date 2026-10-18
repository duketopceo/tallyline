import { proxy } from "@/lib/proxy";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  return proxy(req, `/agents/${encodeURIComponent(id)}/keys`);
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  return proxy(req, `/agents/${encodeURIComponent(id)}/keys`);
}
