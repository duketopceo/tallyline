import { proxy } from "@/lib/proxy";

// S3-U4b: a drafted PR description; nothing is posted
export async function POST(req: Request, { params }: { params: Promise<{ key: string }> }) {
  return proxy(req, `/issues/${encodeURIComponent((await params).key)}/pr-brief`);
}
