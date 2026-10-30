import { api, type Me } from "@/lib/api";
import { AiProviderPanel } from "@/components/settings/ai-provider-panel";
import { PageHeader } from "@/components/settings/ui";

export default async function AiSettingsPage() {
  const me = await api<Me>("/v1/auth/me");
  if (!me.data) return <main className="p-8 text-sm text-ink-subtle">Not signed in.</main>;
  const role = me.data.memberships.find((m) => m.workspaceSlug === me.data!.workspaceSlug)?.role;
  const canAdmin = role === "owner" || role === "admin";
  return (
    <main className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <PageHeader title="AI" meta={me.data.workspaceSlug} />
      {canAdmin ? (
        <AiProviderPanel />
      ) : (
        <p className="p-4 text-sm text-ink-subtle">
          Only an owner or admin can see or change the workspace&apos;s AI provider.
        </p>
      )}
    </main>
  );
}
