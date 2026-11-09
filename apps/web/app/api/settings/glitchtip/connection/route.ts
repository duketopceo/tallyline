import { proxy } from "@/lib/proxy";

export function GET(req: Request) {
  return proxy(req, "/glitchtip/connection");
}

export function PUT(req: Request) {
  return proxy(req, "/glitchtip/connection");
}

export function DELETE(req: Request) {
  return proxy(req, "/glitchtip/connection");
}
