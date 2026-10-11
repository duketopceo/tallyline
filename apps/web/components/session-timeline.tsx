"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { SessionBadge } from "@/components/app/session-badge";
import { Glint } from "@/components/app/ui";
import { relTime } from "@/lib/format";

export interface SessionEvent { id: number; kind: string; message: string; createdAt: string }
export interface Session {
  id: string;
  status: string;
  trigger: string;
  agentId: string;
  agentName: string;
  createdAt: string;
  events: SessionEvent[];
}
export interface Outcome { branch?: string; pr?: string; reason?: string }

const KIND: Record<string, string> = { reading: "Reading", planning: "Planning", implementing: "Implementing", testing: "Testing", pr: "Pull request", error: "Error", note: "Note" };
const TRIGGER: Record<string, string> = { assign: "assigned", mention: "mentioned" };

// Agent sessions: provenance first (which agent, how it was started, what it
// reported), live line while running, full log on demand. Repeats collapse.
export function SessionTimeline({
  issueKey, initial, outcomes, onRerun, onReassign,
}: {
  issueKey: string;
  initial: Session[];
  outcomes: Record<string, Outcome>;
  onRerun: (s: Session) => void;
  onReassign: (anchor: HTMLElement) => void;
}) {
  const [sessions, setSessions] = useState<Session[]>(initial);
  const [open, setOpen] = useState<Record<string, boolean>>({});

  const refresh = useCallback(async () => {
    const res = await fetch(`/api/issues/${issueKey}/sessions`, { cache: "no-store" });
    if (res.ok) setSessions(((await res.json()) as { sessions?: Session[] }).sessions ?? []);
  }, [issueKey]);

  useEffect(() => setSessions(initial), [initial]);

  // session logs update in place; the section never steals focus or scroll
  useEffect(() => {
    if (typeof EventSource === "undefined") return;
    const es = new EventSource("/api/events/stream");
    let pending = false;
    es.onmessage = (msg) => {
      try {
        const e = JSON.parse(msg.data as string) as { issueKey?: string; action?: string };
        if (e.issueKey === issueKey && !pending && (e.action === "session_update" || e.action?.startsWith("dispatch"))) {
          pending = true;
          setTimeout(() => { pending = false; void refresh(); }, 250);
        }
      } catch { /* malformed frame */ }
    };
    return () => es.close();
  }, [issueKey, refresh]);

  // collapse consecutive identical sessions (same agent, trigger, status)
  const rows = useMemo(() => {
    const out: { s: Session; count: number }[] = [];
    for (const s of sessions) {
      const prev = out.at(-1);
      if (prev && prev.s.agentId === s.agentId && prev.s.trigger === s.trigger && prev.s.status === s.status && s.events.length === 0 && prev.s.events.length === 0) prev.count++;
      else out.push({ s, count: 1 });
    }
    return out;
  }, [sessions]);

  if (rows.length === 0) return null;
  return (
    <section id="sessions" aria-label="Agent sessions" className="mt-8">
      <h2 className="text-[13px] font-semibold text-ink">Agent sessions <span className="font-normal tabular-nums text-ink-subtle">{sessions.length}</span></h2>
      <ul className="mt-3 space-y-2">
        {rows.map(({ s, count }) => {
          const failed = s.status === "dispatch_failed";
          const last = s.events.at(-1);
          const out = outcomes[s.id];
          const expanded = open[s.id];
          return (
            <li key={s.id} id={`session-${s.id}`} className={`rounded-md border bg-surface-1 p-3 ${failed ? "border-lining-bright" : "border-lining"}`}>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px]">
                <Glint size={12} label="" />
                <span className="text-[13px] font-medium text-ink">{s.agentName}</span>
                <SessionBadge status={s.status} />
                <span className="text-ink-subtle">{TRIGGER[s.trigger] ?? s.trigger}{count > 1 ? ` · ${count} attempts` : ""}</span>
                <time className="ml-auto text-ink-subtle" dateTime={s.createdAt} title={new Date(s.createdAt).toLocaleString()} suppressHydrationWarning>{relTime(s.createdAt)} ago</time>
              </div>
              {s.status === "claimed" && last && <p className="mt-2 truncate font-mono text-[12px] text-ink-muted" aria-live="polite">{last.message}</p>}
              {(out?.pr || out?.branch) && (
                <p className="mt-2 flex flex-wrap items-center gap-x-3 text-[12px] text-ink-muted">
                  {out.branch && <span className="font-mono">{out.branch}</span>}
                  {out.pr && <a href={out.pr} target="_blank" rel="noopener noreferrer" className="text-accent hover:text-accent-hover">Open pull request</a>}
                </p>
              )}
              {failed && (
                <div className="mt-2 flex flex-wrap items-center gap-2" role="alert">
                  <span className="text-[13px] text-urgent">{s.agentName} did not finish{out?.reason ? `: ${out.reason}` : ""}.</span>
                  <button type="button" onClick={() => onRerun(s)} className="h-7 rounded-sm bg-accent px-2.5 text-[12px] font-medium text-on-accent hover:bg-accent-hover">Re-run {s.agentName}</button>
                  <button type="button" onClick={(e) => onReassign(e.currentTarget)} className="h-7 rounded-sm border border-control px-2.5 text-[12px] text-ink-muted hover:bg-surface-2">Reassign</button>
                </div>
              )}
              {s.events.length > 0 && (
                <>
                  <button type="button" aria-expanded={!!expanded} onClick={() => setOpen((o) => ({ ...o, [s.id]: !o[s.id] }))} className="mt-2 h-6 rounded-xs text-[12px] text-ink-subtle hover:text-ink">
                    {expanded ? "Hide log" : `Show log (${s.events.length} ${s.events.length === 1 ? "entry" : "entries"})`}
                  </button>
                  {expanded && (
                    <ol className="mt-1 space-y-1 border-l border-lining-faint pl-3">
                      {s.events.map((e) => (
                        <li key={e.id} className="flex items-baseline gap-2 font-mono text-[12px]">
                          <time className="w-[60px] shrink-0 text-ink-subtle" dateTime={e.createdAt} suppressHydrationWarning>{new Date(e.createdAt).toLocaleTimeString("en-US", { hour12: false })}</time>
                          <span className={`w-[92px] shrink-0 ${e.kind === "error" ? "text-urgent" : e.kind === "pr" ? "text-accent" : "text-ink-subtle"}`}>{KIND[e.kind] ?? e.kind}</span>
                          <span className="min-w-0 break-words text-ink-muted">{e.message}</span>
                        </li>
                      ))}
                    </ol>
                  )}
                </>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
