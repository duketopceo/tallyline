import { proxy } from "@/lib/proxy";

export function GET(req: Request) {
  return proxy(req, "/v1/dev/mail", { workspace: false });
}
