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
import { type CSSProperties, useEffect, useRef, useState } from "react";
import type { ListIssue } from "@/components/issue-list-client";
import { Sparkle, StateDot } from "@/components/primitives";

type BoardState = (typeof ACTIVE_STATES)[number];

const COLUMN_LABEL: Record<BoardState, string> = {
  triage: "Triage",
  backlog: "Backlog",
  todo: "Todo",
  in_progress: "In Progress",
  in_review: "In Review",
};

const PRIORITY_BADGE: Partial<Record<ListIssue["priority"], string>> = {
  urgent: "text-urgent",
  high: "text-attention",
};

interface DragInfo {
  key: string;
  from: IssueState;
  colIndex: number;
  reachable: ReadonlySet<BoardState>;
}

function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  return (
    el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName)
  );
}

function CardFace({ issue, busy = false }: { issue: ListIssue; busy?: boolean }) {
  const agentTouched =
    issue.creatorType === "agent" || issue.assigneeType === "agent";
  return (
    <>
      <span className="flex items-center gap-2">
        <span className="font-mono text-[11px] text-ink-tertiary">
          {issue.key}
        </span>
        {agentTouched && <Sparkle size={12} />}
        {busy ? (
          <span className="ml-auto font-mono text-[11px] text-ink-tertiary">
            …
          </span>
        ) : issue.priority !== "none" ? (
          <span
            className={`ml-auto font-mono text-[11px] ${PRIORITY_BADGE[issue.priority] ?? "text-ink-tertiary"}`}
          >
            {issue.priority}
          </span>
        ) : null}
      </span>
      <span className="mt-1 line-clamp-2 text-left text-[13px] leading-snug text-ink-muted">
        {issue.title}
      </span>
    </>
  );
}

function BoardCard({
  issue,
  isCursor,
  busy,
  onOpen,
  onHover,
  onFocusCard,
}: {
  issue: ListIssue;
  isCursor: boolean;
  busy: boolean;
  onOpen: (key: string) => void;
  onHover: (key: string) => void;
  onFocusCard: (key: string) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } =
    useDraggable({
      id: issue.key,
      disabled: busy,
      attributes: {
        roleDescription: "issue card",
        tabIndex: isCursor ? 0 : -1,
      },
    });
  const style: CSSProperties = {
    transform: CSS.Translate.toString(transform),
  };
  return (
    <button
      ref={setNodeRef}
      type="button"
      {...attributes}
      {...listeners}
      data-board-card={issue.key}
      onClick={() => onOpen(issue.key)}
      onMouseEnter={() => onHover(issue.key)}
      onFocus={() => onFocusCard(issue.key)}
      style={style}
      className={`w-full touch-none rounded-md border bg-surface-1 p-3 focus-visible:outline-2 focus-visible:outline-accent ${
        isDragging ? "opacity-40" : ""
      } ${isCursor ? "border-accent" : "border-lining"}`}
    >
      <CardFace issue={issue} busy={busy} />
    </button>
  );
}

function BoardColumn({
  state,
  cards,
  dragging,
  reachable,
  cursor,
  pending,
  onOpen,
  onHover,
  onFocusCard,
}: {
  state: BoardState;
  cards: ListIssue[];
  dragging: boolean;
  reachable: boolean;
  cursor: string | null;
  pending: ReadonlySet<string>;
  onOpen: (key: string) => void;
  onHover: (key: string) => void;
  onFocusCard: (key: string) => void;
}) {
  const blocked = dragging && !reachable;
  const { isOver, setNodeRef } = useDroppable({ id: state, disabled: blocked });
  return (
    <section
      ref={setNodeRef}
      aria-label={`${COLUMN_LABEL[state]} column`}
      className={`flex w-[300px] shrink-0 flex-col rounded-lg border transition-colors ${
        isOver
          ? "border-accent bg-surface-1"
          : blocked
            ? "border-transparent opacity-40"
            : "border-lining-faint"
      }`}
    >
      <header className="flex h-9 shrink-0 items-center gap-2 border-b border-lining-faint px-3">
        <StateDot state={state} />
        <span className="font-mono text-[11px] uppercase tracking-wider text-ink-subtle">
          {COLUMN_LABEL[state]}
        </span>
        <span className="ml-auto font-mono text-[11px] text-ink-tertiary">
          {cards.length}
        </span>
      </header>
      <div className="flex min-h-24 flex-1 flex-col gap-2 overflow-y-auto p-2">
        {cards.map((issue) => (
          <BoardCard
            key={issue.key}
            issue={issue}
            isCursor={cursor === issue.key}
            busy={pending.has(issue.key)}
            onOpen={onOpen}
            onHover={onHover}
            onFocusCard={onFocusCard}
          />
        ))}
      </div>
    </section>
  );
}

const announcements: Announcements = {
  onDragStart: ({ active }) =>
    `Picked up ${String(active.id)} — left and right arrows move between columns, space drops, escape cancels`,
  onDragOver: ({ active, over }) =>
    over
      ? `${String(active.id)} is over ${String(over.id).replace("_", " ")}`
      : `${String(active.id)} is not over a column`,
  onDragEnd: ({ active, over }) =>
    over
      ? `${String(active.id)} dropped on ${String(over.id).replace("_", " ")}`
      : `${String(active.id)} dropped — no column change`,
  onDragCancel: ({ active }) => `Move cancelled — ${String(active.id)} returned`,
};

export function BoardClient({ issues }: { issues: ListIssue[] }) {
  const router = useRouter();
  // Optimistic column membership: key -> state the server is being asked for.
  const [overrides, setOverrides] = useState<Readonly<Record<string, IssueState>>>({});
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [drag, setDrag] = useState<DragInfo | null>(null);
  const dragRef = useRef<DragInfo | null>(null);
  const pendingRef = useRef<Set<string>>(new Set());
  const lastDragEndRef = useRef(0);
  const kbdNavRef = useRef(false);

  const displayed = issues.map((issue) => {
    const state = overrides[issue.key];
    return state ? { ...issue, state } : issue;
  });
  const columns: Record<BoardState, ListIssue[]> = {
    triage: [],
    backlog: [],
    todo: [],
    in_progress: [],
    in_review: [],
  };
  for (const issue of displayed) {
    if (issue.state in columns) columns[issue.state as BoardState].push(issue);
  }

  // Server truth arrives via router.refresh() — drop optimistic overrides,
  // keeping only ones still in flight (their PATCH chain hasn't settled).
  useEffect(() => {
    if (dragRef.current) return;
    setOverrides((m) => {
      const next = Object.fromEntries(
        Object.entries(m).filter(([key]) => pendingRef.current.has(key)),
      );
      return Object.keys(next).length === Object.keys(m).length ? m : next;
    });
  }, [issues]);

  // The API enforces single-step transitions, so multi-column moves walk the
  // BFS path and PATCH each hop. On failure the card reverts to the last
  // confirmed state — which is where the server actually has it.
  async function move(key: string, target: BoardState) {
    const issue = displayed.find((i) => i.key === key);
    if (!issue || pendingRef.current.has(key) || issue.state === target) return;
    const path = findPath(issue.state, target);
    if (!path || path.length === 0) return;
    setError(null);
    setOverrides((m) => ({ ...m, [key]: target }));
    pendingRef.current.add(key);
    setPending(new Set(pendingRef.current));
    let confirmed: IssueState | null = null;
    let ok = true;
    for (const step of path) {
      const res = await fetch(`/api/issues/${key}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ state: step }),
      });
      if (!res.ok) {
        ok = false;
        break;
      }
      confirmed = step;
    }
    const settled = confirmed;
    if (!ok) {
      setOverrides((m) => ({ ...m, [key]: settled ?? issue.state }));
      setError(
        settled
          ? `${key} stopped at ${settled.replace("_", " ")} — ${COLUMN_LABEL[target]} rejected`
          : `${key} move to ${COLUMN_LABEL[target]} rejected — reverted`,
      );
    }
    pendingRef.current.delete(key);
    setPending(new Set(pendingRef.current));
    router.refresh();
  }

  function cursorPos(): { state: BoardState; idx: number } | null {
    for (const state of ACTIVE_STATES) {
      const idx = columns[state].findIndex((i) => i.key === cursor);
      if (idx >= 0) return { state, idx };
    }
    for (const state of ACTIVE_STATES) {
      if (columns[state].length > 0) return { state, idx: 0 };
    }
    return null;
  }

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
    const start = ACTIVE_STATES.indexOf(pos.state);
    for (let i = start + dir; i >= 0 && i < ACTIVE_STATES.length; i += dir) {
      const state = ACTIVE_STATES[i];
      if (!state) break;
      const target = columns[state];
      if (target.length > 0) {
        const next = target[Math.min(pos.idx, target.length - 1)];
        if (next) setCursor(next.key);
        return;
      }
    }
  }

  // Shift+arrow: move the cursor card one column, same path as a drop.
  function nudge(dir: 1 | -1) {
    const pos = cursorPos();
    if (!pos) return;
    const target = ACTIVE_STATES[ACTIVE_STATES.indexOf(pos.state) + dir];
    const issue = columns[pos.state][pos.idx];
    if (target && issue) void move(issue.key, target);
  }

  function open(key: string) {
    // A click lands right after a pointer drag ends — don't navigate on it.
    if (Date.now() - lastDragEndRef.current < 150) return;
    router.push(`/issues/${key}`);
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (
        e.defaultPrevented ||
        isTypingTarget(e.target) ||
        e.metaKey ||
        e.ctrlKey ||
        e.altKey ||
        dragRef.current
      ) {
        return;
      }
      const pos = cursorPos();
      switch (e.key) {
        case "j":
        case "ArrowDown":
          if (!pos) break;
          e.preventDefault();
          kbdNavRef.current = true;
          moveCursorRow(1);
          break;
        case "k":
        case "ArrowUp":
          if (!pos) break;
          e.preventDefault();
          kbdNavRef.current = true;
          moveCursorRow(-1);
          break;
        case "h":
          if (!pos) break;
          e.preventDefault();
          kbdNavRef.current = true;
          moveCursorCol(-1);
          break;
        case "l":
          if (!pos) break;
          e.preventDefault();
          kbdNavRef.current = true;
          moveCursorCol(1);
          break;
        case "H":
          if (!pos) break;
          e.preventDefault();
          kbdNavRef.current = true;
          nudge(-1);
          break;
        case "L":
          if (!pos) break;
          e.preventDefault();
          kbdNavRef.current = true;
          nudge(1);
          break;
        case "ArrowLeft":
          if (!pos) break;
          e.preventDefault();
          kbdNavRef.current = true;
          if (e.shiftKey) nudge(-1);
          else moveCursorCol(-1);
          break;
        case "ArrowRight":
          if (!pos) break;
          e.preventDefault();
          kbdNavRef.current = true;
          if (e.shiftKey) nudge(1);
          else moveCursorCol(1);
          break;
        case "Enter": {
          if (!pos) break;
          // A focused card opens itself via native click — don't double-push.
          if (
            e.target instanceof HTMLElement &&
            e.target.dataset.boardCard !== undefined
          ) {
            break;
          }
          e.preventDefault();
          const issue = columns[pos.state][pos.idx];
          if (issue) router.push(`/issues/${issue.key}`);
          break;
        }
        case " ": {
          // Space on a focused card is the dnd grab (sensor already handled
          // it via defaultPrevented). On body, just stop the page scroll.
          if (pos) e.preventDefault();
          break;
        }
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  // Keep DOM focus on the cursor card so space/enter and the keyboard sensor
  // land on it. Only driven by keyboard nav — hover never steals focus.
  useEffect(() => {
    if (!kbdNavRef.current || dragRef.current || !cursor) return;
    const el = document.querySelector<HTMLElement>(
      `[data-board-card="${cursor}"]`,
    );
    el?.focus();
    el?.scrollIntoView({ block: "nearest", inline: "nearest" });
  });

  const columnCoordinateGetter: KeyboardCoordinateGetter = (
    event,
    { currentCoordinates, context },
  ) => {
    const info = dragRef.current;
    if (!info) return undefined;
    const dir =
      event.code === "ArrowRight" ? 1 : event.code === "ArrowLeft" ? -1 : 0;
    if (dir === 0) return undefined;
    const width = context.draggingNodeRect?.width ?? 0;
    const cx = currentCoordinates.x + width / 2;
    const cur = ACTIVE_STATES.findIndex((s) => {
      const r = context.droppableRects.get(s);
      return r !== undefined && cx >= r.left && cx <= r.right;
    });
    for (
      let i = (cur < 0 ? info.colIndex : cur) + dir;
      i >= 0 && i < ACTIVE_STATES.length;
      i += dir
    ) {
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
    useSensor(KeyboardSensor, {
      coordinateGetter: columnCoordinateGetter,
      keyboardCodes: {
        start: ["Space"],
        cancel: ["Escape"],
        end: ["Space", "Enter"],
      },
    }),
  );

  function onDragStart(e: DragStartEvent) {
    const key = String(e.active.id);
    const issue = displayed.find((i) => i.key === key);
    if (!issue) return;
    const from = issue.state;
    // Drop targets = columns reachable under the state machine, plus the
    // card's own column so dropping back home is a clean no-op.
    const reachable = new Set(
      ACTIVE_STATES.filter(
        (s) => s === from || findPath(from, s) !== null,
      ),
    );
    const info: DragInfo = {
      key,
      from,
      colIndex: ACTIVE_STATES.indexOf(from as BoardState),
      reachable,
    };
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
    if (
      info &&
      typeof over === "string" &&
      (ACTIVE_STATES as readonly string[]).includes(over)
    ) {
      const target = over as BoardState;
      if (target !== info.from && info.reachable.has(target)) {
        void move(info.key, target);
      }
    }
  }

  function onDragCancel() {
    lastDragEndRef.current = Date.now();
    dragRef.current = null;
    setDrag(null);
  }

  const dragIssue = drag
    ? (displayed.find((i) => i.key === drag.key) ?? null)
    : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <DndContext
        id="board-dnd"
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onDragCancel={onDragCancel}
        accessibility={{ announcements }}
      >
        <div
          className="flex min-h-0 flex-1 gap-3 overflow-x-auto p-4 focus-visible:outline-2 focus-visible:outline-accent"
          aria-busy={pending.size > 0}
          tabIndex={0}
        >
          {ACTIVE_STATES.map((state) => (
            <BoardColumn
              key={state}
              state={state}
              cards={columns[state]}
              dragging={drag !== null}
              reachable={drag?.reachable.has(state) ?? false}
              cursor={cursor}
              pending={pending}
              onOpen={open}
              onHover={(key) => {
                kbdNavRef.current = false;
                setCursor(key);
              }}
              onFocusCard={setCursor}
            />
          ))}
        </div>
        <DragOverlay>
          {dragIssue ? (
            <div className="w-[284px] rounded-md border border-accent bg-surface-2 p-3">
              <CardFace issue={dragIssue} />
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>
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
          <kbd>j</kbd>/<kbd>k</kbd>/<kbd>h</kbd>/<kbd>l</kbd> cursor
        </span>
        <span>
          <kbd>⇧←</kbd>/<kbd>⇧→</kbd> move card
        </span>
        <span>
          <kbd>space</kbd> grab
        </span>
        <span>
          <kbd>⏎</kbd> open
        </span>
        <span>
          <kbd>c</kbd> create
        </span>
        {pending.size > 0 && <span className="ml-auto">saving…</span>}
      </footer>
    </div>
  );
}
