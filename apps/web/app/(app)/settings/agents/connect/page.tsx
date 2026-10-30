import Link from "next/link";
import { ConnectAgentSteps } from "@/components/settings/connect-agent-steps";
import { PageHeader } from "@/components/settings/ui";
import { api, PUBLIC_API_URL, type Me } from "@/lib/api";

export default async function ConnectAgentPage() {
  const me = await api<Me>("/v1/auth/me");
  if (!me.data) return <main className="p-8 text-sm text-ink-subtle">Not signed in.</main>;
  return (
    <main className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <PageHeader title="Connect a coding agent" meta={me.data.workspaceSlug} />
      <div className="max-w-3xl space-y-4 p-6">
        <p className="text-sm text-ink-subtle">
          Your agent signs in as you through the browser. It gets read and write access. Reviews stay with
          people. No key is stored in the file.{" "}
          <Link href="/settings/agents" className="text-accent hover:text-accent-hover">
            Back to agents and keys
          </Link>
        </p>
        <ConnectAgentSteps apiUrl={PUBLIC_API_URL} />
      </div>
    </main>
  );
}
