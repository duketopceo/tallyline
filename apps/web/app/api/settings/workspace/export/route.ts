import { downloadPassthrough } from "@/lib/public-proxy";

export function GET() {
  return downloadPassthrough("/export", { workspace: true });
}
