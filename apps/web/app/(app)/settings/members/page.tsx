import { api, type Me } from "@/lib/api";
import { MemberList, type MemberRow } from "@/components/member-list";
import { SettingsHeader } from "@/components/settings/settings-header";

interface MembersResponse {
  members?: MemberRow[];
}

export default async function MembersPage() {
  const me = await api<Me>("/v1/auth/me");
  if (!me.data) return <main className="p-8 text-sm text-ink-subtle">Not signed in.</main>;
  const role = me.data.memberships.find(
    (m) => m.workspaceSlug === me.data!.workspaceSlug,
  )?.role;
  const res = await api<MembersResponse>(
    `/v1/workspaces/${me.data.workspaceSlug}/members`,
  );
  const rows = res.data?.members ?? [];

  return (
    <main className="flex min-h-0 flex-1 flex-col">
      <SettingsHeader
        title="Members"
        actions={
          <>
            <span className="font-mono text-[11px] text-ink-tertiary">
              {rows.length} on this workspace
            </span>
          </>
        }
      />
      {res.ok ? (
        // non-admin members still read the roster (R19) — the list hides
        // role/remove controls without the admin role
        <MemberList
          members={rows}
          canAdmin={role === "owner" || role === "admin"}
          selfId={me.data.userId}
        />
      ) : (
        <p className="p-4 text-sm text-ink-subtle">Requires admin access.</p>
      )}
    </main>
  );
}
