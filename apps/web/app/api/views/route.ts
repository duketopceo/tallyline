import { cookies } from "next/headers";
import { SESSION_COOKIE } from "@/lib/api";
import { invalidateMeta } from "@/lib/meta";
import { proxy } from "@/lib/proxy";

export const GET = (req: Request) => proxy(req, "/views");
export async function POST(req: Request) {
  const res = await proxy(req, "/views");
  invalidateMeta((await cookies()).get(SESSION_COOKIE)?.value);
  return res;
}
