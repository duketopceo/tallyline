import Link from "next/link";
import { api, type Me } from "@/lib/api";
import { AgentsPanel } from "@/components/settings/agents-panel";
import { PageHeader } from "@/components/settings/ui";

export default async function AgentsPage() {
  const me = await api<Me>("/v1/auth/me");
  if (!me.data) return <main className="p-8 text-sm text-ink-subtle">Not signed in.</main>;
  const role = me.data.memberships.find(
    (m) => m.workspaceSlug === me.data!.workspaceSlug,
  )?.role;
  return (
    <main className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <PageHeader title="Agents and keys" meta={me.data.workspaceSlug} />
      <p className="px-6 pt-4 text-sm text-ink-subtle">
        Using Claude Code, Codex, Cursor or opencode?{" "}
        <Link href="/settings/agents/connect" className="text-accent underline underline-offset-2 hover:text-accent-hover">
          Connect it in one step
        </Link>
        , no key needed.
      </p>
      <AgentsPanel canAdmin={role === "owner" || role === "admin"} />
    </main>
  );
}
