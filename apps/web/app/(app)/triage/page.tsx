import { PageHeader } from "@/components/app/page-header";
import { IssueListClient, type ListIssue } from "@/components/issue-list-client";
import { EmptyState, ErrorState } from "@/components/primitives";
import { api, type Me } from "@/lib/api";

export default async function TriagePage() {
  const me = await api<Me>("/v1/auth/me");
  if (!me.data) return <main className="p-8 text-sm text-ink-subtle">Not signed in.</main>;
  const res = await api<{ issues?: ListIssue[] }>(`/v1/workspaces/${me.data.workspaceSlug}/issues?state=triage&limit=200`);
  if (!res.ok) {
    return (
      <main className="flex min-h-0 flex-1 flex-col">
        <PageHeader title="Triage" />
        <div className="p-4"><ErrorState title="Triage did not load" detail="The API did not answer. Nothing was changed." actionLabel="Retry" actionHref="/triage" /></div>
      </main>
    );
  }
  const rows = res.data?.issues ?? [];
  return (
    <main className="flex min-h-0 flex-1 flex-col">
      <PageHeader title="Triage" count={rows.length} hint="incoming" />
      {rows.length === 0 ? (
        <EmptyState title="Triage is clear" detail="New issues from GitHub, Slack, the API and agents land here. Accept them into the backlog or decline them." />
      ) : (
        <IssueListClient issues={rows} mode="triage" />
      )}
    </main>
  );
}
