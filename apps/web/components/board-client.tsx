"use client";

import {
  type Announcements,
  closestCenter,
  DndContext,
  DragOverlay,
  type DragEndEvent,
  type DragStartEvent,
  KeyboardSensor,
  type KeyboardCoordinateGetter,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import { ACTIVE_STATES, findPath, type IssueState } from "@tallyline/types";
import { useRouter } from "next/navigation";
import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRegisterActions } from "@/components/app/actions";
import { useIssueEdit, useOverrides } from "@/components/app/issue-store";
import { NewPill, useLiveCount } from "@/components/app/live";
import { type IssueLike, useIssueEditors } from "@/components/app/pickers";
import { useNames, usePeek } from "@/components/app/providers";
import { Assignee, Glint, Kbd, PriorityGlyph, StateGlyph } from "@/components/app/ui";
import type { ListIssue } from "@/components/issue-list-client";
import { STATE_LABEL } from "@/lib/format";

type BoardState = (typeof ACTIVE_STATES)[number];
const CAP = 40; // cards rendered per column before "Show more" (keeps 1000+ issue boards fast)

interface DragInfo {
  key: string;
  from: IssueState;
  colIndex: number;
  reachable: ReadonlySet<BoardState>;
}

function isTypingTarget(el: EventTarget | null): boolean {
  return el instanceof HTMLElement && (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName));
}

function CardFace({ issue, names }: { issue: ListIssue; names: ReturnType<typeof useNames> }) {
  const assignee = names.assignee(issue.assigneeType, issue.assigneeId);
  const filedBy = issue.creatorType === "agent" ? names.actor("agent", issue.creatorId) : null;
  return (
    <>
      <span className="flex items-center gap-2">
        <PriorityGlyph priority={issue.priority} />
        <span className="font-mono text-[12px] text-ink-subtle">{issue.key}</span>
        {filedBy && <span title={`Filed by ${filedBy}`}><Glint size={12} label={`Filed by agent ${filedBy}`} /></span>}
        <span className="ml-auto"><Assignee type={issue.assigneeType} name={assignee} /></span>
      </span>
      <span className="mt-1.5 line-clamp-2 text-left text-[13px] leading-snug text-ink">{issue.title}</span>
    </>
  );
}

function BoardCard({
  issue, isCursor, names, onOpen, onHover, onFocusCard,
}: {
  issue: ListIssue; isCursor: boolean; names: ReturnType<typeof useNames>;
  onOpen: (key: string) => void; onHover: (key: string) => void; onFocusCard: (key: string) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: issue.key,
    attributes: { roleDescription: "issue card", tabIndex: isCursor ? 0 : -1 },
  });
  const style: CSSProperties = { transform: CSS.Translate.toString(transform), contentVisibility: "auto", containIntrinsicSize: "auto 76px" };
  return (
    <button
      ref={setNodeRef}
      type="button"
      {...attributes}
      {...listeners}
      data-board-card={issue.key}
      data-cursor={isCursor}
      onClick={() => onOpen(issue.key)}
      onMouseEnter={() => onHover(issue.key)}
      onFocus={() => onFocusCard(issue.key)}
      style={style}
      className={`w-full touch-none rounded-md border p-3 text-left ${isDragging ? "opacity-40" : ""} ${isCursor ? "border-lining-strong bg-surface-2" : "border-lining bg-surface-1 hover:bg-surface-2"}`}
    >
      <CardFace issue={issue} names={names} />
    </button>
  );
}

function BoardColumn({
  state, cards, dragging, reachable, cursor, names, onOpen, onHover, onFocusCard,
}: {
  state: BoardState; cards: ListIssue[]; dragging: boolean; reachable: boolean; cursor: string | null;
  names: ReturnType<typeof useNames>;
  onOpen: (key: string) => void; onHover: (key: string) => void; onFocusCard: (key: string) => void;
}) {
  const blocked = dragging && !reachable;
  const { isOver, setNodeRef } = useDroppable({ id: state, disabled: blocked });
  const [shown, setShown] = useState(CAP);
  const collapsed = cards.length === 0; // never resize mid-drag: dnd-kit measured the rects at drag start
  return (
    <section
      ref={setNodeRef}
      id={`col-${state}`}
      aria-label={`${STATE_LABEL[state]} column`}
      data-collapsed={collapsed}
      className={`flex shrink-0 flex-col rounded-lg border ${collapsed ? "w-11" : "w-[272px]"} ${isOver ? "border-lining-bright bg-surface-1" : blocked ? "border-transparent opacity-40" : "border-lining-faint"}`}
    >
      {collapsed ? (
        <div className="flex h-full flex-col items-center gap-2 py-3 text-ink-subtle">
          <StateGlyph state={state} labelled={false} />
          <span className="text-[12px] [writing-mode:vertical-rl]">{STATE_LABEL[state]} · 0</span>
        </div>
      ) : (
        <>
          <header className="flex h-9 shrink-0 items-center gap-2 border-b border-lining-faint px-3">
            <StateGlyph state={state} labelled={false} />
            <h2 className="text-[13px] font-medium text-ink">{STATE_LABEL[state]}</h2>
            <span className="ml-auto text-[12px] tabular-nums text-ink-subtle">{cards.length}</span>
          </header>
          <div role="group" aria-label={`${STATE_LABEL[state]} cards`} tabIndex={0} className="scroll-quiet flex min-h-24 flex-1 flex-col gap-2 overflow-y-auto p-2">
            {cards.slice(0, shown).map((issue) => (
              <BoardCard key={issue.key} issue={issue} isCursor={cursor === issue.key} names={names} onOpen={onOpen} onHover={onHover} onFocusCard={onFocusCard} />
            ))}
            {cards.length > shown && (
              <button type="button" onClick={() => setShown((n) => n + CAP)} className="h-8 shrink-0 rounded-sm text-[12px] text-ink-muted hover:bg-surface-2">Show {Math.min(CAP, cards.length - shown)} more</button>
            )}
            {cards.length === 0 && <p className="px-2 py-4 text-center text-[12px] text-ink-subtle">Drop an issue here</p>}
          </div>
        </>
      )}
    </section>
  );
}

const announcements: Announcements = {
  onDragStart: ({ active }) => `Picked up ${String(active.id)}. Left and right arrows move between columns, space drops, escape cancels`,
  onDragOver: ({ active, over }) => (over ? `${String(active.id)} is over ${STATE_LABEL[String(over.id)] ?? String(over.id)}` : `${String(active.id)} is not over a column`),
  onDragEnd: ({ active, over }) => (over ? `${String(active.id)} dropped on ${STATE_LABEL[String(over.id)] ?? String(over.id)}` : `${String(active.id)} dropped, no column change`),
  onDragCancel: ({ active }) => `Move cancelled, ${String(active.id)} returned`,
};

export function BoardClient({ issues }: { issues: ListIssue[] }) {
  const router = useRouter();
  const names = useNames();
  const peek = usePeek();
  const overrides = useOverrides();
  const apply = useIssueEdit();
  const editors = useIssueEditors();
  const live = useLiveCount();
  const [cursor, setCursor] = useState<string | null>(null);
  const [drag, setDrag] = useState<DragInfo | null>(null);
  const [edges, setEdges] = useState({ left: false, right: false });
  const dragRef = useRef<DragInfo | null>(null);
  const lastDragEndRef = useRef(0);
  const kbdNavRef = useRef(false);
  const scroller = useRef<HTMLDivElement>(null);

  const displayed = useMemo(
    () => issues.map((issue) => {
      const o = overrides[issue.key];
      return o ? { ...issue, ...o } : issue;
    }),
    [issues, overrides],
  );
  const columns = useMemo(() => {
    const c: Record<BoardState, ListIssue[]> = { triage: [], backlog: [], todo: [], in_progress: [], in_review: [] };
    for (const issue of displayed) if (issue.state in c) c[issue.state as BoardState].push(issue);
    return c;
  }, [displayed]);

  const updateEdges = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    setEdges({ left: el.scrollLeft > 4, right: el.scrollLeft + el.clientWidth < el.scrollWidth - 4 });
  }, []);
  useEffect(() => {
    updateEdges();
    const el = scroller.current;
    const ro = new ResizeObserver(updateEdges);
    if (el) ro.observe(el);
    window.addEventListener("resize", updateEdges);
    return () => { ro.disconnect(); window.removeEventListener("resize", updateEdges); };
  }, [updateEdges, displayed.length]);

  const move = useCallback((key: string, target: BoardState) => {
    const issue = displayed.find((i) => i.key === key);
    if (!issue || issue.state === target || !findPath(issue.state, target)) return;
    void apply([{ key, patch: { state: target }, prior: { state: issue.state } }], `${key} → ${STATE_LABEL[target]}`);
  }, [displayed, apply]);

  function cursorPos(): { state: BoardState; idx: number } | null {
    for (const state of ACTIVE_STATES) {
      const idx = columns[state].findIndex((i) => i.key === cursor);
      if (idx >= 0) return { state, idx };
    }
    for (const state of ACTIVE_STATES) if (columns[state].length > 0) return { state, idx: 0 };
    return null;
  }
  const cur = (() => { const p = cursorPos(); return p ? columns[p.state][p.idx] : undefined; })();

  function moveCursorRow(dir: 1 | -1) {
    const pos = cursorPos();
    if (!pos) return;
    const list = columns[pos.state];
    const next = list[Math.min(Math.max(pos.idx + dir, 0), list.length - 1)];
    if (next) setCursor(next.key);
  }
  function moveCursorCol(dir: 1 | -1) {
    const pos = cursorPos();
    if (!pos) return;
    for (let i = ACTIVE_STATES.indexOf(pos.state) + dir; i >= 0 && i < ACTIVE_STATES.length; i += dir) {
      const target = columns[ACTIVE_STATES[i]!];
      if (target.length > 0) {
        const next = target[Math.min(pos.idx, target.length - 1)];
        if (next) setCursor(next.key);
        return;
      }
    }
  }
  function nudge(dir: 1 | -1) {
    const pos = cursorPos();
    if (!pos) return;
    const target = ACTIVE_STATES[ACTIVE_STATES.indexOf(pos.state) + dir];
    const issue = columns[pos.state][pos.idx];
    if (target && issue) move(issue.key, target);
  }
  function open(key: string) {
    if (Date.now() - lastDragEndRef.current < 150) return; // click right after a drag
    router.push(`/issues/${key}`);
  }

  const like = (i: ListIssue): IssueLike => ({ ...i, assigneeType: i.assigneeType ?? null, assigneeId: i.assigneeId ?? null });
  const anchor = () => document.querySelector<HTMLElement>(`[data-board-card="${cur?.key}"]`) ?? scroller.current!;
  const act = useCallback((id: string) => {
    if (!cur) return;
    const a = anchor();
    if (id === "state") editors.pickState(a, [like(cur)]);
    else if (id === "priority") editors.pickPriority(a, [like(cur)]);
    else if (id === "assignee") editors.pickAssignee(a, [like(cur)]);
    else if (id === "peek") peek.toggle(cur.key);
    else if (id === "open") router.push(`/issues/${cur.key}`);
  }, [cur, editors, peek, router]);

  useRegisterActions(
    "board",
    [
      { id: "state", label: "Set state", group: "Issue", keys: "s" },
      { id: "priority", label: "Set priority", group: "Issue", keys: "p" },
      { id: "assignee", label: "Assign to", group: "Issue", keys: "a" },
      { id: "peek", label: "Peek issue", group: "Issue", keys: "Space" },
      { id: "open", label: "Open issue", group: "Issue", keys: "Enter" },
      { id: "move-left", label: "Move card to previous column", group: "Board", keys: "⇧←" },
      { id: "move-right", label: "Move card to next column", group: "Board", keys: "⇧→" },
      { id: "grab", label: "Grab card (keyboard drag)", group: "Board", keys: "m" },
    ],
    (id) => setTimeout(() => {
      if (id === "move-left") nudge(-1);
      else if (id === "move-right") nudge(1);
      else if (id === "grab") document.querySelector<HTMLElement>(`[data-board-card="${cur?.key}"]`)?.focus();
      else act(id);
    }, 0),
  );

  // peek follows the cursor card
  useEffect(() => {
    if (peek.key && cur && cur.key !== peek.key) peek.open(cur.key);
  }, [cur, peek]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.defaultPrevented || isTypingTarget(e.target) || e.metaKey || e.ctrlKey || e.altKey || dragRef.current) return;
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      const pos = cursorPos();
      const nav = (fn: () => void) => { if (!pos) return; e.preventDefault(); kbdNavRef.current = true; fn(); };
      switch (e.key) {
        case "j": case "ArrowDown": return nav(() => moveCursorRow(1));
        case "k": case "ArrowUp": return nav(() => moveCursorRow(-1));
        case "h": return nav(() => moveCursorCol(-1));
        case "l": return nav(() => moveCursorCol(1));
        case "H": return nav(() => nudge(-1));
        case "L": return nav(() => nudge(1));
        case "ArrowLeft": return nav(() => (e.shiftKey ? nudge(-1) : moveCursorCol(-1)));
        case "ArrowRight": return nav(() => (e.shiftKey ? nudge(1) : moveCursorCol(1)));
        case "Escape": if (peek.key) peek.close(); return;
        case "Enter":
          if (!pos || (e.target instanceof HTMLElement && e.target.dataset.boardCard !== undefined)) return;
          e.preventDefault();
          return act("open");
        case " ": if (pos) { e.preventDefault(); if (Date.now() - lastDragEndRef.current > 200) act("peek"); } return;
        case "s": if (pos) { e.preventDefault(); act("state"); } return;
        case "p": if (pos) { e.preventDefault(); act("priority"); } return;
        case "a": if (pos) { e.preventDefault(); act("assignee"); } return;
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  // keep DOM focus on the cursor card after keyboard nav (hover never steals focus)
  useEffect(() => {
    if (!kbdNavRef.current || dragRef.current || !cursor) return;
    const el = document.querySelector<HTMLElement>(`[data-board-card="${cursor}"]`);
    el?.focus();
    el?.scrollIntoView({ block: "nearest", inline: "nearest" });
  });

  const columnCoordinateGetter: KeyboardCoordinateGetter = (event, { currentCoordinates, context }) => {
    const info = dragRef.current;
    if (!info) return undefined;
    const dir = event.code === "ArrowRight" ? 1 : event.code === "ArrowLeft" ? -1 : 0;
    if (dir === 0) return undefined;
    const width = context.draggingNodeRect?.width ?? 0;
    const cx = currentCoordinates.x + width / 2;
    const curCol = ACTIVE_STATES.findIndex((s) => {
      const r = context.droppableRects.get(s);
      return r !== undefined && cx >= r.left && cx <= r.right;
    });
    for (let i = (curCol < 0 ? info.colIndex : curCol) + dir; i >= 0 && i < ACTIVE_STATES.length; i += dir) {
      const state = ACTIVE_STATES[i];
      if (!state || !info.reachable.has(state)) continue;
      const r = context.droppableRects.get(state);
      if (!r) continue;
      return { x: r.left + r.width / 2 - width / 2, y: r.top + 48 };
    }
    return undefined;
  };

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    // Space is peek (Silver Lining section 7), so keyboard grab is `m` (move)
    useSensor(KeyboardSensor, { coordinateGetter: columnCoordinateGetter, keyboardCodes: { start: ["KeyM"], cancel: ["Escape"], end: ["Space", "Enter"] } }),
  );

  function onDragStart(e: DragStartEvent) {
    const key = String(e.active.id);
    const issue = displayed.find((i) => i.key === key);
    if (!issue) return;
    const from = issue.state;
    const reachable = new Set(ACTIVE_STATES.filter((s) => s === from || findPath(from, s) !== null));
    const info: DragInfo = { key, from, colIndex: ACTIVE_STATES.indexOf(from as BoardState), reachable };
    dragRef.current = info;
    setDrag(info);
    setCursor(key);
  }
  function onDragEnd(e: DragEndEvent) {
    lastDragEndRef.current = Date.now();
    const info = dragRef.current;
    dragRef.current = null;
    setDrag(null);
    const over = e.over?.id;
    if (info && typeof over === "string" && (ACTIVE_STATES as readonly string[]).includes(over)) {
      const target = over as BoardState;
      if (target !== info.from && info.reachable.has(target)) move(info.key, target);
    }
  }
  function onDragCancel() {
    lastDragEndRef.current = Date.now();
    dragRef.current = null;
    setDrag(null);
  }
  const dragIssue = drag ? (displayed.find((i) => i.key === drag.key) ?? null) : null;

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <NewPill count={live.count} onShow={() => { live.reset(); router.refresh(); }} />
      <nav aria-label="Columns" className="flex h-9 shrink-0 items-center gap-1 overflow-x-auto border-b border-lining-faint px-4 text-[12px]">
        {ACTIVE_STATES.map((s) => (
          <button key={s} type="button" onClick={() => document.getElementById(`col-${s}`)?.scrollIntoView({ behavior: "auto", inline: "start", block: "nearest" })} className="flex h-7 shrink-0 items-center gap-1.5 rounded-sm px-2 text-ink-muted hover:bg-surface-2 hover:text-ink">
            <StateGlyph state={s} labelled={false} size={12} />{STATE_LABEL[s]}<span className="tabular-nums text-ink-subtle">{columns[s].length}</span>
          </button>
        ))}
      </nav>
      <DndContext id="board-dnd" sensors={sensors} collisionDetection={closestCenter} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={onDragCancel} accessibility={{ announcements }}>
        <div className="relative flex min-h-0 flex-1">
          <div ref={scroller} onScroll={updateEdges} className="scroll-quiet flex min-h-0 flex-1 gap-3 overflow-x-auto p-4" tabIndex={0} aria-label="Board columns">
            {ACTIVE_STATES.map((state) => (
              <BoardColumn
                key={state}
                state={state}
                cards={columns[state]}
                dragging={drag !== null}
                reachable={drag?.reachable.has(state) ?? false}
                cursor={cursor ?? cur?.key ?? null}
                names={names}
                onOpen={open}
                onHover={(key) => { kbdNavRef.current = false; setCursor(key); }}
                onFocusCard={setCursor}
              />
            ))}
          </div>
          {edges.left && <div aria-hidden className="pointer-events-none absolute inset-y-0 left-0 w-8 bg-gradient-to-r from-canvas to-transparent" />}
          {edges.right && <div aria-hidden className="pointer-events-none absolute inset-y-0 right-0 w-10 bg-gradient-to-l from-canvas to-transparent" />}
        </div>
        <DragOverlay>
          {dragIssue ? (
            <div className="w-[256px] rounded-md border border-lining-bright bg-surface-3 p-3"><CardFace issue={dragIssue} names={names} /></div>
          ) : null}
        </DragOverlay>
      </DndContext>
      <footer className="flex h-8 shrink-0 items-center gap-4 overflow-hidden border-t border-lining-faint px-4 text-[11px] text-ink-subtle max-sm:hidden">
        <span><Kbd>h</Kbd> <Kbd>j</Kbd> <Kbd>k</Kbd> <Kbd>l</Kbd> cursor</span>
        <span><Kbd>⇧←</Kbd> <Kbd>⇧→</Kbd> move card</span>
        <span><Kbd>m</Kbd> grab</span>
        <span><Kbd>Space</Kbd> peek</span>
        <span><Kbd>s</Kbd> state</span>
        <span><Kbd>p</Kbd> priority</span>
        <span><Kbd>a</Kbd> assign</span>
        <span><Kbd>c</Kbd> create</span>
        <span className="ml-auto"><Kbd>?</Kbd> all shortcuts</span>
      </footer>
    </div>
  );
}
