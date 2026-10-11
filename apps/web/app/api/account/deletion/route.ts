import { cookies } from "next/headers";
import { SESSION_COOKIE } from "@/lib/api";
import { proxy } from "@/lib/proxy";
import { WORKSPACE_COOKIE } from "@/lib/session";

export async function POST(req: Request) {
  const res = await proxy(req, "/v1/me/deletion", { workspace: false });
  if (res.ok) {
    // the account is gone: drop the web-side session too
    const jar = await cookies();
    jar.delete(SESSION_COOKIE);
    jar.delete(WORKSPACE_COOKIE);
  }
  return res;
}
