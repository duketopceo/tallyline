import { SettingsHeader } from "@/components/settings/settings-header";
import { SettingsOverview } from "@/components/settings/settings-overview";
import { getMe } from "@/lib/me";
import { visibleSections } from "@/lib/settings-nav";

export default async function SettingsPage() {
  const me = await getMe();
  if (!me.data) return <main className="p-8 text-sm text-ink-subtle">Not signed in.</main>;
  const active = me.data.memberships.find((m) => m.workspaceSlug === me.data!.workspaceSlug);
  return (
    <main className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <SettingsHeader title="Settings" />
      <SettingsOverview
        name={me.data.name}
        email={me.data.email}
        workspaceName={active?.workspaceName ?? me.data.workspaceSlug}
        isOwner={active?.role === "owner"}
        sections={visibleSections({ isInstanceAdmin: me.data.isInstanceAdmin })}
      />
    </main>
  );
}
