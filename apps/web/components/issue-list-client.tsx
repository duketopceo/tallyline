"use client";

import type { IssueState, Priority } from "@tallyline/types";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRegisterActions } from "./app/actions";
import { useMerged } from "./app/issue-store";
import { NewPill, useLiveCount } from "./app/live";
import { type IssueLike, useIssueEditors } from "./app/pickers";
import { useMeta, useNames, usePeek } from "./app/providers";
import { Assignee, Glint, Kbd, PriorityGlyph, StateGlyph } from "./app/ui";
import { PRIORITY_LABEL, relTime, STATE_LABEL } from "@/lib/format";
import { apiQuery, parseFilters } from "@/lib/filters";

export interface ListIssue {
  key: string;
  title: string;
  state: IssueState;
  priority: Priority;
  creatorType?: string;
  creatorId?: string | null;
  assigneeType?: "human" | "agent" | null;
  assigneeId?: string | null;
  teamId?: string;
  cycleId?: string | null;
  projectId?: string | null;
  source?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface IssueGroup {
  key: string;
  label: string;
  issues: ListIssue[];
}

type Mode = "list" | "triage";

const STATE_ORDER: IssueState[] = ["in_progress", "in_review", "todo", "backlog", "triage", "done", "canceled", "duplicate"];
const PRIO_ORDER: Priority[] = ["urgent", "high", "medium", "low", "none"];
const DENSITY: Record<string, number> = { compact: 32, default: 36, comfortable: 40 };

function isTypingTarget(el: EventTarget | null): boolean {
  return el instanceof HTMLElement && (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName));
}

function sortIssues(list: ListIssue[], sort: string | null): ListIssue[] {
  if (sort === "priority") return [...list].sort((a, b) => PRIO_ORDER.indexOf(a.priority) - PRIO_ORDER.indexOf(b.priority));
  if (sort === "updated") return [...list].sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
  return list;
}

export function IssueListClient({
  issues,
  groups: fixedGroups,
  mode = "list",
  nextCursor = null,
  emptyAction,
}: {
  issues: ListIssue[];
  groups?: IssueGroup[] | undefined;
  mode?: Mode;
  nextCursor?: string | null;
  emptyAction?: React.ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const meta = useMeta();
  const names = useNames();
  const peek = usePeek();
  const editors = useIssueEditors();
  const live = useLiveCount();
  const filters = useMemo(() => parseFilters(search), [search]);
  const viewKey = `tl:view:${pathname}?${[...search.entries()].filter(([k]) => k !== "cursor").map(([k, v]) => `${k}=${v}`).join("&")}`;

  const [extra, setExtra] = useState<ListIssue[]>([]);
  const [more, setMore] = useState<string | null>(nextCursor);
  const [cursor, setCursor] = useState(0);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [anchor, setAnchor] = useState(0);
  const [editing, setEditing] = useState<string | null>(null);
  const [density, setDensity] = useState("default");
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setExtra([]);
    setMore(nextCursor);
  }, [issues, nextCursor]);

  useEffect(() => {
    try {
      const d = localStorage.getItem("tl:density");
      if (d && d in DENSITY) setDensity(d);
    } catch { /* ignore */ }
    const onDensity = (e: Event) => setDensity((e as CustomEvent<string>).detail);
    window.addEventListener("tl:density", onDensity);
    return () => window.removeEventListener("tl:density", onDensity);
  }, []);

  // client-side filters the API can't express (unassigned / any agent / any human)
  const all = useMemo(() => {
    let l = [...issues, ...extra];
    if (filters.assignee === "none") l = l.filter((i) => !i.assigneeId);
    else if (filters.assignee === "agent") l = l.filter((i) => i.assigneeType === "agent");
    else if (filters.assignee === "human") l = l.filter((i) => i.assigneeType === "human");
    return l;
  }, [issues, extra, filters.assignee]);

  const groups: IssueGroup[] | undefined = useMemo(() => {
    if (fixedGroups) return fixedGroups;
    const by = filters.group;
    if (!by || by === "none") return undefined;
    const sorted = sortIssues(all, filters.sort);
    const bucket = new Map<string, ListIssue[]>();
    const keyOf = (i: ListIssue) =>
      by === "state" ? i.state : by === "priority" ? i.priority : by === "assignee" ? (i.assigneeId ?? "none") : by === "project" ? (i.projectId ?? "none") : (i.cycleId ?? "none");
    for (const i of sorted) bucket.set(keyOf(i), [...(bucket.get(keyOf(i)) ?? []), i]);
    const label = (k: string) =>
      by === "state" ? STATE_LABEL[k]! : by === "priority" ? PRIORITY_LABEL[k]! : by === "assignee" ? (k === "none" ? "Unassigned" : (meta.members.find((m) => m.userId === k)?.name ?? meta.agents.find((a) => a.id === k)?.name ?? "Unknown")) : by === "project" ? (k === "none" ? "No project" : (meta.projects.find((p) => p.id === k)?.name ?? "Unknown")) : k === "none" ? "No cycle" : (() => { const c = meta.cycles.find((x) => x.id === k); return c ? `${meta.teams.find((t) => t.id === c.teamId)?.key ?? ""} Cycle ${c.number}${c.name ? ` · ${c.name}` : ""}` : "Unknown"; })();
    const order = by === "state" ? STATE_ORDER : by === "priority" ? PRIO_ORDER : [...bucket.keys()].sort((a, b) => (a === "none" ? 1 : b === "none" ? -1 : label(a).localeCompare(label(b))));
    return order.filter((k) => bucket.has(k)).map((k) => ({ key: k, label: label(k), issues: bucket.get(k)! }));
  }, [fixedGroups, filters.group, filters.sort, all, meta]);

  const flat = useMemo(() => (groups ? groups.flatMap((g) => g.issues) : sortIssues(all, filters.sort)), [groups, all, filters.sort]);
  const cur = flat[Math.min(cursor, flat.length - 1)];
  const targets = useMemo<ListIssue[]>(() => (selected.size ? flat.filter((i) => selected.has(i.key)) : cur ? [cur] : []), [selected, flat, cur]);

  // merged (optimistic) view of the targets so pickers show current values
  const like = (i: ListIssue): IssueLike => ({ ...i, assigneeType: i.assigneeType ?? null, assigneeId: i.assigneeId ?? null });

  useEffect(() => {
    if (cursor > flat.length - 1) setCursor(Math.max(0, flat.length - 1));
  }, [flat.length, cursor]);

  // peek follows the cursor (Linear-style): arrows in an open peek move through the list
  useEffect(() => {
    if (peek.key && cur && cur.key !== peek.key) peek.open(cur.key);
  }, [cur, peek]);

  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${cursor}"]`)?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  // remembered scroll per view
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    try {
      const y = Number(sessionStorage.getItem(`${viewKey}:scroll`));
      if (y) el.scrollTop = y;
    } catch { /* ignore */ }
    let t: ReturnType<typeof setTimeout>;
    const onScroll = () => {
      clearTimeout(t);
      t = setTimeout(() => {
        try { sessionStorage.setItem(`${viewKey}:scroll`, String(el.scrollTop)); } catch { /* ignore */ }
      }, 150);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => { clearTimeout(t); el.removeEventListener("scroll", onScroll); };
  }, [viewKey]);

  const anchorEl = useCallback((): HTMLElement => {
    return (listRef.current?.querySelector<HTMLElement>('[data-cursor="true"] [data-title-link]') ?? listRef.current)!;
  }, []);

  const toggle = useCallback((key: string, idx: number, range: boolean) => {
    setSelected((s) => {
      const n = new Set(s);
      if (range) {
        const [a, b] = [Math.min(anchor, idx), Math.max(anchor, idx)];
        for (let i = a; i <= b; i++) n.add(flat[i]!.key);
      } else if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });
    setAnchor(idx);
  }, [anchor, flat]);

  const act = useCallback((id: string) => {
    const t = targets.map(like);
    if (!t.length) return;
    const a = anchorEl();
    if (id === "state") editors.pickState(a, t);
    else if (id === "priority") editors.pickPriority(a, t);
    else if (id === "assignee") editors.pickAssignee(a, t);
    else if (id === "project") editors.pickProject(a, t);
    else if (id === "cycle") editors.pickCycle(a, t);
    else if (id === "peek" && cur) peek.toggle(cur.key);
    else if (id === "select" && cur) toggle(cur.key, cursor, false);
    else if (id === "open" && cur) router.push(`/issues/${cur.key}`);
    else if (id === "edit" && cur) setEditing(cur.key);
    else if (id === "accept") editors.run(t, { state: "backlog" }, `${t.length === 1 ? t[0]!.key : `${t.length} issues`} accepted to Backlog`);
    else if (id === "accept-todo") editors.run(t, { state: "todo" }, `${t.length === 1 ? t[0]!.key : `${t.length} issues`} accepted to Todo`);
    else if (id === "decline") editors.run(t, { state: "canceled" }, `${t.length === 1 ? t[0]!.key : `${t.length} issues`} declined`);
    else if (id === "duplicate") editors.run(t, { state: "duplicate" }, `${t.length === 1 ? t[0]!.key : `${t.length} issues`} marked duplicate`);
  }, [targets, anchorEl, editors, cur, peek, router, toggle, cursor]);

  useRegisterActions(
    `list:${mode}`,
    [
      { id: "state", label: "Set state", group: "Issue", keys: "s" },
      { id: "priority", label: "Set priority", group: "Issue", keys: "p" },
      { id: "assignee", label: "Assign to", group: "Issue", keys: "a" },
      { id: "project", label: "Set project", group: "Issue" },
      { id: "cycle", label: "Set cycle", group: "Issue" },
      { id: "edit", label: "Edit title", group: "Issue", keys: "e" },
      { id: "peek", label: "Peek issue", group: "Issue", keys: "Space" },
      { id: "select", label: "Select issue", group: "Issue", keys: "x" },
      { id: "open", label: "Open issue", group: "Issue", keys: "Enter" },
      ...(mode === "triage"
        ? [
            { id: "accept", label: "Accept to Backlog", group: "Triage", keys: "a" },
            { id: "accept-todo", label: "Accept to Todo", group: "Triage", keys: "m" },
            { id: "decline", label: "Decline", group: "Triage", keys: "d" },
            { id: "duplicate", label: "Mark duplicate", group: "Triage", keys: "u" },
          ]
        : []),
    ],
    (id) => setTimeout(() => act(id), 0),
  );

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (isTypingTarget(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      const k = e.key;
      const last = flat.length - 1;
      const move = (to: number, extend: boolean) => {
        const next = Math.max(0, Math.min(to, last));
        e.preventDefault();
        setCursor(next);
        if (extend) {
          setSelected((s) => new Set([...s, flat[cursor]!.key, flat[next]!.key]));
        }
      };
      if (k === "j" || k === "ArrowDown" || k === "J") return move(cursor + 1, e.shiftKey);
      if (k === "k" || k === "ArrowUp" || k === "K") return move(cursor - 1, e.shiftKey);
      if (k === "Home") return move(0, false);
      if (k === "End") return move(last, false);
      if (k === "Escape") {
        if (peek.key) peek.close();
        else if (selected.size) setSelected(new Set());
        return;
      }
      const map: Record<string, string> = {
        x: "select", " ": "peek", Enter: "open", s: "state", p: "priority", e: "edit",
        ...(mode === "triage" ? { a: "accept", m: "accept-todo", d: "decline", u: "duplicate" } : { a: "assignee" }),
      };
      const id = map[k];
      if (id) {
        // Enter on a focused link/button keeps its native behaviour
        if (k === "Enter" && e.target instanceof HTMLElement && ["A", "BUTTON"].includes(e.target.tagName)) return;
        if (k === " " && e.target instanceof HTMLElement && e.target.tagName === "BUTTON") return;
        e.preventDefault();
        act(id);
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [flat, cursor, act, mode, peek, selected]);

  async function loadMore() {
    if (!more) return;
    const q = `${apiQuery(filters, meta.userId)}&cursor=${encodeURIComponent(more)}`;
    const res = await fetch(`/api/issues?${q}`, { cache: "no-store" });
    if (!res.ok) return;
    const body = (await res.json()) as { issues: ListIssue[]; nextCursor: string | null };
    setExtra((e) => [...e, ...body.issues]);
    setMore(body.nextCursor);
  }

  const rowH = DENSITY[density] ?? 36;
  let idx = 0;
  const renderRow = (issue: ListIssue) => {
    const i = idx++;
    return (
      <Row
        key={issue.key}
        issue={issue}
        index={i}
        isCursor={i === cursor}
        isSelected={selected.has(issue.key)}
        anySelected={selected.size > 0}
        editing={editing === issue.key}
        onEditDone={() => setEditing(null)}
        onCursor={() => setCursor(i)}
        onToggle={(range) => toggle(issue.key, i, range)}
        names={names}
        editors={editors}
        peekOpen={peek.key === issue.key}
        onPeek={() => { setCursor(i); peek.toggle(issue.key); }}
      />
    );
  };

  if (flat.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center px-8 py-12 text-center">
        <p className="text-[14px] font-medium text-ink">No issues match</p>
        <p className="mt-1 max-w-sm text-[13px] text-ink-subtle">Nothing here yet for these filters. Clear a filter, or press <Kbd>c</Kbd> to create an issue.</p>
        {emptyAction}
      </div>
    );
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col" style={{ ["--row-h" as string]: `${rowH}px` }}>
      <NewPill count={live.count} onShow={() => { live.reset(); router.refresh(); }} />
      <div ref={listRef} className="scroll-quiet min-h-0 flex-1 overflow-y-auto" data-issue-list>
        {groups
          ? groups.map((g) => (
              <section key={g.key} aria-label={g.label}>
                <div className="sticky top-0 z-[1] flex h-7 items-center gap-2 border-b border-lining-faint bg-surface-1 px-4 text-[12px] font-medium text-ink-muted">
                  {g.label}<span className="tabular-nums text-ink-subtle">{g.issues.length}</span>
                </div>
                <div role="list" aria-label={g.label}>{g.issues.map(renderRow)}</div>
              </section>
            ))
          : <div role="list" aria-label="Issues">{flat.map(renderRow)}</div>}
        {more && (
          <div className="flex justify-center p-3">
            <button type="button" onClick={() => void loadMore()} className="h-8 rounded-sm border border-control px-3 text-[13px] text-ink-muted hover:bg-surface-2">Load more issues</button>
          </div>
        )}
      </div>
      {selected.size > 0 && (
        <div role="toolbar" aria-label="Bulk actions" className="absolute inset-x-0 bottom-10 z-10 flex justify-center px-2">
          <div className="flex items-center gap-1 rounded-md border border-lining-strong bg-surface-3 p-1 max-sm:flex-wrap">
            <span className="px-2 text-[13px] font-medium tabular-nums text-ink">{selected.size} selected</span>
            {[["State", "state"], ["Priority", "priority"], ["Assignee", "assignee"], ["Project", "project"]].map(([l, id]) => (
              <button key={id} type="button" onClick={(e) => { const t = flat.filter((x) => selected.has(x.key)).map(like); const a = e.currentTarget; if (id === "state") editors.pickState(a, t); else if (id === "priority") editors.pickPriority(a, t); else if (id === "assignee") editors.pickAssignee(a, t); else editors.pickProject(a, t); }} className="h-7 rounded-sm px-2 text-[13px] text-ink-muted hover:bg-surface-4 hover:text-ink">{l}</button>
            ))}
            <button type="button" onClick={() => setSelected(new Set())} className="h-7 rounded-sm px-2 text-[13px] text-ink-subtle hover:bg-surface-4">Clear <Kbd>Esc</Kbd></button>
          </div>
        </div>
      )}
      <footer className="flex h-8 shrink-0 items-center gap-4 overflow-hidden border-t border-lining-faint px-4 text-[11px] text-ink-subtle max-sm:hidden">
        <span><Kbd>j</Kbd> <Kbd>k</Kbd> move</span>
        <span><Kbd>x</Kbd> select</span>
        <span><Kbd>Space</Kbd> peek</span>
        <span><Kbd>s</Kbd> state</span>
        <span><Kbd>p</Kbd> priority</span>
        {mode === "triage" ? (<><span className="text-ink-muted"><Kbd>a</Kbd> accept</span><span><Kbd>m</Kbd> to todo</span><span><Kbd>d</Kbd> decline</span></>) : <span><Kbd>a</Kbd> assign</span>}
        <span><Kbd>c</Kbd> create</span>
        <span className="ml-auto"><Kbd>?</Kbd> all shortcuts</span>
      </footer>
    </div>
  );
}

function Row({
  issue, index, isCursor, isSelected, anySelected, editing, onEditDone, onCursor, onToggle, names, editors, peekOpen, onPeek,
}: {
  issue: ListIssue; index: number; isCursor: boolean; isSelected: boolean; anySelected: boolean; editing: boolean;
  onEditDone: () => void; onCursor: () => void; onToggle: (range: boolean) => void;
  names: ReturnType<typeof useNames>; editors: ReturnType<typeof useIssueEditors>; peekOpen: boolean; onPeek: () => void;
}) {
  const m = useMerged(issue);
  const like: IssueLike = { ...m, assigneeType: m.assigneeType ?? null, assigneeId: m.assigneeId ?? null };
  const assignee = names.assignee(m.assigneeType, m.assigneeId);
  const agentFiled = m.creatorType === "agent";
  const tab = isCursor ? 0 : -1;
  const ctl = "flex h-6 w-6 shrink-0 items-center justify-center rounded-xs hover:bg-surface-3 max-sm:h-8 max-sm:w-8";
  return (
    <div
      role="listitem"
      data-issue-row
      data-index={index}
      data-cursor={isCursor}
      data-key={issue.key}
      onMouseMove={onCursor}
      style={{ height: "var(--row-h)", contentVisibility: "auto", containIntrinsicSize: "auto 36px" }}
      className={`group flex items-center max-sm:!h-auto max-sm:min-h-[52px] max-sm:py-1 gap-1.5 border-b border-lining-faint border-l-2 pl-2 pr-3 text-[13px] ${isSelected ? "border-l-accent bg-surface-2" : "border-l-transparent"} ${isCursor && !isSelected ? "bg-surface-2" : ""} ${peekOpen ? "bg-surface-3" : ""}`}
    >
      <button
        type="button" role="checkbox" aria-checked={isSelected} aria-label={`Select ${issue.key}`} tabIndex={tab}
        onClick={(e) => onToggle(e.shiftKey)}
        className={`${ctl} ${!(isSelected || anySelected) ? "max-sm:hidden" : ""} ${isSelected || anySelected || isCursor ? "opacity-100" : "opacity-0 focus-visible:opacity-100 group-hover:opacity-100"}`}
      >
        <span className={`flex h-3.5 w-3.5 items-center justify-center rounded-xs border ${isSelected ? "border-accent bg-accent text-on-accent" : "border-control"}`}>
          {isSelected && <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden><path d="M2 5.3l2 2 4-4.3" /></svg>}
        </span>
      </button>
      <button type="button" tabIndex={tab} className={ctl} onClick={(e) => editors.pickPriority(e.currentTarget, [like])} aria-label={`Priority ${PRIORITY_LABEL[m.priority]}, change`}>
        <PriorityGlyph priority={m.priority} />
      </button>
      <span className="hidden w-[68px] shrink-0 font-mono text-[12px] text-ink-subtle sm:inline">{issue.key}</span>
      <button type="button" tabIndex={tab} className={ctl} onClick={(e) => editors.pickState(e.currentTarget, [like])} aria-label={`State ${STATE_LABEL[m.state]}, change`}>
        <StateGlyph state={m.state} labelled={false} />
      </button>
      {editing ? (
        <input
          autoFocus defaultValue={m.title} aria-label={`Title of ${issue.key}`}
          onBlur={onEditDone}
          onKeyDown={(e) => {
            if (e.key === "Enter") { const v = e.currentTarget.value.trim(); if (v && v !== m.title) editors.setTitle(like, v); onEditDone(); }
            else if (e.key === "Escape") { e.stopPropagation(); onEditDone(); }
          }}
          className="h-7 min-w-0 flex-1 rounded-xs border border-control bg-surface-1 px-1.5 text-[13px] text-ink"
        />
      ) : (
        <Link href={`/issues/${issue.key}`} data-title-link tabIndex={tab} title={m.title} className="min-w-0 flex-1 truncate text-ink max-sm:whitespace-normal max-sm:[display:-webkit-box] max-sm:[-webkit-box-orient:vertical] max-sm:[-webkit-line-clamp:2]">
          <span className="font-mono text-[12px] text-ink-subtle sm:hidden">{issue.key} </span>{m.title}
        </Link>
      )}
      {agentFiled && <span title={`Filed by ${names.actor("agent", issue.creatorId)}`}><Glint size={12} label={`Filed by agent ${names.actor("agent", issue.creatorId)}`} /></span>}
      <button type="button" tabIndex={tab} onClick={onPeek} aria-label={`Peek ${issue.key}`} aria-pressed={peekOpen} className={`${ctl} text-ink-subtle opacity-0 focus-visible:opacity-100 group-hover:opacity-100 max-sm:hidden`}>
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden><rect x="1.5" y="2.5" width="11" height="9" rx="1.5" /><path d="M8.5 2.5v9" /></svg>
      </button>
      <button type="button" tabIndex={tab} className={ctl} onClick={(e) => editors.pickAssignee(e.currentTarget, [like])} aria-label={`Assignee ${assignee ?? "none"}, change`}>
        <Assignee type={m.assigneeType} name={assignee} />
      </button>
      <time className="hidden w-9 shrink-0 text-right text-[12px] tabular-nums text-ink-subtle md:inline" dateTime={issue.updatedAt} title={issue.updatedAt ? new Date(issue.updatedAt).toLocaleString() : undefined} suppressHydrationWarning>
        {issue.updatedAt ? relTime(issue.updatedAt) : ""}
      </time>
    </div>
  );
}
