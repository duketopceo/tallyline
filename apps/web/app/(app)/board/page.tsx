import { FilterBar } from "@/components/app/filter-bar";
import { PageHeader } from "@/components/app/page-header";
import { BoardLoader } from "@/components/board-loader";
import type { ListIssue } from "@/components/issue-list-client";
import { ErrorState } from "@/components/primitives";
import { api, type Me } from "@/lib/api";
import { apiQuery, parseFilters } from "@/lib/filters";

const BOARD_STATES = ["triage", "backlog", "todo", "in_progress", "in_review"];

export default async function BoardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const filters = { ...parseFilters(await searchParams), state: BOARD_STATES };
  const me = await api<Me>("/v1/auth/me");
  if (!me.data) return <main className="p-8 text-sm text-ink-subtle">Not signed in.</main>;
  const res = await api<{ issues?: ListIssue[] }>(`/v1/workspaces/${me.data.workspaceSlug}/issues?${apiQuery(filters, me.data.userId)}`);
  if (!res.ok) {
    return (
      <main className="flex min-h-0 flex-1 flex-col">
        <PageHeader title="Board" />
        <div className="p-4"><ErrorState title="The board did not load" detail="The API did not answer. Your issues are unchanged." actionLabel="Retry" actionHref="/board" /></div>
      </main>
    );
  }
  let rows = res.data?.issues ?? [];
  const a = filters.assignee;
  if (a === "none") rows = rows.filter((i) => !i.assigneeId);
  else if (a === "agent") rows = rows.filter((i) => i.assigneeType === "agent");
  else if (a === "human") rows = rows.filter((i) => i.assigneeType === "human");
  return (
    <main className="flex min-h-0 flex-1 flex-col">
      <FilterBar title="Board" count={rows.length} hint="active" dims={["assignee", "label", "project", "cycle", "team", "source", "priority"]} display={false} />
      <BoardLoader issues={rows} />
    </main>
  );
}
