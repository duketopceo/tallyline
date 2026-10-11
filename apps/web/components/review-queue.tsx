"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { NewPill, useLiveCount } from "@/components/app/live";
import { SessionBadge } from "@/components/app/session-badge";
import { useToast } from "@/components/app/toast";
import { Glint, Kbd, PriorityGlyph, Skeleton } from "@/components/app/ui";
import { SessionTimeline, type Outcome, type Session } from "@/components/session-timeline";
import { relTime } from "@/lib/format";
import { Markdown } from "@/lib/markdown";

export interface QueueRow {
  id: string;
  key: string;
  title: string;
  priority: string;
  dispatchStatus: string;
  agentName: string;
  sessionAt: string;
}

interface Evidence {
  description: string | null;
  summary: { body: string; at: string } | null;
  sessions: Session[];
  outcomes: Record<string, Outcome>;
}

function isTyping(el: EventTarget | null) {
  return el instanceof HTMLElement && (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName));
}

// Review queue (Silver Lining section 10): pending items oldest first, each with
// who asked and what changed; `a` approves, `r` sends back with a required
// note, Enter opens the full issue. Approvals are held for 8s with Undo.
export function ReviewQueue({ queue }: { queue: QueueRow[] }) {
  const router = useRouter();
  const toast = useToast();
  const live = useLiveCount();
  const [gone, setGone] = useState<ReadonlySet<string>>(new Set());
  const [cursor, setCursor] = useState(0);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [sendBack, setSendBack] = useState(false);
  const [note, setNote] = useState("");
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const cache = useRef(new Map<string, Evidence>());
  const [evidence, setEvidence] = useState<Evidence | null>(null);

  // oldest first: the person waiting longest is at the top
  const rows = useMemo(() => [...queue].filter((r) => !gone.has(r.key)).sort((a, b) => a.sessionAt.localeCompare(b.sessionAt)), [queue, gone]);
  const cur = rows[Math.min(cursor, rows.length - 1)];

  useEffect(() => { if (cursor > rows.length - 1) setCursor(Math.max(0, rows.length - 1)); }, [rows.length, cursor]);

  useEffect(() => {
    if (!cur) return;
    setSendBack(false);
    setNote("");
    const hit = cache.current.get(cur.key);
    setEvidence(hit ?? null);
    const ac = new AbortController();
    void (async () => {
      const get = async <T,>(p: string): Promise<T | null> => {
        try { const r = await fetch(p, { signal: ac.signal, cache: "no-store" }); return r.ok ? ((await r.json()) as T) : null; } catch { return null; }
      };
      const [issue, comments, sessions, events] = await Promise.all([
        get<{ description: string | null }>(`/api/issues/${cur.key}`),
        get<{ comments: { body: string; actorType: string; createdAt: string }[] }>(`/api/issues/${cur.key}/comments`),
        get<{ sessions: Session[] }>(`/api/issues/${cur.key}/sessions`),
        get<{ events: { action: string; after: { dispatchId?: string; branch?: string; pr?: string; reason?: string } | null }[] }>(`/api/issues/${cur.key}/events`),
      ]);
      if (ac.signal.aborted) return;
      const lastAgent = [...(comments?.comments ?? [])].reverse().find((c) => c.actorType === "agent");
      const outcomes: Record<string, Outcome> = {};
      for (const e of events?.events ?? []) {
        const a = e.after;
        if (a?.dispatchId && (e.action === "dispatch_completed" || e.action === "dispatch_failed")) outcomes[a.dispatchId] = { ...(a.branch ? { branch: a.branch } : {}), ...(a.pr ? { pr: a.pr } : {}), ...(a.reason ? { reason: a.reason } : {}) };
      }
      const ev: Evidence = { description: issue?.description ?? null, summary: lastAgent ? { body: lastAgent.body, at: lastAgent.createdAt } : null, sessions: sessions?.sessions ?? [], outcomes };
      cache.current.set(cur.key, ev);
      setEvidence(ev);
    })();
    return () => ac.abort();
  }, [cur?.key]);

  const decide = useCallback(
    (targets: QueueRow[], action: "approve" | "send_back", feedback?: string) => {
      if (!targets.length) return;
      const keys = targets.map((t) => t.key);
      setGone((g) => new Set([...g, ...keys]));
      setSelected(new Set());
      setSendBack(false);
      setNote("");
      const verb = action === "approve" ? "approved" : "sent back to the agent";
      toast.defer({
        message: `${keys.length === 1 ? keys[0] : `${keys.length} issues`} ${verb}. Held for 8 seconds`,
        onUndo: () => setGone((g) => { const n = new Set(g); for (const k of keys) n.delete(k); return n; }),
        commit: async ({ keepalive }) => {
          const results = await Promise.all(
            keys.map(async (k) => {
              try {
                const r = await fetch(`/api/issues/${k}/review`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, feedback }), ...(keepalive ? { keepalive: true } : {}) });
                return r.ok ? null : k;
              } catch { return k; }
            }),
          );
          const failed = results.filter((x): x is string => !!x);
          if (failed.length) {
            setGone((g) => { const n = new Set(g); for (const k of failed) n.delete(k); return n; });
            toast.push({ error: true, message: `${failed.join(", ")} not ${action === "approve" ? "approved" : "sent back"}: the server rejected it. The item is back in the queue.` });
          }
          router.refresh();
        },
      });
    },
    [router, toast],
  );

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (isTyping(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      const k = e.key;
      if (k === "j" || k === "ArrowDown") { e.preventDefault(); setCursor((c) => Math.min(c + 1, rows.length - 1)); }
      else if (k === "k" || k === "ArrowUp") { e.preventDefault(); setCursor((c) => Math.max(c - 1, 0)); }
      else if (k === "x" && cur) { e.preventDefault(); setSelected((s) => { const n = new Set(s); if (n.has(cur.key)) n.delete(cur.key); else n.add(cur.key); return n; }); }
      else if (k === "a" && cur) { e.preventDefault(); decide(selected.size ? rows.filter((r) => selected.has(r.key)) : [cur], "approve"); }
      else if (k === "r" && cur) { e.preventDefault(); setSendBack(true); requestAnimationFrame(() => noteRef.current?.focus()); }
      else if (k === "Enter" && cur && !(e.target instanceof HTMLElement && ["A", "BUTTON"].includes(e.target.tagName))) { e.preventDefault(); router.push(`/issues/${cur.key}`); }
      else if (k === "Escape") { if (selected.size) setSelected(new Set()); }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [rows, cur, selected, decide, router]);

  const selectedRows = rows.filter((r) => selected.has(r.key));
  const bulkBlocked = selectedRows.some((r) => r.dispatchStatus !== "completed");

  if (rows.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center px-8 py-12 text-center">
        <p className="text-[14px] font-medium text-ink">Nothing waiting</p>
        <p className="mt-1 max-w-sm text-[13px] text-ink-subtle">Agents land finished work here. Assign an issue to an agent and its result will appear for you to approve or send back.</p>
      </div>
    );
  }

  return (
    <div className="relative flex min-h-0 flex-1">
      <NewPill count={live.count} onShow={() => { live.reset(); router.refresh(); }} />
      <div className="flex min-h-0 w-full flex-col border-lining-faint lg:w-[400px] lg:shrink-0 lg:border-r">
        {selected.size > 0 && (
          <div role="toolbar" aria-label="Bulk review" className="flex shrink-0 flex-wrap items-center gap-2 border-b border-lining-faint bg-surface-1 px-4 py-1.5">
            <span className="text-[13px] font-medium tabular-nums">{selected.size} selected</span>
            <button type="button" disabled={bulkBlocked} onClick={() => decide(selectedRows, "approve")} className="h-7 rounded-sm bg-accent px-2.5 text-[12px] font-medium text-on-accent hover:bg-accent-hover disabled:opacity-50">Approve {selected.size}</button>
            {bulkBlocked && <span className="text-[12px] text-attention">Bulk approve needs a completed session on every item</span>}
          </div>
        )}
        <div role="list" aria-label="Review queue" className="scroll-quiet min-h-0 flex-1 overflow-y-auto">
          {rows.map((r, i) => (
            <div key={r.key} role="listitem" data-index={i} data-cursor={i === cursor} onMouseMove={() => setCursor(i)} className={`flex items-center gap-2 border-b border-lining-faint border-l-2 px-3 py-2 ${selected.has(r.key) ? "border-l-accent" : "border-l-transparent"} ${i === cursor ? "bg-surface-2" : ""}`}>
              <button type="button" role="checkbox" aria-checked={selected.has(r.key)} aria-label={`Select ${r.key}`} onClick={() => setSelected((s) => { const n = new Set(s); if (n.has(r.key)) n.delete(r.key); else n.add(r.key); return n; })} className="flex h-6 w-6 shrink-0 items-center justify-center rounded-xs hover:bg-surface-3">
                <span className={`flex h-3.5 w-3.5 items-center justify-center rounded-xs border ${selected.has(r.key) ? "border-accent bg-accent text-on-accent" : "border-control"}`}>{selected.has(r.key) && <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden><path d="M2 5.3l2 2 4-4.3" /></svg>}</span>
              </button>
              <Link href={`/issues/${r.key}`} tabIndex={i === cursor ? 0 : -1} className="min-w-0 flex-1 lg:pointer-events-none lg:cursor-default" onClick={(e) => { if (window.matchMedia("(min-width: 1024px)").matches) e.preventDefault(); }}>
                <span className="flex items-center gap-2"><PriorityGlyph priority={r.priority as never} /><span className="font-mono text-[12px] text-ink-subtle">{r.key}</span></span>
                <span className="mt-0.5 line-clamp-2 block text-[13px] text-ink">{r.title}</span>
                <span className="mt-1 flex flex-wrap items-center gap-x-2 text-[12px] text-ink-subtle"><Glint size={12} label="" /><span className="text-ink-muted">{r.agentName}</span><SessionBadge status={r.dispatchStatus} /><time dateTime={r.sessionAt} title={new Date(r.sessionAt).toLocaleString()} suppressHydrationWarning>waiting {relTime(r.sessionAt)}</time></span>
              </Link>
            </div>
          ))}
        </div>
        <footer className="flex h-8 shrink-0 items-center gap-3 overflow-hidden border-t border-lining-faint px-4 text-[11px] text-ink-subtle max-sm:hidden">
          <span><Kbd>j</Kbd> <Kbd>k</Kbd> move</span><span><Kbd>a</Kbd> approve</span><span><Kbd>r</Kbd> send back</span><span><Kbd>x</Kbd> select</span><span><Kbd>⏎</Kbd> open</span>
        </footer>
      </div>

      <section aria-label="Evidence" className="scroll-quiet hidden min-w-0 flex-1 overflow-y-auto p-6 lg:block">
        {cur && (
          <div className="mx-auto max-w-[72ch]">
            <p className="flex items-center gap-2 text-[12px] text-ink-subtle"><span className="font-mono">{cur.key}</span><span>asked of</span><Glint size={12} label="" /><span className="font-medium text-ink-muted">{cur.agentName}</span></p>
            <h2 className="mt-1 text-[17px] font-semibold leading-snug">{cur.title}</h2>
            {!evidence ? (
              <div role="status" aria-busy="true" aria-label="Loading evidence" className="mt-4 space-y-3"><Skeleton className="h-20 w-full" /><Skeleton className="h-28 w-full" /></div>
            ) : (
              <>
                <section aria-label="Agent summary" className="mt-4 rounded-md border border-lining bg-surface-1 p-3">
                  <h3 className="text-[12px] font-medium text-ink-subtle">What the agent reported</h3>
                  {evidence.summary ? (
                    <div className="mt-1.5"><Markdown source={evidence.summary.body} /><p className="mt-1 text-[12px] text-ink-subtle" suppressHydrationWarning>{cur.agentName} · {relTime(evidence.summary.at)} ago</p></div>
                  ) : (
                    <p className="mt-1.5 text-[13px] text-attention">No summary from {cur.agentName}. Open the issue before approving.</p>
                  )}
                </section>
                {evidence.description && (<section aria-label="Request" className="mt-4"><h3 className="text-[12px] font-medium text-ink-subtle">The request</h3><div className="mt-1"><Markdown source={evidence.description} /></div></section>)}
                <SessionTimeline issueKey={cur.key} initial={evidence.sessions} outcomes={evidence.outcomes} onRerun={() => router.push(`/issues/${cur.key}`)} onReassign={() => router.push(`/issues/${cur.key}`)} />
              </>
            )}
            <div className="sticky bottom-0 -mx-6 mt-6 border-t border-lining bg-canvas px-6 py-3">
              {sendBack ? (
                <form onSubmit={(e) => { e.preventDefault(); if (note.trim()) decide([cur], "send_back", note.trim()); }}>
                  <label htmlFor="send-back-note" className="text-[12px] text-ink-subtle">What should {cur.agentName} change? (required)</label>
                  <textarea id="send-back-note" ref={noteRef} value={note} onChange={(e) => setNote(e.target.value)} rows={3} onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); setSendBack(false); } else if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); if (note.trim()) decide([cur], "send_back", note.trim()); } }} className="mt-1 w-full resize-y rounded-sm border border-control bg-surface-2 px-3 py-2 text-[13px] text-ink" />
                  <div className="mt-2 flex items-center gap-2"><button type="submit" disabled={!note.trim()} className="h-8 rounded-sm bg-accent px-3 text-[13px] font-medium text-on-accent hover:bg-accent-hover disabled:opacity-50">Send back to agent</button><button type="button" onClick={() => setSendBack(false)} className="h-8 rounded-sm px-3 text-[13px] text-ink-muted hover:bg-surface-2">Cancel <Kbd>Esc</Kbd></button></div>
                </form>
              ) : (
                <div className="flex flex-wrap items-center gap-2">
                  <button type="button" onClick={() => decide([cur], "approve")} className="h-8 rounded-sm bg-accent px-3 text-[13px] font-medium text-on-accent hover:bg-accent-hover">Approve {cur.key} <Kbd>a</Kbd></button>
                  <button type="button" onClick={() => { setSendBack(true); requestAnimationFrame(() => noteRef.current?.focus()); }} className="h-8 rounded-sm border border-control px-3 text-[13px] text-ink-muted hover:bg-surface-2 hover:text-ink">Send back to agent <Kbd>r</Kbd></button>
                  <Link href={`/issues/${cur.key}`} className="h-8 rounded-sm px-3 text-[13px] leading-8 text-accent hover:bg-surface-2">Open full issue <Kbd>⏎</Kbd></Link>
                  <span className="ml-auto text-[12px] text-ink-subtle">Held for 8s: undo with <Kbd>⌘Z</Kbd></span>
                </div>
              )}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
