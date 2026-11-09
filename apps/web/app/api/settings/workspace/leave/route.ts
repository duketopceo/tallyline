import { proxy } from "@/lib/proxy";
import { setWorkspaceCookie } from "@/lib/session";

// leave the active workspace; the session moves to another workspace the
// person belongs to, so the tly_ws cookie follows it
export async function POST(req: Request) {
  const res = await proxy(req, "/leave");
  if (res.ok) {
    const out = (await res.clone().json().catch(() => null)) as { nextWorkspaceSlug?: string } | null;
    if (out?.nextWorkspaceSlug) await setWorkspaceCookie(out.nextWorkspaceSlug, req);
  }
  return res;
}
