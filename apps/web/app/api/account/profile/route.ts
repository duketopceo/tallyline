import { proxy } from "@/lib/proxy";

// name + avatar for Settings > Account
export function PATCH(req: Request) {
  return proxy(req, "/v1/me", { workspace: false });
}
