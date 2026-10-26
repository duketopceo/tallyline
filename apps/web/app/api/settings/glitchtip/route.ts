import { proxy } from "@/lib/proxy";

export function GET(req: Request) {
  return proxy(req, "/glitchtip");
}

export function PUT(req: Request) {
  return proxy(req, "/glitchtip");
}

export function DELETE(req: Request) {
  return proxy(req, "/glitchtip");
}
