import type { IssueState } from "@tallyline/types";
import {
  CycleManager,
  type ManagerCycle,
  type ManagerTeam,
} from "@/components/cycle-manager";
import {
  IssueListClient,
  type IssueGroup,
  type ListIssue,
} from "@/components/issue-list-client";
import { api } from "@/lib/api";
import { TallyMark } from "@/components/tally-mark";

interface Me {
  workspaceSlug: string;
}

interface Cycle {
  id: string;
  name: string | null;
  number: number;
  teamId: string;
  startsAt: string;
  endsAt: string;
  isActive: boolean;
}

interface Team {
  id: string;
  key: string;
  rolloverBehavior: string;
}

interface IssueRow extends ListIssue {
  cycleId: string | null;
}

// display order for state groups — active work first, terminal last
const STATE_ORDER: IssueState[] = [
  "in_progress",
  "in_review",
  "todo",
  "backlog",
  "triage",
  "done",
  "canceled",
  "duplicate",
];

const STATE_LABEL: Record<IssueState, string> = {
  triage: "Triage",
  backlog: "Backlog",
  todo: "Todo",
  in_progress: "In Progress",
  in_review: "In Review",
  done: "Done",
  canceled: "Canceled",
  duplicate: "Duplicate",
};

function fmt(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

export default async function CyclePage({
  searchParams,
}: {
  searchParams: Promise<{ cycle?: string }>;
}) {
  const { cycle: cycleParam } = await searchParams;
  const me = await api<Me>("/v1/auth/me");
  if (!me.data) {
    return <main className="p-8 text-sm text-ink-subtle">Not signed in.</main>;
  }
  const slug = me.data.workspaceSlug;
  const [cyclesRes, teamsRes] = await Promise.all([
    api<{ cycles?: Cycle[] }>(`/v1/workspaces/${slug}/cycles`),
    api<{ teams?: Team[] }>(`/v1/workspaces/${slug}/teams`),
  ]);
  const allCycles = cyclesRes.data?.cycles ?? [];
  const teams = teamsRes.data?.teams ?? [];
  const teamById = new Map(teams.map((t) => [t.id, t.key]));

  // `?cycle=<id>` pins a specific cycle; otherwise the workspace's active
  // cycle (earliest first when several teams have one) drives the view
  const active = allCycles.filter((c) => c.isActive);
  const selected =
    (cycleParam ? allCycles.find((c) => c.id === cycleParam) : null) ??
    active[0] ??
    null;

  const issuesRes = selected
    ? await api<{ issues?: IssueRow[] }>(
        `/v1/workspaces/${slug}/issues?cycle=${selected.id}&limit=200`,
      )
    : null;
  const rows = issuesRes?.data?.issues ?? [];

  const groups: IssueGroup[] = STATE_ORDER.map((state) => ({
    key: state,
    label: STATE_LABEL[state],
    issues: rows.filter((i) => i.state === state),
  })).filter((g) => g.issues.length > 0);

  const managerCycles: ManagerCycle[] = allCycles.map((c) => ({
    id: c.id,
    number: c.number,
    name: c.name,
    teamKey: teamById.get(c.teamId) ?? "?",
    startsAt: c.startsAt,
    endsAt: c.endsAt,
    isActive: c.isActive,
  }));
  const managerTeams: ManagerTeam[] = teams.map((t) => ({
    key: t.key,
    rolloverBehavior: t.rolloverBehavior,
  }));

  return (
    <main className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-lining-faint px-4">
        <h1 className="text-sm font-semibold">Cycle</h1>
        {selected && (
          <>
            <span className="font-mono text-xs text-ink-muted">
              {teamById.get(selected.teamId)} · C{selected.number}
              {selected.name ? ` — ${selected.name}` : ""}
            </span>
            <span className="font-mono text-[11px] text-ink-tertiary">
              {fmt(selected.startsAt)} → {fmt(selected.endsAt)}
            </span>
            {selected.isActive && (
              <span className="rounded-full bg-healthy/15 px-2 py-0.5 font-mono text-[11px] text-healthy">
                active
              </span>
            )}
            <span className="font-mono text-[11px] text-ink-tertiary">
              {rows.length} issues
            </span>
          </>
        )}
        {active.length > 1 && !cycleParam && (
          <span className="ml-auto font-mono text-[11px] text-ink-tertiary">
            also active:{" "}
            {active
              .slice(1)
              .map((c) => `${teamById.get(c.teamId)} C${c.number}`)
              .join(", ")}
          </span>
        )}
      </header>

      {!selected ? (
        <div className="flex flex-col items-center px-8 py-12 text-center">
          <TallyMark size={40} quiet />
          <p className="mt-4 text-sm font-medium text-ink">No active cycle</p>
          <p className="mt-1 max-w-sm text-[13px] text-ink-subtle">
            Create a cycle below and flag it active — unfinished work rolls
            into the next cycle or the backlog per the team&apos;s rollover
            setting.
          </p>
        </div>
      ) : rows.length === 0 ? (
        <p className="px-8 py-12 text-center text-sm text-ink-subtle">
          No issues in this cycle — assign from an issue&apos;s detail page.
        </p>
      ) : (
        <IssueListClient issues={groups.flatMap((g) => g.issues)} groups={groups} />
      )}

      <CycleManager
        cycles={managerCycles}
        teams={managerTeams}
        selectedId={selected?.id ?? null}
      />
    </main>
  );
}
