import { proxy } from "@/lib/proxy";

// linked sign-in methods for Settings > Account
export function GET(req: Request) {
  return proxy(req, "/v1/me/identities", { workspace: false });
}
