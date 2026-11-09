import { proxy } from "@/lib/proxy";
import { setWorkspaceCookie } from "@/lib/session";

// rename the active workspace; a new slug moves every URL, so the tly_ws
// cookie follows it (the API already proved the caller is an owner)
export async function PATCH(req: Request) {
  const res = await proxy(req, "");
  if (res.ok) {
    const ws = (await res.clone().json().catch(() => null)) as { slug?: string } | null;
    if (ws?.slug) await setWorkspaceCookie(ws.slug, req);
  }
  return res;
}
