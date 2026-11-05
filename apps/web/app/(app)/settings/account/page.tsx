import { AccountSettings } from "@/components/account/account-settings";
import { SettingsHeader } from "@/components/settings/settings-header";
import { api, type Me } from "@/lib/api";

export default async function AccountPage() {
  const me = await api<Me>("/v1/auth/me");
  if (!me.data) return <main className="p-8 text-sm text-ink-subtle">Not signed in.</main>;
  const owned = me.data.memberships
    .filter((m) => m.role === "owner" && !m.deletedAt)
    .map((m) => m.workspaceSlug);
  return (
    <main className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <SettingsHeader title="Account" />
      <AccountSettings
        name={me.data.name}
        email={me.data.email}
        emailVerified={me.data.emailVerified !== false}
        isInstanceAdmin={me.data.isInstanceAdmin}
        ownedWorkspaces={owned}
      />
    </main>
  );
}
