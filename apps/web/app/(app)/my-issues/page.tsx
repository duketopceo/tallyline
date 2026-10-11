import { PageHeader } from "@/components/app/page-header";
import { IssueListClient, type IssueGroup, type ListIssue } from "@/components/issue-list-client";
import { EmptyState, ErrorState } from "@/components/primitives";
import { api, type Me } from "@/lib/api";

const RANK: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3, none: 4 };
const byPriority = (a: ListIssue, b: ListIssue) => (RANK[a.priority] ?? 4) - (RANK[b.priority] ?? 4);
const ACTIVE = "todo,in_progress,in_review";

export default async function MyIssuesPage() {
  const me = await api<Me>("/v1/auth/me");
  if (!me.data) return <main className="p-8 text-sm text-ink-subtle">Not signed in.</main>;
  const base = `/v1/workspaces/${me.data.workspaceSlug}/issues`;
  const [mine, active] = await Promise.all([
    api<{ issues?: ListIssue[] }>(`${base}?assignee=${me.data.userId}&state=${ACTIVE}&limit=100`),
    api<{ issues?: ListIssue[] }>(`${base}?state=${ACTIVE}&limit=200`),
  ]);
  if (!mine.ok) {
    return (
      <main className="flex min-h-0 flex-1 flex-col">
        <PageHeader title="My issues" />
        <div className="p-4"><ErrorState title="Your issues did not load" detail="The API did not answer. Nothing was changed." actionLabel="Retry" actionHref="/my-issues" /></div>
      </main>
    );
  }
  const mineRows = mine.data?.issues ?? [];
  const have = new Set(mineRows.map((i) => i.key));
  // work I handed to agents: created by me, assigned to an agent, still active
  const delegated = (active.data?.issues ?? []).filter((i) => i.creatorId === me.data!.userId && i.assigneeType === "agent" && !have.has(i.key));
  const groups: IssueGroup[] = [
    { key: "in_review", label: "In review", issues: mineRows.filter((i) => i.state === "in_review").sort(byPriority) },
    { key: "in_progress", label: "In progress", issues: mineRows.filter((i) => i.state === "in_progress").sort(byPriority) },
    { key: "todo", label: "Todo", issues: mineRows.filter((i) => i.state === "todo").sort(byPriority) },
    { key: "delegated", label: "Delegated to agents", issues: delegated.sort(byPriority) },
  ].filter((g) => g.issues.length > 0);
  const total = mineRows.length + delegated.length;

  return (
    <main className="flex min-h-0 flex-1 flex-col">
      <PageHeader title="My issues" count={total} hint="active" />
      {total === 0 ? (
        <EmptyState title="Nothing assigned to you" detail={<>Active issues assigned to you, and work you handed to agents, appear here. Press <kbd className="rounded-xs border border-lining px-1 font-mono text-[11px]">c</kbd> to create one, or pull from the backlog.</>} />
      ) : (
        <IssueListClient issues={groups.flatMap((g) => g.issues)} groups={groups} />
      )}
    </main>
  );
}
