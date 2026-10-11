"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { EmptyState, Sparkle } from "@/components/primitives";

export interface FeedEvent {
  id: string;
  action: string;
  actorType: "human" | "agent" | "system";
  actorId: string | null;
  actorName: string | null;
  entityType: string;
  entityId: string;
  issueKey: string | null;
  issueTitle: string | null;
  before: unknown;
  after: unknown;
  createdAt: string;
}

type LiveStatus = "connecting" | "live" | "reconnecting" | "offline";

const STATUS_META: Record<LiveStatus, { dot: string; label: string }> = {
  connecting: { dot: "bg-neutral", label: "connecting…" },
  live: { dot: "bg-healthy", label: "live" },
  reconnecting: { dot: "bg-attention", label: "reconnecting…" },
  offline: { dot: "bg-neutral", label: "offline — polling" },
};

const FEED_CAP = 300;
const FALLBACK_POLL_MS = 10_000;

function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  return (
    el.isContentEditable ||
    ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName)
  );
}

function timeAgo(iso: string, nowMs: number): string {
  const s = Math.max(0, (nowMs - new Date(iso).getTime()) / 1000);
  if (s < 10) return "now";
  if (s < 60) return `${Math.floor(s)}s`;
  const m = s / 60;
  if (m < 60) return `${Math.floor(m)}m`;
  const h = m / 60;
  if (h < 24) return `${Math.floor(h)}h`;
  const d = h / 24;
  if (d < 30) return `${Math.floor(d)}d`;
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

function afterState(e: FeedEvent): string | null {
  if (!e.after || typeof e.after !== "object") return null;
  const s = (e.after as Record<string, unknown>).state;
  return typeof s === "string" ? s.replace(/_/g, " ") : null;
}

function actionLabel(e: FeedEvent): string {
  switch (e.action) {
    case "created":
      return "created";
    case "commented":
      return "commented on";
    case "state_changed": {
      const to = afterState(e);
      return to ? `moved to ${to}` : "changed state";
    }
    default:
      return e.action.replace(/_/g, " ");
  }
}

export function ActivityFeed({
  initial,
  renderedAt,
}: {
  initial: FeedEvent[];
  /** server render time (ms): the first client render must use the same
   *  "now" as the SSR HTML or relative times ("56s" vs "57s") mismatch */
  renderedAt: number;
}) {
  const [now, setNow] = useState(renderedAt);
  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, []);
  const router = useRouter();
  const [events, setEvents] = useState<FeedEvent[]>(initial);
  const [status, setStatus] = useState<LiveStatus>("connecting");
  const [cursor, setCursor] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    let dead = false;
    let poll: ReturnType<typeof setInterval> | null = null;

    const merge = (incoming: FeedEvent[]) => {
      if (incoming.length === 0) return;
      setEvents((prev) => {
        const byId = new Map(prev.map((e) => [e.id, e]));
        for (const e of incoming) byId.set(e.id, e);
        return [...byId.values()]
          .sort((a, b) => Number(b.id) - Number(a.id))
          .slice(0, FEED_CAP);
      });
    };

    // Plain-fetch fallback for when the stream can't stay up (e.g. proxy
    // buffering or a hard 401 closes the EventSource for good).
    const startFallbackPoll = () => {
      if (poll || dead) return;
      setStatus("offline");
      poll = setInterval(() => {
        void fetch("/api/events?limit=100")
          .then(async (res) => {
            if (res.ok) {
              const body = (await res.json()) as { events?: FeedEvent[] };
              merge(body.events ?? []);
            }
          })
          .catch(() => undefined);
      }, FALLBACK_POLL_MS);
    };

    const es = new EventSource("/api/events/stream");
    es.onopen = () => setStatus("live");
    es.onmessage = (msg) => {
      try {
        merge([JSON.parse(msg.data as string) as FeedEvent]);
      } catch {
        // malformed frame — skip it
      }
    };
    es.onerror = () => {
      // EventSource retries on its own while CONNECTING; CLOSED is terminal
      // (non-2xx response) — fall back to polling the list endpoint.
      if (es.readyState === EventSource.CLOSED) {
        es.close();
        startFallbackPoll();
      } else {
        setStatus("reconnecting");
      }
    };

    return () => {
      dead = true;
      es.close();
      if (poll) clearInterval(poll);
    };
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (isTypingTarget(e.target) || e.metaKey || e.ctrlKey || e.altKey)
        return;
      const evt = events[cursor];
      switch (e.key) {
        case "j":
        case "ArrowDown":
          e.preventDefault();
          setCursor((c) => Math.min(c + 1, events.length - 1));
          break;
        case "k":
        case "ArrowUp":
          e.preventDefault();
          setCursor((c) => Math.max(c - 1, 0));
          break;
        case "Enter":
          if (evt?.issueKey) router.push(`/issues/${evt.issueKey}`);
          break;
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [cursor, events, router]);

  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-index="${cursor}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  if (events.length === 0) {
    return (
      <EmptyState
        title="No activity yet"
        detail="Workspace events — issue creates, state changes, comments — land here in real time."
      />
    );
  }

  const meta = STATUS_META[status];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ul ref={listRef} className="flex-1 overflow-y-auto">
        {events.map((evt, i) => (
          <li key={evt.id}>
            <div
              data-index={i}
              onClick={() => {
                if (evt.issueKey) router.push(`/issues/${evt.issueKey}`);
              }}
              onMouseEnter={() => setCursor(i)}
              className={`flex h-9 w-full items-center gap-3 border-b border-lining-faint px-4 text-left text-[13px] ${
                evt.issueKey ? "cursor-pointer" : ""
              } ${i === cursor ? "bg-surface-2" : "hover:bg-surface-1"}`}
            >
              <span
                className="w-8 shrink-0 font-mono text-[11px] text-ink-tertiary"
                // locale/timezone of the tooltip legitimately differ server vs browser
                suppressHydrationWarning
                title={new Date(evt.createdAt).toLocaleString()}
              >
                {timeAgo(evt.createdAt, now)}
              </span>
              <span className="flex w-36 shrink-0 items-center gap-1.5 truncate">
                {evt.actorType === "agent" && (
                  <Sparkle size={12} label="agent" />
                )}
                <span className="truncate text-ink-muted">
                  {evt.actorName ?? evt.actorType}
                </span>
              </span>
              <span className="shrink-0 text-ink-subtle">
                {actionLabel(evt)}
              </span>
              {evt.issueKey && (
                <Link
                  href={`/issues/${evt.issueKey}`}
                  onClick={(e) => e.stopPropagation()}
                  className="shrink-0 font-mono text-xs text-accent hover:text-accent-hover"
                >
                  {evt.issueKey}
                </Link>
              )}
              {evt.issueTitle && (
                <span className="truncate text-ink-tertiary">
                  {evt.issueTitle}
                </span>
              )}
            </div>
          </li>
        ))}
      </ul>
      <footer className="flex h-8 shrink-0 items-center gap-4 border-t border-lining-faint px-4 font-mono text-[11px] text-ink-tertiary">
        <span className="flex items-center gap-1.5">
          <span className={`h-2 w-2 rounded-full ${meta.dot}`} />
          {meta.label}
        </span>
        <span>
          <kbd>j</kbd>/<kbd>k</kbd> move
        </span>
        <span>
          <kbd>⏎</kbd> open issue
        </span>
      </footer>
    </div>
  );
}
