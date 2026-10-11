import { proxy } from "@/lib/proxy";

export const GET = (req: Request) => proxy(req, "/views");
export const POST = (req: Request) => proxy(req, "/views");
