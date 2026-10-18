import { proxy } from "@/lib/proxy";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string; keyId: string }> },
) {
  const { id, keyId } = await params;
  return proxy(
    req,
    `/agents/${encodeURIComponent(id)}/keys/${encodeURIComponent(keyId)}/rotate`,
  );
}
