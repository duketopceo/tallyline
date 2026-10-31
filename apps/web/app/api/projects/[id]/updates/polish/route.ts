import { proxy } from "@/lib/proxy";

// S3-U4b: the facts draft reworded by the workspace's AI provider; nothing is posted
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return proxy(req, `/projects/${encodeURIComponent((await params).id)}/update-draft/polish`);
}
