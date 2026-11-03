import { proxy } from "@/lib/proxy";

export function POST(req: Request) {
  return proxy(req, "/workspaces", { workspace: false });
}
