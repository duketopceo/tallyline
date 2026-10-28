"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Kbd } from "@/components/app/ui";
import {
  applyLiveEvent,
  isShipEvent,
  milestoneStatus,
  relAgo,
  ringShare,
  WINDOWS,
  windowStart,
  type LiveFeedEvent,
  type MilestoneTone,
  type RoadmapMerge,
  type RoadmapProjectSummary,
  type RoadmapSummary,
  type WindowKey,
} from "@/lib/roadmap-pulse";

export interface PulseProject {
  id: string;
  name: string;
  status: string;
}
export interface PulseMilestone {
  id: string;
  projectId: string;
  title: string;
  targetDate: string | null;
  done: boolean;
}

type LiveState = "live" | "reconnecting" | "offline";

const WINDOW_STORE = "tly.roadmap.window";
const REFRESH_MS = 30_000;

function storedWindow(): WindowKey {
  try {
    const v = window.localStorage.getItem(WINDOW_STORE);
    if (v === "today" || v === "24h" || v === "7d") return v;
  } catch {
    // storage blocked
  }
  return "24h";
}

/**
 * One summary, three feeds: the server render, a debounced refetch (30s, plus
 * a beat after any live issue event) and the SSE stream folded in instantly so
 * a merge shows the moment it lands.
 */
export function useRoadmapPulse(initial: RoadmapSummary, opts?: { refreshMs?: number }) {
  const [summary, setSummary] = useState(initial);
  const [win, setWinState] = useState<WindowKey>("24h");
  const [live, setLive] = useState<LiveState>("reconnecting");
  const [fresh, setFresh] = useState<ReadonlySet<string>>(new Set());
  const [now, setNow] = useState(() => Date.now());
  const winRef = useRef(win);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const aborter = useRef<AbortController | null>(null);

  const refetch = useCallback(async () => {
    aborter.current?.abort();
    const ctl = new AbortController();
    aborter.current = ctl;
    const since = new Date(windowStart(winRef.current, Date.now())).toISOString();
    try {
      const res = await fetch(`/api/roadmap/summary?since=${encodeURIComponent(since)}`, { cache: "no-store", signal: ctl.signal });
      if (res.ok) setSummary((await res.json()) as RoadmapSummary);
    } catch {
      // keep what we have; the next tick retries
    }
  }, []);

  const schedule = useCallback(
    (ms: number) => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void refetch(), ms);
    },
    [refetch],
  );

  const setWin = useCallback(
    (w: WindowKey) => {
      winRef.current = w;
      setWinState(w);
      try {
        window.localStorage.setItem(WINDOW_STORE, w);
      } catch {
        // storage blocked
      }
      void refetch();
    },
    [refetch],
  );

  // remembered window, applied once after mount
  useEffect(() => {
    const w = storedWindow();
    if (w !== "24h") setWin(w);
  }, [setWin]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15_000);
    const r = setInterval(() => void refetch(), opts?.refreshMs ?? REFRESH_MS);
    return () => {
      clearInterval(t);
      clearInterval(r);
    };
  }, [refetch, opts?.refreshMs]);

  useEffect(() => {
    if (typeof EventSource === "undefined") return;
    let es: EventSource | null = null;
    let cancelled = false;
    void (async () => {
      let after = "";
      try {
        const r = await fetch("/api/events?limit=1", { cache: "no-store" });
        const b = r.ok ? ((await r.json()) as { events?: { id: string | number }[] }) : null;
        if (b?.events?.[0]) after = `?after=${b.events[0].id}`;
      } catch {
        // stream from now without a cursor
      }
      if (cancelled) return;
      es = new EventSource(`/api/events/stream${after}`);
      es.onopen = () => setLive("live");
      es.onmessage = (msg) => {
        let e: LiveFeedEvent;
        try {
          e = JSON.parse(msg.data as string) as LiveFeedEvent;
        } catch {
          return;
        }
        if (e.entityType !== "issue") return;
        if (isShipEvent(e)) {
          setSummary((s) => applyLiveEvent(s, e, windowStart(winRef.current, Date.now())));
          setFresh((f) => new Set(f).add(e.issueKey!));
          schedule(1500); // reconcile with the server's exact counts
        } else if (e.action === "state_changed") {
          schedule(3000); // in-flight bands moved
        }
      };
      es.onerror = () => {
        if (es && es.readyState === EventSource.CLOSED) setLive("offline");
        else setLive("reconnecting");
      };
    })();
    return () => {
      cancelled = true;
      es?.close();
      if (timer.current) clearTimeout(timer.current);
      aborter.current?.abort();
    };
  }, [schedule]);

  return { summary, win, setWin, live, fresh, now };
}

// ─── rings ───────────────────────────────────────────────────────────────

export function ProgressRing({
  name,
  p,
  windowLabel,
  size,
  href,
}: {
  name: string;
  p: RoadmapProjectSummary | undefined;
  windowLabel: string;
  size: "sm" | "lg";
  href?: string;
}) {
  const total = p?.total ?? 0;
  const closed = p?.closed ?? 0;
  const active = (p?.inProgress ?? 0) + (p?.inReview ?? 0);
  const today = p?.doneSince ?? 0;
  const share = ringShare({ total, closed, inProgress: p?.inProgress ?? 0, inReview: p?.inReview ?? 0 });
  const lg = size === "lg";
  const label = `${name}: ${closed} of ${total} closed (${share.percent}%), ${active} in progress or review, ${today} done in the ${windowLabel} window`;
  const ring = (
    <svg
      viewBox="0 0 100 100"
      role="img"
      aria-label={label}
      className={lg ? "w-full max-w-56" : "h-16 w-16 shrink-0"}
    >
      <circle cx="50" cy="50" r="42" fill="none" strokeWidth={lg ? 8 : 9} className="stroke-lining-faint" />
      <g transform="rotate(-90 50 50)" fill="none" strokeWidth={lg ? 8 : 9}>
        <circle
          cx="50" cy="50" r="42" pathLength={100}
          strokeDasharray={`${share.active} ${100 - share.active}`}
          strokeDashoffset={-share.done}
          data-band="active"
          className="stroke-accent/55 transition-[stroke-dasharray,stroke-dashoffset] duration-700 ease-out"
        />
        <circle
          cx="50" cy="50" r="42" pathLength={100}
          strokeDasharray={`${share.done} ${100 - share.done}`}
          data-band="done"
          className="stroke-healthy transition-[stroke-dasharray] duration-700 ease-out"
        />
      </g>
      <text
        x="50" y="52" textAnchor="middle" dominantBaseline="central"
        className="fill-ink font-mono"
        fontSize={total === 0 ? 20 : 28}
        fontWeight={600}
      >
        {total === 0 ? "–" : share.percent}
        {total > 0 && <tspan fontSize={13} className="fill-ink-subtle">%</tspan>}
      </text>
    </svg>
  );
  const chip =
    today > 0 ? (
      <span
        key={today}
        data-testid="done-chip"
        className={`chip-pop inline-flex items-center gap-1 rounded-sm bg-healthy-soft px-1.5 font-mono tabular-nums text-healthy ${lg ? "h-6 text-[14px]" : "h-5 text-[11px]"}`}
      >
        <span aria-hidden>▲</span>+{today} <span className="text-ink-subtle">{windowLabel}</span>
      </span>
    ) : (
      <span className={`font-mono text-ink-tertiary ${lg ? "text-[14px]" : "text-[11px]"}`}>0 {windowLabel}</span>
    );
  const body = lg ? (
    <div className="flex flex-col items-center gap-2 text-center">
      {ring}
      <p className="max-w-full truncate text-[17px] font-semibold">{name}</p>
      <p className="font-mono text-[15px] tabular-nums text-ink-muted">
        {closed}/{total} <span className="text-ink-subtle">· {active} active</span>
      </p>
      {chip}
    </div>
  ) : (
    <div className="flex items-center gap-3">
      {ring}
      <div className="min-w-0">
        <p className="truncate text-[13px] font-medium text-ink">{name}</p>
        <p className="font-mono text-[11px] tabular-nums text-ink-subtle">
          {closed}/{total} · {active} active
        </p>
        <div className="mt-1">{chip}</div>
      </div>
    </div>
  );
  return href ? (
    <Link href={href} data-testid="ring" data-project={name} className="block min-w-44 rounded-sm p-1 hover:bg-surface-2">
      {body}
    </Link>
  ) : (
    <div data-testid="ring" data-project={name} className="min-w-0 p-1">
      {body}
    </div>
  );
}

// ─── ticker ──────────────────────────────────────────────────────────────

export function MergeTicker({
  merges,
  projectName,
  now,
  fresh,
  size,
  max,
}: {
  merges: RoadmapMerge[];
  projectName: (id: string | null) => string | null;
  now: number;
  fresh: ReadonlySet<string>;
  size: "sm" | "lg";
  max: number;
}) {
  const lg = size === "lg";
  if (merges.length === 0) {
    return (
      <p className={`px-1 py-3 text-ink-subtle ${lg ? "text-[15px]" : "text-[12px]"}`}>
        Nothing shipped in this window yet. Merges and done moves land here as they happen.
      </p>
    );
  }
  return (
    <div role="log" aria-live="polite" aria-label="Shipped" data-testid="ticker">
    <ol className="divide-y divide-lining-faint">
      {merges.slice(0, max).map((m) => {
        const proj = projectName(m.projectId);
        return (
          <li
            key={m.issueKey}
            data-testid="ship-item"
            data-issue={m.issueKey}
            className={`grid grid-cols-[2.25rem_1fr] gap-2 px-1 ${lg ? "py-3" : "py-1.5"} ${fresh.has(m.issueKey) ? "ship-in" : ""}`}
          >
            <span className={`pt-0.5 font-mono tabular-nums text-ink-tertiary ${lg ? "text-[13px]" : "text-[11px]"}`}>{relAgo(m.at, now)}</span>
            <div className="min-w-0">
              <p className={`flex items-baseline gap-2 ${lg ? "text-[15px]" : "text-[13px]"}`}>
                <Link href={`/issues/${m.issueKey}`} className="shrink-0 font-mono text-[12px] text-accent hover:underline">
                  {m.issueKey}
                </Link>
                <span className="truncate text-ink">{m.issueTitle}</span>
              </p>
              <p className={`mt-0.5 flex flex-wrap items-center gap-x-2 text-ink-subtle ${lg ? "text-[13px]" : "text-[12px]"}`}>
                <span className="text-healthy" aria-hidden>✓</span>
                <span>{m.actorName ?? (m.pr ? "GitHub" : "system")}</span>
                {proj && <span className="font-mono text-ink-tertiary">· {proj}</span>}
                {m.pr && (
                  <a
                    href={m.pr.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={`pull request ${m.pr.number}${m.pr.repo ? ` in ${m.pr.repo}` : ""}`}
                    className="font-mono text-accent hover:underline"
                  >
                    PR #{m.pr.number} ↗
                  </a>
                )}
              </p>
            </div>
          </li>
        );
      })}
    </ol>
    </div>
  );
}

// ─── milestone strip ─────────────────────────────────────────────────────

const TONE: Record<MilestoneTone, { text: string; diamond: string }> = {
  done: { text: "text-healthy", diamond: "border-healthy bg-healthy" },
  late: { text: "text-urgent", diamond: "border-urgent bg-urgent" },
  soon: { text: "text-attention", diamond: "border-attention bg-attention" },
  ahead: { text: "text-accent", diamond: "border-accent bg-canvas" },
  undated: { text: "text-ink-subtle", diamond: "border-lining bg-canvas" },
};

function fmtDay(t: number): string {
  return new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function MilestoneStrip({
  milestones,
  progress,
  projectName,
  now,
  size,
}: {
  milestones: PulseMilestone[];
  progress: RoadmapSummary["milestones"];
  projectName: (id: string | null) => string | null;
  now: number;
  size: "sm" | "lg";
}) {
  const lg = size === "lg";
  const items = useMemo(() => {
    const cutoff = now - 14 * 86_400_000;
    return milestones
      .filter((m): m is PulseMilestone & { targetDate: string } => m.targetDate !== null)
      .filter((m) => !m.done || new Date(m.targetDate).getTime() >= cutoff)
      .sort((a, b) => new Date(a.targetDate).getTime() - new Date(b.targetDate).getTime())
      .slice(0, 14);
  }, [milestones, now]);
  if (items.length === 0) return null;
  const firstFuture = items.findIndex((m) => new Date(m.targetDate).getTime() >= now);
  const todayAt = firstFuture === -1 ? items.length : firstFuture;
  const prog = new Map(progress.map((p) => [p.milestoneId, p]));

  const todayMark = (
    <li key="today" aria-label="today" className="relative w-10 shrink-0" data-testid="today-mark">
      <div className="relative h-4">
        <span className="absolute inset-x-0 top-1/2 border-t border-lining" />
        <span className="absolute left-1/2 top-0 h-4 w-px bg-accent" />
      </div>
      <p className="mt-1 -translate-x-1 text-[11px] font-medium text-accent">today</p>
    </li>
  );
  const nodes = items.map((m) => {
    const st = milestoneStatus(m, now);
    const tone = TONE[st.tone];
    const pr = prog.get(m.id);
    return (
      <li key={m.id} data-testid="milestone" data-tone={st.tone} className={`relative shrink-0 pr-3 ${lg ? "w-52" : "w-40"}`}>
        <div className="relative h-4">
          <span className="absolute inset-x-0 top-1/2 border-t border-lining" />
          <span aria-hidden className={`absolute left-0 top-1/2 h-2.5 w-2.5 -translate-y-1/2 rotate-45 border ${tone.diamond}`} />
        </div>
        <p className={`mt-1 truncate text-ink-muted ${lg ? "text-[14px]" : "text-[12px]"}`} title={m.title}>{m.title}</p>
        <p className={`truncate font-mono text-ink-tertiary ${lg ? "text-[12px]" : "text-[11px]"}`}>
          {projectName(m.projectId) ?? "—"} · {fmtDay(new Date(m.targetDate).getTime())}
        </p>
        <p className={`font-medium ${tone.text} ${lg ? "text-[13px]" : "text-[11px]"}`}>
          <span aria-hidden>{st.glyph}</span> {st.label}
          {pr && pr.total > 0 && <span className="ml-2 font-mono font-normal text-ink-subtle">{pr.done}/{pr.total}</span>}
        </p>
      </li>
    );
  });
  const withToday = [...nodes.slice(0, todayAt), todayMark, ...nodes.slice(todayAt)];
  return (
    <ol aria-label="Milestones" tabIndex={0} data-testid="milestone-strip" className="flex overflow-x-auto pb-1 scroll-quiet">
      {withToday}
    </ol>
  );
}

// ─── shared bits ─────────────────────────────────────────────────────────

const LIVE_META: Record<LiveState, { glyph: string; text: string; tone: string }> = {
  live: { glyph: "●", text: "live", tone: "text-healthy" },
  reconnecting: { glyph: "◌", text: "reconnecting", tone: "text-attention" },
  offline: { glyph: "○", text: "polling", tone: "text-ink-subtle" },
};

export function LiveBadge({ live, lg }: { live: LiveState; lg?: boolean }) {
  const m = LIVE_META[live];
  return (
    <span data-testid="live-badge" data-live={live} className={`inline-flex items-center gap-1 font-medium ${m.tone} ${lg ? "text-[13px]" : "text-[11px]"}`}>
      <span aria-hidden className={live === "live" ? "motion-safe:animate-pulse" : ""}>{m.glyph}</span>
      {m.text}
    </span>
  );
}

export function WindowToggle({ win, onChange, lg }: { win: WindowKey; onChange: (w: WindowKey) => void; lg?: boolean }) {
  return (
    <div role="group" aria-label="Time window" className="inline-flex overflow-hidden rounded-sm border border-control">
      {WINDOWS.map((w, i) => (
        <button
          key={w.key}
          type="button"
          aria-pressed={win === w.key}
          onClick={() => onChange(w.key)}
          className={`font-mono ${lg ? "h-8 px-3 text-[13px]" : "h-6 px-2 text-[11px]"} ${
            win === w.key ? "bg-accent-soft text-ink" : "text-ink-subtle hover:bg-surface-2 hover:text-ink"
          } ${i > 0 ? "border-l border-control" : ""}`}
        >
          {w.label}
        </button>
      ))}
    </div>
  );
}

function useProjectLookup(projects: PulseProject[]) {
  return useMemo(() => {
    const m = new Map(projects.map((p) => [p.id, p.name]));
    return (id: string | null) => (id ? (m.get(id) ?? null) : null);
  }, [projects]);
}

/** projects worth a ring: anything with issues, started work first */
function ringProjects(projects: PulseProject[], summary: RoadmapSummary) {
  const by = new Map(summary.projects.map((p) => [p.projectId, p]));
  return projects
    .filter((p) => p.status !== "canceled" && (by.get(p.id)?.total ?? 0) > 0)
    .sort(
      (a, b) =>
        Number(b.status === "started") - Number(a.status === "started") ||
        (by.get(b.id)?.doneSince ?? 0) - (by.get(a.id)?.doneSince ?? 0) ||
        a.name.localeCompare(b.name),
    )
    .map((p) => ({ project: p, summary: by.get(p.id) }));
}

// ─── the band on /roadmap ────────────────────────────────────────────────

export function PulseBand({
  pulse,
  projects,
  milestones,
}: {
  pulse: ReturnType<typeof useRoadmapPulse>;
  projects: PulseProject[];
  milestones: PulseMilestone[];
}) {
  const { summary, win, setWin, live, fresh, now } = pulse;
  const projectName = useProjectLookup(projects);
  const rings = ringProjects(projects, summary).slice(0, 8);
  return (
    <section aria-label="Progress at a glance" data-testid="pulse-band" className="shrink-0 border-b border-lining-faint">
      <div className="flex min-h-8 flex-wrap items-center gap-x-3 gap-y-1 px-4 py-1">
        <h2 className="text-[11px] font-medium uppercase tracking-[0.4px] text-ink-subtle">Pulse</h2>
        <LiveBadge live={live} />
        <span className="font-mono text-[11px] tabular-nums text-ink-subtle max-sm:hidden" data-testid="shipped-total">
          {summary.totals.doneSince} shipped · {summary.totals.closed}/{summary.totals.issues} closed
        </span>
        <div className="ml-auto flex items-center gap-2">
          <WindowToggle win={win} onChange={setWin} />
          <Link
            href="/roadmap?push=1"
            data-testid="push-link"
            className="inline-flex h-6 items-center gap-1.5 whitespace-nowrap rounded-sm border border-control px-2 text-[11px] text-ink-muted hover:bg-surface-2 hover:text-ink"
          >
            Push view <span className="max-sm:hidden"><Kbd>P</Kbd></span>
          </Link>
        </div>
      </div>
      <div className="grid gap-x-6 gap-y-3 px-4 pb-3 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="min-w-0">
          {rings.length === 0 ? (
            <p className="py-3 text-[12px] text-ink-subtle">Rings appear once issues are attached to a project.</p>
          ) : (
            <div className="flex gap-3 overflow-x-auto pb-1 scroll-quiet">
              {rings.map(({ project, summary: ps }) => (
                <ProgressRing key={project.id} name={project.name} p={ps} windowLabel={WINDOWS.find((w) => w.key === win)!.label} size="sm" href={`/issues?project=${project.id}`} />
              ))}
            </div>
          )}
          <div className="mt-2">
            <MilestoneStrip milestones={milestones} progress={summary.milestones} projectName={projectName} now={now} size="sm" />
          </div>
        </div>
        <div className="min-w-0 lg:border-l lg:border-lining-faint lg:pl-4">
          <p className="mb-1 text-[11px] font-medium uppercase tracking-[0.4px] text-ink-subtle">Shipped</p>
          <div className="max-h-32 overflow-y-auto scroll-quiet sm:max-h-44">
            <MergeTicker merges={summary.merges} projectName={projectName} now={now} fresh={fresh} size="sm" max={12} />
          </div>
        </div>
      </div>
    </section>
  );
}

// ─── /roadmap?push=1 ─────────────────────────────────────────────────────

function BigNumber({ value, label, tone }: { value: string; label: string; tone: string }) {
  // SVG text scales with its viewBox, so the numerals can be TV-sized while
  // every DOM font stays on the design scale
  return (
    <div className="min-w-0">
      <svg viewBox="0 0 220 64" role="img" aria-label={`${label}: ${value}`} className="h-16 w-auto max-w-full">
        <text x="0" y="52" className={`font-mono ${tone}`} fontSize={60} fontWeight={600}>{value}</text>
      </svg>
      <p className="text-[13px] uppercase tracking-[0.4px] text-ink-subtle">{label}</p>
    </div>
  );
}

function clock(now: number): string {
  return new Date(now).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

export function PushView({
  initial,
  projects,
  milestones,
}: {
  initial: RoadmapSummary;
  projects: PulseProject[];
  milestones: PulseMilestone[];
}) {
  const router = useRouter();
  const pulse = useRoadmapPulse(initial, { refreshMs: 15_000 });
  const { summary, win, setWin, live, fresh, now } = pulse;
  const projectName = useProjectLookup(projects);
  const rings = ringProjects(projects, summary);
  const winLabel = WINDOWS.find((w) => w.key === win)!.label;
  const [full, setFull] = useState(false);

  useEffect(() => {
    const onFs = () => setFull(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.target instanceof HTMLElement && ["INPUT", "TEXTAREA", "SELECT"].includes(e.target.tagName)) return;
      if (e.key === "Escape" && !document.fullscreenElement) router.push("/roadmap");
      else if (e.key === "f") {
        if (document.fullscreenElement) void document.exitFullscreen();
        else void document.documentElement.requestFullscreen?.().catch(() => undefined);
      } else if (e.key === "1") setWin("today");
      else if (e.key === "2") setWin("24h");
      else if (e.key === "3") setWin("7d");
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [router, setWin]);

  const pct = summary.totals.issues > 0 ? Math.floor((summary.totals.closed / summary.totals.issues) * 100) : 0;
  const open = summary.totals.issues - summary.totals.closed;
  return (
    <div data-testid="push-view" className="fixed inset-0 z-50 flex flex-col bg-canvas text-ink">
      <header className="flex min-h-14 shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-lining-faint px-4 py-2 sm:px-6">
        <h1 className="text-[17px] font-semibold">Push</h1>
        <LiveBadge live={live} lg />
        <span data-testid="push-clock" className="whitespace-nowrap font-mono text-[24px] tabular-nums text-ink-muted">{clock(now)}</span>
        <div className="ml-auto flex items-center gap-3">
          <WindowToggle win={win} onChange={setWin} lg />
          <button
            type="button"
            onClick={() => (full ? void document.exitFullscreen() : void document.documentElement.requestFullscreen?.().catch(() => undefined))}
            className="h-8 rounded-sm border border-control px-3 text-[13px] text-ink-muted hover:bg-surface-2 hover:text-ink max-sm:hidden"
          >
            {full ? "Exit full screen" : "Full screen"} <Kbd>f</Kbd>
          </button>
          <Link href="/roadmap" data-testid="push-exit" className="inline-flex h-8 items-center gap-2 rounded-sm border border-control px-3 text-[13px] text-ink-muted hover:bg-surface-2 hover:text-ink">
            Roadmap <Kbd>Esc</Kbd>
          </Link>
        </div>
      </header>
      <div className="grid min-h-0 flex-1 grid-cols-1 overflow-y-auto lg:grid-cols-[minmax(0,1fr)_28rem] lg:overflow-hidden">
        <div className="flex flex-col gap-8 p-4 sm:p-6 lg:min-h-0 lg:overflow-y-auto">
          <div className="flex flex-wrap items-end gap-x-12 gap-y-4" data-testid="push-kpis">
            <BigNumber value={String(summary.totals.doneSince)} label={`shipped · ${winLabel}`} tone="fill-healthy" />
            <BigNumber value={`${pct}%`} label={`closed · ${summary.totals.closed}/${summary.totals.issues}`} tone="fill-ink" />
            <BigNumber value={String(open)} label="still open" tone="fill-accent" />
          </div>
          {rings.length === 0 ? (
            <p className="text-[15px] text-ink-subtle">Rings appear once issues are attached to a project.</p>
          ) : (
            <div className="grid grid-cols-[repeat(auto-fit,minmax(11rem,1fr))] gap-6" data-testid="push-rings">
              {rings.map(({ project, summary: ps }) => (
                <ProgressRing key={project.id} name={project.name} p={ps} windowLabel={winLabel} size="lg" />
              ))}
            </div>
          )}
          <div>
            <p className="mb-2 text-[13px] font-medium uppercase tracking-[0.4px] text-ink-subtle">Milestones</p>
            <MilestoneStrip milestones={milestones} progress={summary.milestones} projectName={projectName} now={now} size="lg" />
          </div>
        </div>
        <aside aria-label="Shipped" className="flex flex-col lg:min-h-0 border-t border-lining-faint lg:border-l lg:border-t-0">
          <p className="shrink-0 border-b border-lining-faint px-5 py-3 text-[13px] font-medium uppercase tracking-[0.4px] text-ink-subtle">Shipped</p>
          <div className="px-4 scroll-quiet lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
            <MergeTicker merges={summary.merges} projectName={projectName} now={now} fresh={fresh} size="lg" max={30} />
          </div>
        </aside>
      </div>
    </div>
  );
}
