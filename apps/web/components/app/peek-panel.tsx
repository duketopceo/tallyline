"use client";

import type { IssueState, Priority } from "@tallyline/types";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { PRIORITY_LABEL, relTime, STATE_LABEL } from "@/lib/format";
import { useMerged } from "./issue-store";
import { useIssueEditors } from "./pickers";
import { useNames, usePeek } from "./providers";
import { SessionBadge } from "./session-badge";
import { Assignee, Glint, Kbd, PriorityGlyph, Skeleton, StateGlyph } from "./ui";

export interface IssueDetail {
  key: string;
  title: string;
  description: string | null;
  state: IssueState;
  priority: Priority;
  assigneeType: "human" | "agent" | null;
  assigneeId: string | null;
  creatorType: string;
  creatorId: string | null;
  source: string;
  teamId: string;
  cycleId: string | null;
  projectId: string | null;
  estimate: number | null;
  dueDate: string | null;
  createdAt: string;
  updatedAt: string;
  labels: { id: string; name: string; color: string }[];
}
interface SessionLite { id: string; status: string; agentName: string; createdAt: string; events: { id: number; kind: string; message: string }[] }
interface CommentLite { id: string; body: string; actorType: string; actorId: string | null; createdAt: string }

const cache = new Map<string, { issue: IssueDetail; sessions: SessionLite[]; comments: CommentLite[] }>();

export function PeekPanel() {
  const peek = usePeek();
  if (!peek.key) return null;
  return <PeekBody key={peek.key} issueKey={peek.key} />;
}

function PeekBody({ issueKey }: { issueKey: string }) {
  const peek = usePeek();
  const names = useNames();
  const editors = useIssueEditors();
  const [data, setData] = useState(cache.get(issueKey) ?? null);
  const [error, setError] = useState(false);
  const [editing, setEditing] = useState(false);
  const [width, setWidth] = useState(480);
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    try {
      const w = Number(localStorage.getItem("tl:peek:width"));
      if (w >= 480 && w <= 720) setWidth(w);
    } catch {
      // unremembered width is fine
    }
  }, []);

  useEffect(() => {
    const ac = new AbortController();
    const get = async <T,>(p: string): Promise<T | null> => {
      const r = await fetch(p, { signal: ac.signal, cache: "no-store" });
      return r.ok ? ((await r.json()) as T) : null;
    };
    void (async () => {
      try {
        const [issue, sessions, comments] = await Promise.all([
          get<IssueDetail>(`/api/issues/${issueKey}`),
          get<{ sessions: SessionLite[] }>(`/api/issues/${issueKey}/sessions`),
          get<{ comments: CommentLite[] }>(`/api/issues/${issueKey}/comments`),
        ]);
        if (!issue) return setError(true);
        const next = { issue, sessions: sessions?.sessions ?? [], comments: comments?.comments ?? [] };
        cache.set(issueKey, next);
        setData(next);
        setError(false);
      } catch {
        if (!ac.signal.aborted) setError(true);
      }
    })();
    return () => ac.abort();
  }, [issueKey]);

  const issue = useMerged(data?.issue ?? ({ key: issueKey } as IssueDetail));
  const loading = !data;

  function close() {
    peek.close();
    document.querySelector<HTMLElement>('[data-cursor="true"] [data-title-link]')?.focus();
  }

  const asLike = { ...issue, assigneeType: issue.assigneeType, assigneeId: issue.assigneeId };
  const assigneeName = names.assignee(issue.assigneeType, issue.assigneeId);
  const creator = names.actor(issue.creatorType, issue.creatorId);
  const lastSession = data?.sessions[0];

  const prop = "flex h-8 w-full items-center gap-2 rounded-sm px-2 text-left text-[13px] text-ink hover:bg-surface-2";
  return (
    <aside
      ref={ref}
      aria-label={`Peek ${issueKey}`}
      style={{ ["--peek-w" as string]: `${width}px` }}
      onKeyDown={(e) => {
        if (e.key === "Escape" && !editing) {
          e.stopPropagation();
          close();
        }
      }}
      className="fixed inset-y-0 right-0 z-40 flex w-[min(480px,100vw)] shrink-0 flex-col border-l border-lining-strong bg-surface-1 min-[1440px]:static min-[1440px]:z-auto min-[1440px]:w-[var(--peek-w)]"
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize peek panel"
        aria-valuemin={480}
        aria-valuemax={720}
        aria-valuenow={width}
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
          e.preventDefault();
          const w = Math.min(720, Math.max(480, width + (e.key === "ArrowLeft" ? 24 : -24)));
          setWidth(w);
          try { localStorage.setItem("tl:peek:width", String(w)); } catch { /* ignore */ }
        }}
        className="absolute -left-1 top-0 hidden h-full w-2 cursor-col-resize hover:bg-accent/30 focus-visible:bg-accent/40 min-[1440px]:block"
      />
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-lining-faint px-4">
        <span className="font-mono text-[12px] text-ink-muted">{issueKey}</span>
        <Link href={`/issues/${issueKey}`} className="ml-auto text-[12px] text-accent hover:text-accent-hover">Open full <Kbd>⏎</Kbd></Link>
        <button type="button" onClick={close} aria-label="Close peek" className="flex h-7 w-7 items-center justify-center rounded-sm text-ink-muted hover:bg-surface-2 hover:text-ink">
          <svg width="14" height="14" viewBox="0 0 14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden><path d="M3 3l8 8M11 3l-8 8" /></svg>
        </button>
      </header>
      <div className="scroll-quiet min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {error && <p role="alert" className="rounded-md border border-lining-bright bg-surface-2 p-3 text-[13px] text-urgent">Could not load {issueKey}. Check your connection, then press Space to retry.</p>}
        {loading && !error && (
          <div aria-busy="true" aria-label="Loading issue" className="space-y-3">
            <Skeleton className="h-6 w-3/4" /><Skeleton className="h-8 w-full" /><Skeleton className="h-8 w-full" /><Skeleton className="h-24 w-full" />
          </div>
        )}
        {data && (
          <>
            {editing ? (
              <input
                autoFocus
                defaultValue={issue.title}
                aria-label="Issue title"
                onBlur={() => setEditing(false)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    const v = e.currentTarget.value.trim();
                    if (v && v !== issue.title) editors.setTitle(asLike, v);
                    setEditing(false);
                  } else if (e.key === "Escape") {
                    e.stopPropagation();
                    setEditing(false);
                  }
                }}
                className="w-full rounded-sm border border-control bg-surface-2 px-2 py-1 text-[17px] font-semibold"
              />
            ) : (
              <h2 className="text-[17px] font-semibold leading-snug">
                <button type="button" onClick={() => setEditing(true)} title="Edit title (e)" className="w-full rounded-sm text-left hover:bg-surface-2">{issue.title}</button>
              </h2>
            )}
            <div className="mt-3 space-y-0.5">
              <button type="button" className={prop} onClick={(e) => editors.pickState(e.currentTarget, [asLike])} aria-label={`State: ${STATE_LABEL[issue.state]}. Change (s)`}>
                <StateGlyph state={issue.state} labelled={false} />{STATE_LABEL[issue.state]}<Kbd>s</Kbd>
              </button>
              <button type="button" className={prop} onClick={(e) => editors.pickPriority(e.currentTarget, [asLike])} aria-label={`Priority: ${PRIORITY_LABEL[issue.priority]}. Change (p)`}>
                <PriorityGlyph priority={issue.priority} />{PRIORITY_LABEL[issue.priority]}<Kbd>p</Kbd>
              </button>
              <button type="button" className={prop} onClick={(e) => editors.pickAssignee(e.currentTarget, [asLike])} aria-label={`Assignee: ${assigneeName ?? "Unassigned"}. Change (a)`}>
                <Assignee type={issue.assigneeType} name={assigneeName} size={16} />{assigneeName ?? "Unassigned"}{issue.assigneeType === "agent" && <span className="text-[12px] text-ink-subtle">agent</span>}<Kbd>a</Kbd>
              </button>
            </div>
            {issue.labels.length > 0 && (
              <ul className="mt-3 flex flex-wrap gap-1.5" aria-label="Labels">
                {issue.labels.map((l) => (
                  <li key={l.id} className="flex items-center gap-1.5 rounded-full border border-lining px-2 py-0.5 text-[12px] text-ink-muted">
                    <span aria-hidden className="h-2 w-2 rounded-full" style={{ background: l.color }} />{l.name}
                  </li>
                ))}
              </ul>
            )}
            {issue.creatorType === "agent" && (
              <p className="mt-3 flex items-center gap-1.5 text-[12px] text-ink-muted">
                <Glint size={12} label={`Filed by agent ${creator}`} />Filed by {creator} via {issue.source}
              </p>
            )}
            {issue.description && <p className="mt-4 max-w-[72ch] whitespace-pre-wrap text-[13px] leading-relaxed text-ink-muted">{issue.description}</p>}
            {lastSession && (
              <section className="mt-5 rounded-md border border-lining bg-surface-2 p-3" aria-label="Latest agent session">
                <div className="flex items-center gap-2 text-[12px] text-ink-muted">
                  <Glint size={12} label="" /><span className="font-medium text-ink">{lastSession.agentName}</span><SessionBadge status={lastSession.status} />
                  <span className="ml-auto text-ink-subtle" title={new Date(lastSession.createdAt).toLocaleString()}>{relTime(lastSession.createdAt)} ago</span>
                </div>
                {lastSession.events.at(-1) && <p className="mt-1.5 truncate font-mono text-[12px] text-ink-muted">{lastSession.events.at(-1)!.message}</p>}
              </section>
            )}
            {data.comments.length > 0 && (
              <section className="mt-5" aria-label="Recent comments">
                <h3 className="text-[11px] font-medium uppercase tracking-[0.4px] text-ink-subtle">Recent comments</h3>
                <ul className="mt-2 space-y-2">
                  {data.comments.slice(-3).map((c) => (
                    <li key={c.id} className="rounded-sm border border-lining-faint p-2 text-[13px] text-ink-muted">
                      <span className="flex items-center gap-1.5 text-[12px] text-ink-subtle">
                        {c.actorType === "agent" && <Glint size={12} label="" />}{names.actor(c.actorType, c.actorId)} · {relTime(c.createdAt)}
                      </span>
                      <span className="mt-0.5 line-clamp-3 block whitespace-pre-wrap">{c.body}</span>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </>
        )}
      </div>
    </aside>
  );
}
