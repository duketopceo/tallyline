"use client";

import { useCallback, useEffect, useState } from "react";
import { Sparkle } from "./primitives";

interface SessionEvent {
  id: number;
  kind: string;
  message: string;
  createdAt: string;
}

interface Session {
  id: string;
  status: string;
  trigger: string;
  agentName: string;
  createdAt: string;
  events: SessionEvent[];
}

interface FeedEvent {
  action: string;
  issueKey: string | null;
}

const KIND_TONE: Record<string, string> = {
  error: "text-red-400",
  pr: "text-accent",
  testing: "text-amber-400",
  note: "text-ink-tertiary",
};

const STATUS_LABEL: Record<string, string> = {
  claimed: "running",
  completed: "completed",
  dispatch_failed: "failed",
  canceled: "canceled",
  queued: "queued",
};

function ts(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

export function SessionTimeline({ issueKey }: { issueKey: string }) {
  const [sessions, setSessions] = useState<Session[] | null>(null);
  const [live, setLive] = useState(false);

  const refresh = useCallback(async () => {
    const res = await fetch(`/api/issues/${issueKey}/sessions`, {
      cache: "no-store",
    });
    if (res.ok) {
      const body = (await res.json()) as { sessions?: Session[] };
      setSessions(body.sessions ?? []);
    }
  }, [issueKey]);

  useEffect(() => {
    void refresh();
    const es = new EventSource("/api/events/stream");
    es.onopen = () => setLive(true);
    es.onmessage = (msg) => {
      try {
        const e = JSON.parse(msg.data as string) as FeedEvent;
        if (e.issueKey === issueKey && e.action === "session_update") {
          void refresh();
        }
      } catch {
        // malformed frame — skip
      }
    };
    es.onerror = () => {
      if (es.readyState === EventSource.CLOSED) setLive(false);
    };
    return () => es.close();
  }, [issueKey, refresh]);

  if (sessions === null || sessions.length === 0) return null;

  return (
    <section className="mt-8">
      <h2 className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-wider text-ink-tertiary">
        Agent sessions ({sessions.length})
        {live && (
          <span className="h-1.5 w-1.5 rounded-full bg-accent" title="live" />
        )}
      </h2>
      <div className="mt-3 space-y-3">
        {sessions.map((s) => (
          <div
            key={s.id}
            className="rounded-md border border-lining bg-surface-1 p-3"
          >
            <div className="flex items-center gap-2 font-mono text-[11px] text-ink-tertiary">
              <Sparkle size={12} label="agent" />
              <span className="text-ink-muted">@{s.agentName}</span>
              <span className="capitalize">{STATUS_LABEL[s.status] ?? s.status}</span>
              {s.status === "claimed" && (
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
              )}
              <span className="ml-auto">{new Date(s.createdAt).toLocaleString("en-US", { month: "short", day: "numeric" })}</span>
            </div>
            {s.events.length > 0 && (
              <ol className="mt-2 space-y-1 border-l border-lining-faint pl-3">
                {s.events.map((e) => (
                  <li
                    key={e.id}
                    className="flex items-baseline gap-2 font-mono text-[11px]"
                  >
                    <span className="w-14 shrink-0 text-ink-tertiary">
                      {ts(e.createdAt)}
                    </span>
                    <span
                      className={`w-20 shrink-0 uppercase text-[11px] ${KIND_TONE[e.kind] ?? "text-ink-subtle"}`}
                    >
                      {e.kind}
                    </span>
                    <span className="text-ink-muted">{e.message}</span>
                  </li>
                ))}
              </ol>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
