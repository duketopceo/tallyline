import { proxy } from "@/lib/proxy";

// change password while signed in (Settings > Account)
export function POST(req: Request) {
  return proxy(req, "/v1/me/password", { workspace: false });
}
