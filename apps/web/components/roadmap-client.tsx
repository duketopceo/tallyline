"use client";

import type { IssueState } from "@tallyline/types";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { usePicker } from "@/components/app/picker";
import { EmptyState, StateDot } from "@/components/primitives";

export interface RoadmapProject {
  id: string;
  name: string;
  description: string | null;
  status: string;
  teamId: string | null;
  startDate: string | null;
  targetDate: string | null;
  createdAt: string;
}

export interface RoadmapCycle {
  id: string;
  name: string | null;
  number: number;
  teamId: string;
  startsAt: string;
  endsAt: string;
  isActive: boolean;
}

export interface RoadmapMilestone {
  id: string;
  projectId: string;
  title: string;
  targetDate: string | null;
  sortOrder: number;
  done: boolean;
}

export interface RoadmapIssue {
  key: string;
  title: string;
  state: IssueState;
  projectId: string | null;
}

export interface RoadmapTeam {
  id: string;
  key: string;
}

type Row =
  | { kind: "project"; project: RoadmapProject }
  | { kind: "cycle"; cycle: RoadmapCycle };

const STATUS_LABEL: Record<string, string> = {
  backlog: "backlog",
  planned: "planned",
  started: "started",
  paused: "paused",
  completed: "completed",
  canceled: "canceled",
};

// bar chrome per status — started reads as the "live" span, terminal states
// fade back so the axis stays readable at a glance
const BAR_CLASS: Record<string, string> = {
  started: "border-accent bg-accent/15",
  planned: "border-lining bg-surface-3",
  backlog: "border-lining-faint bg-surface-2",
  paused: "border-attention/60 bg-attention/10",
  completed: "border-healthy/60 bg-healthy/10",
  canceled: "border-lining-faint bg-surface-2 opacity-50",
};

const FILL_CLASS: Record<string, string> = {
  started: "bg-accent/25",
  completed: "bg-healthy/25",
};
const FILL_DEFAULT = "bg-ink/10";

const DAY = 86_400_000;

// project health from time elapsed vs work done; always text + shape, never colour alone
export function projectHealth(p: { startDate: string | null; targetDate: string | null; createdAt: string; status: string }, done: number, total: number, now: number): { label: string; tone: string; glyph: string } | null {
  if (p.status === "completed") return { label: "Completed", tone: "text-healthy", glyph: "✓" };
  if (p.status === "canceled" || p.status === "backlog") return null;
  if (!p.targetDate) return { label: "No target date", tone: "text-ink-subtle", glyph: "–" };
  const start = new Date(p.startDate ?? p.createdAt).getTime();
  const end = new Date(p.targetDate).getTime();
  const ratio = total > 0 ? done / total : 0;
  if (now > end && ratio < 1) return { label: "Late", tone: "text-urgent", glyph: "!" };
  const elapsed = end > start ? Math.min(1, Math.max(0, (now - start) / (end - start))) : 1;
  if (total > 0 && ratio + 0.15 < elapsed) return { label: "At risk", tone: "text-attention", glyph: "▲" };
  return { label: "On track", tone: "text-healthy", glyph: "●" };
}
const TERMINAL: ReadonlySet<string> = new Set(["done", "canceled", "duplicate"]);

function fmtDay(t: number): string {
  return new Date(t).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

function fmtMonth(t: number): string {
  return new Date(t).toLocaleDateString("en-US", {
    month: "short",
    year: "2-digit",
  });
}

// Axis tick granularity adapts to the visible span: short windows get weekly
// (Monday-aligned) ticks, long ones monthly (quarterly past ~1.5y).
function buildTicks(min: number, max: number): { t: number; label: string }[] {
  const span = max - min;
  const out: { t: number; label: string }[] = [];
  if (span <= 75 * DAY) {
    const d = new Date(min);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); // back to Monday
    for (let t = d.getTime(); t <= max; t += 7 * DAY) {
      out.push({ t, label: fmtDay(t) });
    }
    return out;
  }
  const quarterly = span > 540 * DAY;
  const d = new Date(min);
  d.setHours(0, 0, 0, 0);
  d.setDate(1);
  for (let t = d.getTime(); t <= max; ) {
    const dt = new Date(t);
    if (!quarterly || dt.getMonth() % 3 === 0) {
      out.push({ t, label: fmtMonth(t) });
    }
    dt.setMonth(dt.getMonth() + 1);
    t = dt.getTime();
  }
  return out;
}

function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  return (
    el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName)
  );
}

export function RoadmapClient({
  projects,
  cycles,
  milestones,
  issues,
  teams,
}: {
  projects: RoadmapProject[];
  cycles: RoadmapCycle[];
  milestones: RoadmapMilestone[];
  issues: RoadmapIssue[];
  teams: RoadmapTeam[];
}) {
  const router = useRouter();
  const [cursor, setCursor] = useState(0);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const teamById = useMemo(
    () => new Map(teams.map((t) => [t.id, t.key])),
    [teams],
  );
  const issuesByProject = useMemo(() => {
    const m = new Map<string, RoadmapIssue[]>();
    for (const i of issues) {
      if (!i.projectId) continue;
      const list = m.get(i.projectId) ?? [];
      list.push(i);
      m.set(i.projectId, list);
    }
    return m;
  }, [issues]);
  const milestonesByProject = useMemo(() => {
    const m = new Map<string, RoadmapMilestone[]>();
    for (const ms of milestones) {
      const list = m.get(ms.projectId) ?? [];
      list.push(ms);
      m.set(ms.projectId, list);
    }
    return m;
  }, [milestones]);

  // one row per project (start asc), then one per cycle (start asc)
  const rows = useMemo<Row[]>(() => {
    const startOf = (p: RoadmapProject) =>
      new Date(p.startDate ?? p.createdAt).getTime();
    const prows = [...projects]
      .sort((a, b) => startOf(a) - startOf(b) || a.name.localeCompare(b.name))
      .map((project) => ({ kind: "project", project }) as const);
    const crows = [...cycles]
      .sort(
        (a, b) =>
          new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime(),
      )
      .map((cycle) => ({ kind: "cycle", cycle }) as const);
    return [...prows, ...crows];
  }, [projects, cycles]);

  const now = Date.now();

  // axis domain covers every span, every dated milestone, and today — padded
  // so boundary rows never hug the edge
  const [min, max] = useMemo(() => {
    const pts = [now - 7 * DAY, now + 14 * DAY];
    for (const p of projects) {
      pts.push(new Date(p.startDate ?? p.createdAt).getTime());
      pts.push(
        p.targetDate ? new Date(p.targetDate).getTime() : now + 7 * DAY,
      );
    }
    for (const c of cycles) {
      pts.push(new Date(c.startsAt).getTime(), new Date(c.endsAt).getTime());
    }
    for (const m of milestones) {
      if (m.targetDate) pts.push(new Date(m.targetDate).getTime());
    }
    let lo = Math.min(...pts);
    let hi = Math.max(...pts);
    const pad = Math.max((hi - lo) * 0.03, DAY);
    lo -= pad;
    hi += pad;
    return [lo, hi];
  }, [projects, cycles, milestones, now]);

  const ticks = useMemo(() => buildTicks(min, max), [min, max]);
  const pct = useCallback((t: number) => ((t - min) / (max - min)) * 100, [min, max]);

  function spanOf(p: RoadmapProject): { left: number; width: number; open: boolean } {
    const start = new Date(p.startDate ?? p.createdAt).getTime();
    const open = !p.targetDate;
    const end = p.targetDate ? new Date(p.targetDate).getTime() : now;
    const right = Math.max(end, start + DAY / 4); // never zero-width
    return {
      left: pct(start),
      width: pct(right) - pct(start),
      open,
    };
  }

  const toggleRow = useCallback(
    (row: Row) => {
      if (row.kind === "cycle") {
        router.push(`/cycle?cycle=${row.cycle.id}`);
        return;
      }
      setExpanded((e) => (e === row.project.id ? null : row.project.id));
    },
    [router],
  );

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (isTypingTarget(e.target) || e.metaKey || e.ctrlKey || e.altKey)
        return;
      const row = rows[cursor];
      switch (e.key) {
        case "j":
        case "ArrowDown":
          if (rows.length === 0) break;
          e.preventDefault();
          setCursor((c) => Math.min(c + 1, rows.length - 1));
          break;
        case "k":
        case "ArrowUp":
          e.preventDefault();
          setCursor((c) => Math.max(c - 1, 0));
          break;
        case "Enter":
          if (!row) break;
          // focused controls (row button, milestone toggles, links) activate
          // natively — only act when the cursor is unfocused
          if (
            e.target instanceof HTMLElement &&
            e.target.closest("button, a")
          ) {
            break;
          }
          e.preventDefault();
          toggleRow(row);
          break;
        case "Escape":
          setExpanded(null);
          break;
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [cursor, rows, toggleRow]);

  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-index="${cursor}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  async function call(path: string, init: RequestInit, tag: string) {
    setBusy(tag);
    setError(null);
    try {
      const res = await fetch(path, {
        ...init,
        headers: { "content-type": "application/json" },
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        setError(body?.error?.message ?? `request failed (${res.status})`);
        return false;
      }
      router.refresh();
      return true;
    } catch {
      setError("network error");
      return false;
    } finally {
      setBusy(null);
    }
  }

  // grid lines + today marker shared by every row's track — keeps the axis
  // readable without a global overlay fighting stacking contexts
  function TrackBackdrop() {
    return (
      <div aria-hidden className="pointer-events-none absolute inset-0">
        {ticks.map(({ t }) => (
          <div
            key={t}
            className="absolute inset-y-0 border-l border-lining-faint"
            style={{ left: `${pct(t)}%` }}
          />
        ))}
        <div
          className="absolute inset-y-0 w-px bg-accent/50"
          style={{ left: `${pct(now)}%` }}
        />
      </div>
    );
  }

  function projectRow(p: RoadmapProject, i: number) {
    const isCursor = i === cursor;
    const open = expanded === p.id;
    const span = spanOf(p);
    const ms = milestonesByProject.get(p.id) ?? [];
    const iss = issuesByProject.get(p.id) ?? [];
    const done = iss.filter((x) => TERMINAL.has(x.state)).length;
    const ratio = iss.length > 0 ? done / iss.length : 0;
    return (
      <li key={p.id}>
        <button
          type="button"
          data-index={i}
          aria-expanded={open}
          onClick={() => toggleRow({ kind: "project", project: p })}
          onMouseEnter={() => setCursor(i)}
          className={`grid w-full grid-cols-[16rem_1fr] items-center border-b border-lining-faint text-left focus-visible:outline-none ${
            isCursor ? "bg-surface-2" : "hover:bg-surface-1"
          }`}
        >
          <span className="flex h-10 items-center gap-2 truncate px-4">
            <span className="truncate text-[13px] text-ink-muted">
              {p.name}
            </span>
            <span className="shrink-0 font-mono text-[11px] text-ink-tertiary">
              {p.teamId ? (teamById.get(p.teamId) ?? "?") : "ws"}
            </span>
            {iss.length > 0 && (
              <span className="shrink-0 font-mono text-[11px] text-ink-tertiary">
                {done}/{iss.length}
              </span>
            )}
            {(() => {
              const h = projectHealth(p, done, iss.length, now);
              return h ? <span className={`shrink-0 text-[11px] font-medium ${h.tone}`}><span aria-hidden>{h.glyph} </span>{h.label}</span> : null;
            })()}
          </span>
          <span className="relative h-10 flex-1">
            <TrackBackdrop />
            <span
              data-span="project"
              className={`absolute top-1/2 h-4 -translate-y-1/2 rounded-sm border ${
                BAR_CLASS[p.status] ?? BAR_CLASS["planned"]
              }`}
              style={{
                left: `${span.left}%`,
                width: `${Math.max(span.width, 0.8)}%`,
                // open-ended spans fade out past "now" instead of hard-stopping
                ...(span.open
                  ? {
                      maskImage:
                        "linear-gradient(to right, black 75%, transparent)",
                      WebkitMaskImage:
                        "linear-gradient(to right, black 75%, transparent)",
                    }
                  : {}),
              }}
            >
              {ratio > 0 && (
                <span
                  className={`block h-full rounded-sm ${FILL_CLASS[p.status] ?? FILL_DEFAULT}`}
                  style={{ width: `${ratio * 100}%` }}
                />
              )}
            </span>
            {ms
              .filter(
                (m): m is RoadmapMilestone & { targetDate: string } =>
                  m.targetDate !== null,
              )
              .map((m) => (
                <span
                  key={m.id}
                  title={`${m.title} — ${fmtDay(new Date(m.targetDate).getTime())}`}
                  aria-label={`milestone ${m.title}`}
                  className={`absolute top-1/2 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rotate-45 border ${
                    m.done
                      ? "border-healthy bg-healthy"
                      : "border-accent bg-canvas"
                  }`}
                  style={{ left: `${pct(new Date(m.targetDate).getTime())}%` }}
                />
              ))}
          </span>
        </button>
        {open && (
          <ProjectDetail
            project={p}
            milestones={ms}
            issues={iss}
            teamById={teamById}
            busy={busy}
            onCall={call}
          />
        )}
      </li>
    );
  }

  function cycleRow(c: RoadmapCycle, i: number) {
    const isCursor = i === cursor;
    const left = pct(new Date(c.startsAt).getTime());
    const width = pct(new Date(c.endsAt).getTime()) - left;
    return (
      <li key={c.id}>
        <button
          type="button"
          data-index={i}
          onClick={() => toggleRow({ kind: "cycle", cycle: c })}
          onMouseEnter={() => setCursor(i)}
          className={`grid w-full grid-cols-[16rem_1fr] items-center border-b border-lining-faint text-left focus-visible:outline-none ${
            isCursor ? "bg-surface-2" : "hover:bg-surface-1"
          }`}
        >
          <span className="flex h-8 items-center gap-2 truncate px-4">
            <span className="shrink-0 font-mono text-xs text-ink-tertiary">
              {teamById.get(c.teamId) ?? "?"} · C{c.number}
            </span>
            <span className="truncate text-[12px] text-ink-subtle">
              {c.name ?? ""}
            </span>
            {c.isActive && (
              <span className="shrink-0 rounded-full bg-healthy/15 px-1.5 font-mono text-[11px] text-healthy">
                active
              </span>
            )}
          </span>
          <span className="relative h-8 flex-1">
            <TrackBackdrop />
            <span
              data-span="cycle"
              className={`absolute top-1/2 h-2.5 -translate-y-1/2 rounded-sm border ${
                c.isActive
                  ? "border-healthy/70 bg-healthy/20"
                  : "border-lining bg-surface-3"
              }`}
              style={{ left: `${left}%`, width: `${Math.max(width, 0.8)}%` }}
            />
          </span>
        </button>
      </li>
    );
  }

  const projectCount = rows.filter((r) => r.kind === "project").length;
  const cycleCount = rows.length - projectCount;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* axis header — shares the same grid so ticks align with rows */}
      <div className="grid h-7 shrink-0 grid-cols-[16rem_1fr] items-end border-b border-lining-faint">
        <span className="px-4 text-[11px] font-medium uppercase tracking-[0.4px] text-ink-subtle">
          roadmap
        </span>
        <div className="relative h-full">
          {ticks.map(({ t, label }) => (
            <span
              key={t}
              className="absolute bottom-0.5 -translate-x-1/2 font-mono text-[11px] whitespace-nowrap text-ink-tertiary"
              style={{ left: `${pct(t)}%` }}
            >
              {label}
            </span>
          ))}
          <span
            className="absolute bottom-0.5 -translate-x-1/2 font-mono text-[11px] text-accent"
            style={{ left: `${pct(now)}%` }}
          >
            today
          </span>
        </div>
      </div>

      <ul ref={listRef} className="flex-1 overflow-y-auto">
        {rows.length === 0 && (
          <li>
            <EmptyState
              title="Nothing on the roadmap"
              detail="Create a project below — give it a target date and it becomes a span on the timeline. Cycles appear automatically once a team has them."
            />
          </li>
        )}
        {projectCount > 0 && (
          <li>
            <div className="flex h-7 items-center gap-2 border-b border-lining-faint bg-surface-1 px-4 text-[11px] font-medium uppercase tracking-[0.4px] text-ink-subtle">
              Projects
              <span>{projectCount}</span>
            </div>
            <ul>
              {rows.map((row, i) =>
                row.kind === "project" ? projectRow(row.project, i) : null,
              )}
            </ul>
          </li>
        )}
        {cycleCount > 0 && (
          <li>
            <div className="flex h-7 items-center gap-2 border-b border-lining-faint bg-surface-1 px-4 text-[11px] font-medium uppercase tracking-[0.4px] text-ink-subtle">
              Cycles
              <span>{cycleCount}</span>
            </div>
            <ul>
              {rows.map((row, i) =>
                row.kind === "cycle" ? cycleRow(row.cycle, i) : null,
              )}
            </ul>
          </li>
        )}
      </ul>

      <NewProjectForm teams={teams} busy={busy} onCall={call} />

      {error && (
        <p
          role="alert"
          className="shrink-0 border-t border-l-2 border-lining-faint border-l-urgent px-4 py-1.5 text-[12px] text-urgent"
        >
          {error}
        </p>
      )}
      <footer className="flex h-8 shrink-0 items-center gap-4 border-t border-lining-faint px-4 font-mono text-[11px] text-ink-tertiary">
        <span>
          <kbd>j</kbd>/<kbd>k</kbd> move
        </span>
        <span>
          <kbd>⏎</kbd> open
        </span>
        <span>
          <kbd>esc</kbd> collapse
        </span>
        <span className="ml-auto">◆ milestone · open ends fade</span>
      </footer>
    </div>
  );
}

function toLocalInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function ProjectDetail({
  project,
  milestones,
  issues,
  teamById,
  busy,
  onCall,
}: {
  project: RoadmapProject;
  milestones: RoadmapMilestone[];
  issues: RoadmapIssue[];
  teamById: Map<string, string>;
  busy: string | null;
  onCall: (path: string, init: RequestInit, tag: string) => Promise<boolean>;
}) {
  const picker = usePicker();
  const [msTitle, setMsTitle] = useState("");
  const [msDate, setMsDate] = useState("");

  async function addMilestone(e: FormEvent) {
    e.preventDefault();
    if (!msTitle.trim() || busy) return;
    const ok = await onCall(
      `/api/projects/${project.id}/milestones`,
      {
        method: "POST",
        body: JSON.stringify({
          title: msTitle.trim(),
          ...(msDate ? { targetDate: new Date(msDate).toISOString() } : {}),
        }),
      },
      `ms-${project.id}`,
    );
    if (ok) {
      setMsTitle("");
      setMsDate("");
    }
  }

  return (
    <div className="grid grid-cols-[16rem_1fr] border-b border-lining-faint bg-surface-1">
      <div className="px-4 py-3">
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={busy !== null}
            aria-label={`Project status: ${project.status}. Change`}
            onClick={(e) =>
              picker.open({
                anchor: e.currentTarget,
                title: "Set project status",
                options: Object.keys(STATUS_LABEL).map((st) => ({ id: st, label: STATUS_LABEL[st]!, checked: st === project.status })),
                onSelect: (st) => void onCall(`/api/projects/${project.id}`, { method: "PATCH", body: JSON.stringify({ status: st }) }, project.id),
              })
            }
            className="h-7 rounded-sm border border-control px-2 text-[12px] text-ink-muted hover:bg-surface-2 hover:text-ink disabled:opacity-50"
          >
            {STATUS_LABEL[project.status] ?? project.status}
          </button>
          <span className="font-mono text-[11px] text-ink-tertiary">
            {project.teamId ? (teamById.get(project.teamId) ?? "?") : "workspace"}
          </span>
        </div>
        <p className="mt-2 font-mono text-[11px] text-ink-tertiary">
          {fmtDay(
            new Date(project.startDate ?? project.createdAt).getTime(),
          )}{" "}
          →{" "}
          {project.targetDate
            ? fmtDay(new Date(project.targetDate).getTime())
            : "open"}
        </p>
        {project.description && (
          <p className="mt-2 line-clamp-4 text-[12px] leading-snug text-ink-subtle">
            {project.description}
          </p>
        )}
        <Link href={`/board?project=${project.id}`} className="mt-3 inline-flex h-7 items-center rounded-sm border border-control px-2.5 text-[12px] text-ink-muted hover:bg-surface-2 hover:text-ink">Open on board</Link>
        <Link href={`/issues?project=${project.id}`} className="ml-2 mt-3 inline-flex h-7 items-center rounded-sm px-2 text-[12px] text-accent hover:bg-surface-2">All issues</Link>
      </div>
      <div className="border-l border-lining-faint px-4 py-3">
        <div className="flex flex-wrap gap-x-6 gap-y-3">
          <div className="min-w-56">
            <p className="text-[11px] font-medium uppercase tracking-[0.4px] text-ink-subtle">
              Milestones
            </p>
            <ul className="mt-1.5 space-y-1">
              {milestones.map((m) => (
                <li key={m.id} className="flex items-center gap-2 text-[12px]">
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() =>
                      void onCall(
                        `/api/projects/${project.id}/milestones/${m.id}`,
                        {
                          method: "PATCH",
                          body: JSON.stringify({ done: !m.done }),
                        },
                        m.id,
                      )
                    }
                    aria-label={`toggle milestone ${m.title}`}
                    className={`h-3 w-3 shrink-0 rotate-45 border ${
                      m.done
                        ? "border-healthy bg-healthy"
                        : "border-accent bg-canvas"
                    }`}
                  />
                  <span
                    className={
                      m.done
                        ? "text-ink-tertiary line-through"
                        : "text-ink-muted"
                    }
                  >
                    {m.title}
                  </span>
                  <span className="font-mono text-[11px] text-ink-tertiary">
                    {m.targetDate
                      ? fmtDay(new Date(m.targetDate).getTime())
                      : "undated"}
                  </span>
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() =>
                      void onCall(
                        `/api/projects/${project.id}/milestones/${m.id}`,
                        { method: "DELETE" },
                        m.id,
                      )
                    }
                    className="font-mono text-[11px] text-ink-tertiary hover:text-urgent"
                    aria-label={`delete milestone ${m.title}`}
                  >
                    ×
                  </button>
                </li>
              ))}
              {milestones.length === 0 && (
                <li className="text-[12px] text-ink-tertiary">
                  no milestones yet
                </li>
              )}
            </ul>
            <form onSubmit={addMilestone} className="mt-2 flex items-center gap-1.5">
              <input
                value={msTitle}
                onChange={(e) => setMsTitle(e.target.value)}
                placeholder="milestone title"
                className="h-6 w-36 rounded-sm border border-control bg-surface-2 px-1.5 text-[11px] text-ink placeholder:text-ink-tertiary focus:border-accent focus:outline-none"
              />
              <input
                type="date"
                value={msDate}
                onChange={(e) => setMsDate(e.target.value)}
                className="h-6 rounded-sm border border-control bg-surface-2 px-1 font-mono text-[11px] text-ink-muted"
                aria-label="milestone target date"
              />
              <button
                type="submit"
                disabled={busy !== null || !msTitle.trim()}
                className="h-6 rounded-sm border border-control px-2 font-mono text-[11px] text-ink-subtle hover:border-accent hover:text-accent disabled:opacity-50"
              >
                add
              </button>
            </form>
          </div>
          <div className="min-w-56 flex-1">
            <p className="text-[11px] font-medium uppercase tracking-[0.4px] text-ink-subtle">
              Issues ({issues.length})
            </p>
            <ul className="mt-1.5 max-h-40 space-y-1 overflow-y-auto">
              {issues.map((i) => (
                <li key={i.key}>
                  <Link
                    href={`/issues/${i.key}`}
                    className="flex items-center gap-2 text-[12px] text-ink-muted hover:text-ink"
                  >
                    <StateDot state={i.state} />
                    <span className="font-mono text-[11px] text-ink-tertiary">
                      {i.key}
                    </span>
                    <span className="truncate">{i.title}</span>
                  </Link>
                </li>
              ))}
              {issues.length === 0 && (
                <li className="text-[12px] text-ink-tertiary">
                  no issues linked — set a project on an issue to attach it
                </li>
              )}
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}

function NewProjectForm({
  teams,
  busy,
  onCall,
}: {
  teams: RoadmapTeam[];
  busy: string | null;
  onCall: (path: string, init: RequestInit, tag: string) => Promise<boolean>;
}) {
  const picker = usePicker();
  const [name, setName] = useState("");
  const [teamKey, setTeamKey] = useState("");
  const [startDate, setStartDate] = useState(toLocalInput(new Date()).slice(0, 10));
  const [targetDate, setTargetDate] = useState("");

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim() || busy) return;
    const ok = await onCall(
      "/api/projects",
      {
        method: "POST",
        body: JSON.stringify({
          name: name.trim(),
          ...(teamKey ? { teamKey } : {}),
          ...(startDate
            ? { startDate: new Date(startDate).toISOString() }
            : {}),
          ...(targetDate
            ? { targetDate: new Date(targetDate).toISOString() }
            : {}),
        }),
      },
      "create",
    );
    if (ok) {
      setName("");
      setTargetDate("");
    }
  }

  return (
    <form
      onSubmit={submit}
      className="flex shrink-0 flex-wrap items-center gap-2 border-t border-lining-faint px-4 py-2.5"
    >
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="project name"
        className="h-7 w-44 rounded-sm border border-control bg-surface-2 px-2 text-[12px] text-ink placeholder:text-ink-tertiary focus:border-accent focus:outline-none"
      />
      <button
        type="button"
        aria-label={`Team: ${teamKey || "workspace"}. Change`}
        onClick={(e) =>
          picker.open({
            anchor: e.currentTarget,
            title: "Project team",
            options: [{ id: "", label: "Workspace (all teams)", checked: !teamKey }, ...teams.map((t) => ({ id: t.key, label: t.key, checked: t.key === teamKey }))],
            onSelect: (id) => setTeamKey(id),
          })
        }
        className="h-8 rounded-sm border border-control px-2.5 text-[12px] text-ink-muted hover:bg-surface-2"
      >
        {teamKey || "Workspace"}
      </button>
      <input
        type="date"
        value={startDate}
        onChange={(e) => setStartDate(e.target.value)}
        className="h-7 rounded-sm border border-control bg-surface-2 px-1.5 font-mono text-[11px] text-ink-muted"
        aria-label="start date"
      />
      <span className="font-mono text-[11px] text-ink-tertiary">→</span>
      <input
        type="date"
        value={targetDate}
        onChange={(e) => setTargetDate(e.target.value)}
        className="h-7 rounded-sm border border-control bg-surface-2 px-1.5 font-mono text-[11px] text-ink-muted"
        aria-label="target date (optional)"
      />
      <button
        type="submit"
        disabled={busy !== null || !name.trim()}
        className="h-7 rounded-sm bg-accent px-3 text-[12px] font-medium text-on-accent hover:bg-accent-hover disabled:opacity-50"
      >
        {busy === "create" ? "…" : "New project"}
      </button>
    </form>
  );
}
