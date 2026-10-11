import { proxy } from "@/lib/proxy";

// resend the confirmation link
export function POST(req: Request) {
  return proxy(req, "/v1/me/verify-email/resend", { workspace: false });
}
