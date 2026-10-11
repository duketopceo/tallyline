import { downloadPassthrough } from "@/lib/public-proxy";

export function GET() {
  return downloadPassthrough("/v1/me/export", { workspace: false });
}
