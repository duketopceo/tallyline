import { CycleBar, type CycleOption, type TeamOption } from "@/components/cycle-bar";
import { IssueListClient, type IssueGroup, type ListIssue } from "@/components/issue-list-client";
import { EmptyState, ErrorState } from "@/components/primitives";
import { PageHeader } from "@/components/app/page-header";
import { api, type Me } from "@/lib/api";
import { STATE_LABEL } from "@/lib/format";

interface Cycle { id: string; name: string | null; number: number; teamId: string; startsAt: string; endsAt: string; isActive: boolean }
interface Team { id: string; key: string; rolloverBehavior: string }
type Row = ListIssue & { estimate?: number | null; createdAt?: string };

const ORDER = ["in_progress", "in_review", "todo", "backlog", "triage", "done", "canceled", "duplicate"] as const;
const DAY = 86_400_000;

export default async function CyclePage({ searchParams }: { searchParams: Promise<{ cycle?: string }> }) {
  const { cycle: cycleParam } = await searchParams;
  const me = await api<Me>("/v1/auth/me");
  if (!me.data) return <main className="p-8 text-sm text-ink-subtle">Not signed in.</main>;
  const slug = me.data.workspaceSlug;
  const [cyclesRes, teamsRes] = await Promise.all([
    api<{ cycles?: Cycle[] }>(`/v1/workspaces/${slug}/cycles`),
    api<{ teams?: Team[] }>(`/v1/workspaces/${slug}/teams`),
  ]);
  if (!cyclesRes.ok) {
    return (
      <main className="flex min-h-0 flex-1 flex-col">
        <PageHeader title="Cycles" />
        <div className="p-4"><ErrorState title="Cycles did not load" detail="The API did not answer. Nothing was changed." actionLabel="Retry" actionHref="/cycle" /></div>
      </main>
    );
  }
  const all = cyclesRes.data?.cycles ?? [];
  const teams = teamsRes.data?.teams ?? [];
  const teamKey = new Map(teams.map((t) => [t.id, t.key]));
  const options: CycleOption[] = all.map((c) => ({ id: c.id, number: c.number, name: c.name, teamKey: teamKey.get(c.teamId) ?? "?", startsAt: c.startsAt, endsAt: c.endsAt, isActive: c.isActive }));
  const teamOptions: TeamOption[] = teams.map((t) => ({ key: t.key, rolloverBehavior: t.rolloverBehavior }));
  const selectedRaw = (cycleParam ? all.find((c) => c.id === cycleParam) : null) ?? all.find((c) => c.isActive) ?? null;
  const selected = selectedRaw ? options.find((o) => o.id === selectedRaw.id)! : null;

  const issuesRes = selected ? await api<{ issues?: Row[] }>(`/v1/workspaces/${slug}/issues?cycle=${selected.id}&limit=200`) : null;
  const rows = issuesRes?.data?.issues ?? [];

  const now = Date.now();
  const started = selected ? new Date(selected.startsAt).getTime() : 0;
  const ends = selected ? new Date(selected.endsAt).getTime() : 0;
  const status = selected ? (now < started ? "upcoming" : now > ends ? "completed" : "active") : null;
  const daysLabel = selected ? (status === "upcoming" ? `starts in ${Math.ceil((started - now) / DAY)}d` : status === "completed" ? `ended ${Math.floor((now - ends) / DAY)}d ago` : `${Math.max(0, Math.ceil((ends - now) / DAY))}d left`) : "";

  const done = rows.filter((i) => i.state === "done").length;
  const scope = rows.filter((i) => !["canceled", "duplicate"].includes(i.state));
  const open = rows.filter((i) => !["done", "canceled", "duplicate"].includes(i.state));
  const pts = (l: Row[]) => l.reduce((s, i) => s + (i.estimate ?? 0), 0);
  const addedAfterStart = rows.filter((i) => i.createdAt && new Date(i.createdAt).getTime() > started + 3_600_000).length;
  const pct = scope.length ? Math.round((done / scope.length) * 100) : 0;
  const team = selectedRaw ? teams.find((t) => t.id === selectedRaw.teamId) : undefined;
  const next = selectedRaw ? all.filter((c) => c.teamId === selectedRaw.teamId && c.number > selectedRaw.number).sort((a, b) => a.number - b.number)[0] : undefined;
  const rolloverTo = team?.rolloverBehavior === "backlog" || !next ? "the backlog" : `Cycle ${next.number}`;

  const groups: IssueGroup[] = ORDER.map((s) => ({ key: s, label: STATE_LABEL[s]!, issues: rows.filter((i) => i.state === s) })).filter((g) => g.issues.length > 0);
  const active = all.filter((c) => c.isActive);

  return (
    <main className="flex min-h-0 flex-1 flex-col">
      <CycleBar cycles={options} teams={teamOptions} selected={selected} status={status} daysLabel={daysLabel} carryOver={open.length} rolloverTo={rolloverTo} />
      {!selected ? (
        <EmptyState title="No active cycle" detail="Create a cycle and make it active. Unfinished work rolls into the next cycle or the backlog, per the team's rollover setting." />
      ) : (
        <>
          <section aria-label="Cycle summary" className="grid shrink-0 grid-cols-2 gap-x-6 gap-y-3 border-b border-lining-faint px-4 py-3 md:grid-cols-4">
            <div className="col-span-2 md:col-span-1">
              <p className="text-[12px] text-ink-subtle">Progress</p>
              <p className="mt-1 text-[15px] font-semibold tabular-nums text-ink">{done} of {scope.length} done · {pct}%</p>
              <div role="progressbar" aria-label="Cycle progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} className="mt-2 h-1 w-full overflow-hidden rounded-full bg-surface-3"><div className="h-full rounded-full bg-healthy" style={{ width: `${pct}%` }} /></div>
            </div>
            <div><p className="text-[12px] text-ink-subtle">Points</p><p className="mt-1 text-[15px] font-semibold tabular-nums text-ink">{pts(rows.filter((i) => i.state === "done"))} of {pts(scope)}</p></div>
            <div><p className="text-[12px] text-ink-subtle">Scope added after start</p><p className="mt-1 text-[15px] font-semibold tabular-nums text-ink">{addedAfterStart}</p></div>
            <div><p className="text-[12px] text-ink-subtle">Rolls over on completion</p><p className="mt-1 text-[15px] font-semibold tabular-nums text-ink">{open.length}<span className="ml-1 text-[12px] font-normal text-ink-subtle">to {rolloverTo}</span></p></div>
          </section>
          {active.length > 1 && !cycleParam && <p className="shrink-0 border-b border-lining-faint px-4 py-1.5 text-[12px] text-ink-subtle">Also active: {active.slice(1).map((c) => `${teamKey.get(c.teamId)} Cycle ${c.number}`).join(", ")}. Use the switcher to view them.</p>}
          {rows.length === 0 ? (
            <EmptyState title="No issues in this cycle" detail="Assign issues from a list or an issue's properties panel (cycle)." />
          ) : (
            <IssueListClient issues={groups.flatMap((g) => g.issues)} groups={groups} />
          )}
        </>
      )}
    </main>
  );
}
