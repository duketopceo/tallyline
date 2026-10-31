import { proxy } from "@/lib/proxy";

// a person's reply to an agent goes in as a `prompt` activity (the API
// refuses any other type from a human session)
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return proxy(req, `/agent-sessions/${encodeURIComponent((await params).id)}/activities`);
}
