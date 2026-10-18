import { api, type Me } from "@/lib/api";
import { TokensPanel } from "@/components/settings/tokens-panel";
import { PageHeader } from "@/components/settings/ui";

export default async function TokensPage() {
  const me = await api<Me>("/v1/auth/me");
  if (!me.data) return <main className="p-8 text-sm text-ink-subtle">Not signed in.</main>;
  const role = me.data.memberships.find(
    (m) => m.workspaceSlug === me.data!.workspaceSlug,
  )?.role;
  return (
    <main className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <PageHeader title="Personal access tokens" meta={me.data.workspaceSlug} />
      <TokensPanel canAdmin={role === "owner" || role === "admin"} />
    </main>
  );
}
