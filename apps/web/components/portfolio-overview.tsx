"use client";

import Link from "next/link";
import { useRef } from "react";
import { RelativeTime } from "@/components/primitives";
import {
  activeCount,
  activityText,
  errorChip,
  nextRowIndex,
  openCount,
  portfolioTotals,
  sortProjects,
  type PortfolioProject,
} from "@/lib/portfolio";
import { projectHealth } from "@/components/roadmap-client";
import { milestoneStatus } from "@/lib/roadmap-pulse";

const STATUS_LABEL: Record<string, string> = {
  backlog: "backlog",
  planned: "planned",
  started: "in progress",
  paused: "paused",
  completed: "completed",
  canceled: "canceled",
};

const MILESTONE_TONE: Record<string, string> = {
  done: "text-healthy",
  late: "text-urgent",
  soon: "text-attention",
  ahead: "text-ink-subtle",
  undated: "text-ink-subtle",
};

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex flex-col items-center rounded-sm border border-lining-faint px-3 py-1.5">
      <span className="text-headline font-semibold tabular-nums leading-tight">{value}</span>
      <span className="text-micro text-ink-subtle">{label}</span>
    </div>
  );
}

// The page a client opens to see how their work is going. One row per
// project; j/k or the arrow keys move between rows, Enter opens the project.
export function PortfolioOverview({ projects, now }: { projects: PortfolioProject[]; now: number }) {
  const list = sortProjects(projects);
  const totals = portfolioTotals(list);
  const rows = useRef<(HTMLAnchorElement | null)[]>([]);

  function onKeyDown(e: React.KeyboardEvent<HTMLUListElement>) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const current = rows.current.findIndex((el) => el === document.activeElement);
    const next = nextRowIndex(current, e.key, list.length);
    if (next !== current && next >= 0) {
      e.preventDefault();
      rows.current[next]?.focus();
    }
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <dl className="flex flex-wrap gap-2 border-b border-lining-faint p-4" aria-label="Totals across all projects">
        <Stat label="projects" value={totals.projects} />
        <Stat label="open tickets" value={totals.open} />
        <Stat label="in progress" value={totals.inProgress} />
        <Stat label="done" value={totals.done} />
        <Stat label="open errors" value={totals.errors} />
      </dl>
      <ul className="flex flex-col" onKeyDown={onKeyDown} aria-label="Projects">
        {list.map((p, idx) => {
          const health = projectHealth(p, p.progress.done, p.progress.total, now);
          const chip = errorChip(p.errors);
          const nextMilestone = p.milestones.items.find((m) => !m.done) ?? null;
          const ms = nextMilestone ? milestoneStatus(nextMilestone, now) : null;
          return (
            <li key={p.id} className="border-b border-lining-faint">
              <Link
                ref={(el) => {
                  rows.current[idx] = el;
                }}
                href={`/projects/${p.id}`}
                className="grid gap-x-6 gap-y-2 px-4 py-3 outline-none hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent md:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1.2fr)]"
              >
                <div className="min-w-0">
                  <div className="flex items-baseline gap-2">
                    <h2 className="truncate text-sm font-semibold">{p.name}</h2>
                    <span className="shrink-0 font-mono text-micro uppercase text-ink-subtle">{STATUS_LABEL[p.status] ?? p.status}</span>
                  </div>
                  {health && (
                    <p className={`mt-0.5 text-xs ${health.tone}`}>
                      <span aria-hidden="true">{health.glyph} </span>
                      {health.label}
                      {p.targetDate && (
                        <span className="text-ink-subtle"> · target {new Date(p.targetDate).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</span>
                      )}
                    </p>
                  )}
                  <p className="mt-0.5 truncate font-mono text-micro text-ink-subtle">
                    {p.repos.length === 0 ? "no repo linked" : p.repos.join(", ")}
                  </p>
                </div>

                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <div
                      className="h-1.5 flex-1 overflow-hidden rounded-sm bg-surface-3"
                      role="progressbar"
                      aria-label={`${p.name} progress`}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={p.progress.percent}
                    >
                      <div className="h-full bg-healthy/70" style={{ width: `${p.progress.percent}%` }} />
                    </div>
                    <span className="w-9 text-right text-xs tabular-nums">{p.progress.percent}%</span>
                  </div>
                  <p className="mt-1 text-xs tabular-nums text-ink-subtle">
                    {openCount(p.counts)} open · {activeCount(p.counts)} in progress · {p.counts["done"] ?? 0} done
                  </p>
                  <p className="text-xs text-ink-subtle">
                    {p.milestones.total === 0 ? (
                      "No milestones"
                    ) : (
                      <>
                        {p.milestones.completed}/{p.milestones.total} milestones
                        {nextMilestone && ms && (
                          <span className={MILESTONE_TONE[ms.tone]}>
                            {" "}· next: {nextMilestone.title} ({nextMilestone.progress.done}/{nextMilestone.progress.total}, {ms.label})
                          </span>
                        )}
                      </>
                    )}
                  </p>
                </div>

                <div className="min-w-0">
                  <p className={`text-xs ${chip.tone}`} title={chip.detail}>
                    <span aria-hidden="true">{chip.glyph} </span>
                    {chip.label}
                  </p>
                  {p.recent.length === 0 ? (
                    <p className="mt-1 text-xs text-ink-subtle">No activity in the last 30 days.</p>
                  ) : (
                    <ul className="mt-1 flex flex-col gap-0.5">
                      {p.recent.slice(0, 3).map((a) => (
                        <li key={a.id} className="flex items-center gap-2 text-xs">
                          <span className="shrink-0 font-mono">{a.issueKey}</span>
                          <span className="truncate text-ink-subtle">{activityText(a)}</span>
                          <span className="ml-auto"><RelativeTime iso={a.createdAt} /></span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
