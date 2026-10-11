import { FilterBar } from "@/components/app/filter-bar";
import { PageHeader } from "@/components/app/page-header";
import { IssueListClient, type ListIssue } from "@/components/issue-list-client";
import { ErrorState } from "@/components/primitives";
import { api, type Me } from "@/lib/api";
import { apiQuery, parseFilters } from "@/lib/filters";

export default async function AllIssuesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const filters = parseFilters(await searchParams);
  const me = await api<Me>("/v1/auth/me");
  if (!me.data) return <main className="p-8 text-sm text-ink-subtle">Not signed in.</main>;
  const res = await api<{ issues?: ListIssue[]; nextCursor?: string | null }>(
    `/v1/workspaces/${me.data.workspaceSlug}/issues?${apiQuery(filters, me.data.userId)}`,
  );
  if (!res.ok) {
    return (
      <main className="flex min-h-0 flex-1 flex-col">
        <PageHeader title="Issues" />
        <div className="p-4">
          <ErrorState title="Issues did not load" detail="The API did not answer. Your issues are unchanged." actionLabel="Retry" actionHref="/issues" />
        </div>
      </main>
    );
  }
  const rows = res.data?.issues ?? [];
  return (
    <main className="flex min-h-0 flex-1 flex-col">
      <FilterBar title="Issues" count={rows.length} hint={res.data?.nextCursor ? "loaded" : ""} />
      <IssueListClient issues={rows} nextCursor={res.data?.nextCursor ?? null} />
    </main>
  );
}
