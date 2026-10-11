import { WorkspaceSettings, type WorkspaceInfo } from "@/components/account/workspace-settings";
import { SettingsTabs } from "@/components/settings-tabs";
import { api, type Me } from "@/lib/api";

export default async function WorkspaceSettingsPage() {
  const me = await api<Me>("/v1/auth/me");
  if (!me.data) return <main className="p-8 text-sm text-ink-subtle">Not signed in.</main>;
  const slug = me.data.workspaceSlug;
  const role = me.data.memberships.find((m) => m.workspaceSlug === slug)?.role ?? "member";
  const ws = await api<WorkspaceInfo>(`/v1/workspaces/${slug}`);
  return (
    <main className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-lining-faint px-4">
        <h1 className="text-sm font-semibold">Workspace</h1>
        <SettingsTabs />
      </header>
      {ws.data ? (
        <WorkspaceSettings ws={ws.data} role={role} />
      ) : (
        <p className="p-4 text-sm text-ink-subtle">This workspace could not be loaded. Reload the page.</p>
      )}
    </main>
  );
}
