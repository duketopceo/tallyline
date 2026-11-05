import { api, type Me } from "@/lib/api";
import { InvitePanel, type InviteRow, type TeamRow } from "@/components/invite-form";
import { SettingsHeader } from "@/components/settings/settings-header";

interface InvitesResponse { invites?: InviteRow[] }
interface TeamsResponse { teams?: TeamRow[] }

export default async function InvitesPage() {
  const me = await api<Me>("/v1/auth/me");
  if (!me.data) return <main className="p-8 text-sm text-ink-subtle">Not signed in.</main>;
  const role = me.data.memberships.find(
    (m) => m.workspaceSlug === me.data!.workspaceSlug,
  )?.role;
  const canAdmin = role === "owner" || role === "admin";
  if (!canAdmin) {
    return (
      <main className="flex min-h-0 flex-1 flex-col">
        <SettingsHeader title="Invites" />
        <p className="p-4 text-sm text-ink-subtle">Requires admin access.</p>
      </main>
    );
  }
  const [invitesRes, teamsRes] = await Promise.all([
    api<InvitesResponse>(`/v1/workspaces/${me.data.workspaceSlug}/invites`),
    api<TeamsResponse>(`/v1/workspaces/${me.data.workspaceSlug}/teams`),
  ]);
  return (
    <main className="flex min-h-0 flex-1 flex-col">
      <SettingsHeader title="Invites" />
      <InvitePanel
        invites={invitesRes.data?.invites ?? []}
        teams={teamsRes.data?.teams ?? []}
      />
    </main>
  );
}
