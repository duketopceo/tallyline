import { publicPost } from "@/lib/public-proxy";

export function POST(req: Request) {
  return publicPost(req, "/v1/auth/password/reset");
}
