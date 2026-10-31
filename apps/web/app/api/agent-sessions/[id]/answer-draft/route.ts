import { proxy } from "@/lib/proxy";

// S3-U4b: a suggested reply to an agent's open question; nothing is posted
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return proxy(req, `/agent-sessions/${encodeURIComponent((await params).id)}/answer-draft`);
}
