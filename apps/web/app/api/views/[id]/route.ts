import { cookies } from "next/headers";
import { SESSION_COOKIE } from "@/lib/api";
import { invalidateMeta } from "@/lib/meta";
import { proxy } from "@/lib/proxy";

async function forward(req: Request, params: Promise<{ id: string }>) {
  const { id } = await params;
  const res = await proxy(req, `/views/${encodeURIComponent(id)}`);
  invalidateMeta((await cookies()).get(SESSION_COOKIE)?.value);
  return res;
}
export const PATCH = (req: Request, { params }: { params: Promise<{ id: string }> }) => forward(req, params);
export const DELETE = (req: Request, { params }: { params: Promise<{ id: string }> }) => forward(req, params);
