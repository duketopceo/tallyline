import { proxy } from "@/lib/proxy";

// Same-origin bridges for Settings > AI. The API key only ever travels
// browser -> here -> API on PUT; no response carries it back.
export function GET(req: Request) {
  return proxy(req, "/ai/provider");
}

export function PUT(req: Request) {
  return proxy(req, "/ai/provider");
}

export function DELETE(req: Request) {
  return proxy(req, "/ai/provider");
}
