"use client";

import { findPath, type IssueState } from "@tallyline/types";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useIssueEdit, useMerged } from "@/components/app/issue-store";
import { useIssueEditors } from "@/components/app/pickers";
import { useMeta, useNames } from "@/components/app/providers";
import { useToast } from "@/components/app/toast";
import { Assignee, Glint, Kbd, PriorityGlyph, StateGlyph } from "@/components/app/ui";
import type { IssueDetail } from "@/components/app/peek-panel";
import { recordRecent } from "@/components/command-palette";
import { SummarizeButton } from "@/components/issue-detail-client";
import { SessionTimeline, type Outcome, type Session } from "@/components/session-timeline";
import { PRIORITY_LABEL, relTime, STATE_LABEL } from "@/lib/format";
import { Markdown } from "@/lib/markdown";

export interface DetailComment { id: string; body: string; actorType: string; actorId: string | null; createdAt: string; pending?: boolean }
export interface DetailEvent { id: number; action: string; actorType: string; actorId: string | null; before: Record<string, unknown> | null; after: Record<string, unknown> | null; createdAt: string }
type Child = { key: string; title: string };
export type FullIssue = IssueDetail & { children: Child[]; parentId?: string | null };

const abs = (iso: string) => new Date(iso).toLocaleString();

interface Entry {
  id: string;
  at: string;
  actorType: string;
  actorId: string | null;
  kind: "comment" | "event";
  comment?: DetailComment;
  event?: DetailEvent;
  repeat?: number;
}

function draftGet(k: string): string {
  try { return localStorage.getItem(k) ?? ""; } catch { return ""; }
}
function draftSet(k: string, v: string) {
  try { if (v) localStorage.setItem(k, v); else localStorage.removeItem(k); } catch { /* ignore */ }
}

export function IssueDetailView({
  issue: serverIssue, comments, events, sessions,
}: { issue: FullIssue; comments: DetailComment[]; events: DetailEvent[]; sessions: Session[] }) {
  const router = useRouter();
  const meta = useMeta();
  const names = useNames();
  const toast = useToast();
  const apply = useIssueEdit();
  const editors = useIssueEditors();
  const issue = useMerged(serverIssue);
  const like = { ...issue, assigneeType: issue.assigneeType, assigneeId: issue.assigneeId };
  const assigneeName = names.assignee(issue.assigneeType, issue.assigneeId);
  const [editingTitle, setEditingTitle] = useState(false);
  const [editingDesc, setEditingDesc] = useState(false);
  const [descDraft, setDescDraft] = useState("");
  const [local, setLocal] = useState<DetailComment[]>([]);
  const stateBtn = useRef<HTMLButtonElement>(null);
  const prioBtn = useRef<HTMLButtonElement>(null);
  const assignBtn = useRef<HTMLButtonElement>(null);

  useEffect(() => recordRecent(issue.key), [issue.key]);
  useEffect(() => setLocal([]), [comments]);

  // single-key shortcuts on this issue (Silver Lining section 7)
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (t instanceof HTMLElement && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName))) return;
      if (document.querySelector('[role="dialog"]')) return;
      if (e.key === "s") { e.preventDefault(); stateBtn.current?.click(); }
      else if (e.key === "p") { e.preventDefault(); prioBtn.current?.click(); }
      else if (e.key === "a") { e.preventDefault(); assignBtn.current?.click(); }
      else if (e.key === "e") { e.preventDefault(); setEditingTitle(true); }
      else if (e.key === "d") { e.preventDefault(); startDesc(); }
      else if (e.key === "Escape") router.push("/issues");
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  function startDesc() {
    setDescDraft(draftGet(`tl:draft:desc:${issue.key}`) || issue.description || "");
    setEditingDesc(true);
  }
  useEffect(() => {
    if (!editingDesc) return;
    const t = setInterval(() => draftSet(`tl:draft:desc:${issue.key}`, descDraft === (issue.description ?? "") ? "" : descDraft), 2000);
    return () => clearInterval(t);
  }, [editingDesc, descDraft, issue.key, issue.description]);
  function saveDesc() {
    draftSet(`tl:draft:desc:${issue.key}`, "");
    setEditingDesc(false);
    const v = descDraft.trim() ? descDraft : null;
    if (v !== (issue.description ?? null)) void apply([{ key: issue.key, patch: { description: v }, prior: { description: issue.description ?? null } }], `${issue.key} description saved`);
  }

  // ----- activity: comments + events merged, bursts grouped -----
  const entries = useMemo<Entry[]>(() => {
    const raw: Entry[] = [
      ...[...comments, ...local].map((c) => ({ id: `c-${c.id}`, at: c.createdAt, actorType: c.actorType, actorId: c.actorId, kind: "comment" as const, comment: c })),
      ...events
        .filter((e) => !["session_update", "commented"].includes(e.action))
        .map((e) => ({ id: `e-${e.id}`, at: e.createdAt, actorType: e.actorType, actorId: e.actorId, kind: "event" as const, event: e })),
    ].sort((a, b) => a.at.localeCompare(b.at));
    // collapse repeated identical system comments ("picked up via local adapter" x2)
    const out: Entry[] = [];
    for (const e of raw) {
      const prev = out.at(-1);
      if (prev && e.kind === "comment" && prev.kind === "comment" && e.actorType === "system" && prev.actorType === "system" && e.comment!.body === prev.comment!.body) prev.repeat = (prev.repeat ?? 1) + 1;
      else out.push(e);
    }
    return out;
  }, [comments, local, events]);

  const outcomes = useMemo(() => {
    const m: Record<string, Outcome> = {};
    for (const e of events) {
      const a = e.after as { dispatchId?: string; branch?: string; pr?: string; reason?: string } | null;
      if (a?.dispatchId && (e.action === "dispatch_completed" || e.action === "dispatch_failed")) {
        m[a.dispatchId] = { ...(a.branch ? { branch: a.branch } : {}), ...(a.pr ? { pr: a.pr } : {}), ...(a.reason ? { reason: a.reason } : {}) };
      }
    }
    return m;
  }, [events]);

  async function rerun(s: Session) {
    const res = await fetch(`/api/issues/${issue.key}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ assigneeType: "agent", assigneeId: s.agentId }) });
    if (!res.ok) return toast.push({ error: true, message: `Could not re-run ${s.agentName}: the server rejected the request.` });
    toast.push({ message: `Re-dispatched to ${s.agentName}: a new session is starting` });
    router.refresh();
  }

  // ----- comment composer with @mention autocomplete -----
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [mention, setMention] = useState<{ q: string; start: number } | null>(null);
  const [mi, setMi] = useState(0);
  const ta = useRef<HTMLTextAreaElement>(null);
  useEffect(() => setBody(draftGet(`tl:draft:comment:${issue.key}`)), [issue.key]);
  useEffect(() => {
    const t = setTimeout(() => draftSet(`tl:draft:comment:${issue.key}`, body), 2000);
    return () => clearTimeout(t);
  }, [body, issue.key]);
  const mentionOptions = useMemo(() => {
    if (!mention) return [];
    const q = mention.q.toLowerCase();
    return [
      ...meta.agents.map((a) => ({ id: a.id, name: a.name, agent: true })),
      ...meta.members.map((m) => ({ id: m.userId, name: m.name.split(" ")[0]!.toLowerCase(), agent: false })),
    ].filter((o) => o.name.toLowerCase().includes(q)).slice(0, 6);
  }, [mention, meta]);

  function onChange(v: string, caret: number) {
    setBody(v);
    const m = /(^|\s)@([\w-]*)$/.exec(v.slice(0, caret));
    setMention(m ? { q: m[2]!, start: caret - m[2]!.length - 1 } : null);
    setMi(0);
  }
  function insertMention(name: string) {
    if (!mention || !ta.current) return;
    const caret = ta.current.selectionStart;
    const next = `${body.slice(0, mention.start)}@${name} ${body.slice(caret)}`;
    setBody(next);
    setMention(null);
    const pos = mention.start + name.length + 2;
    requestAnimationFrame(() => { ta.current?.focus(); ta.current?.setSelectionRange(pos, pos); });
  }
  async function submit() {
    const text = body.trim();
    if (!text || sending) return;
    setSending(true);
    const pending: DetailComment = { id: `pending-${Date.now()}`, body: text, actorType: "human", actorId: meta.userId, createdAt: new Date().toISOString(), pending: true };
    setLocal((l) => [...l, pending]);
    setBody("");
    draftSet(`tl:draft:comment:${issue.key}`, "");
    const res = await fetch(`/api/issues/${issue.key}/comments`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ body: text }) });
    setSending(false);
    if (!res.ok) {
      setLocal((l) => l.filter((c) => c.id !== pending.id));
      setBody(text);
      return toast.push({ error: true, message: "Comment not posted: the server rejected it. Your text is back in the box." });
    }
    router.refresh();
  }

  const revert = useCallback(
    (e: DetailEvent) => {
      const before = (e.before as { state?: IssueState } | null)?.state;
      if (before) void apply([{ key: issue.key, patch: { state: before }, prior: { state: issue.state } }], `Reverted ${names.actor(e.actorType, e.actorId)}'s change: back to ${STATE_LABEL[before]}`);
    },
    [apply, issue.key, issue.state, names],
  );

  const actorLine = (type: string, id: string | null, at: string, extra?: ReactNode) => (
    <span className="flex flex-wrap items-center gap-x-1.5 text-[12px] text-ink-subtle">
      {type === "agent" && (
        <a href="#sessions" title={`${names.actor(type, id)}: see its session`} className="inline-flex"><Glint size={12} label={`Agent ${names.actor(type, id)}`} /></a>
      )}
      <span className="font-medium text-ink-muted">{names.actor(type, id)}</span>
      {extra}
      <time dateTime={at} title={abs(at)} suppressHydrationWarning>{relTime(at)} ago</time>
    </span>
  );

  const renderEvent = (e: DetailEvent): ReactNode => {
    const b = e.before as Record<string, string> | null;
    const a = e.after as Record<string, string> | null;
    switch (e.action) {
      case "state_changed": {
        const canRevert = e.actorType === "agent" && b?.state && a?.state === issue.state && findPath(issue.state, b.state as IssueState) !== null;
        return (
          <span className="flex flex-wrap items-center gap-2 text-[13px] text-ink-muted">
            changed state
            <span className="inline-flex items-center gap-1 rounded-xs bg-surface-2 px-1.5 py-0.5 text-[12px]"><StateGlyph state={(b?.state ?? "backlog") as IssueState} labelled={false} size={12} />{STATE_LABEL[b?.state ?? ""] ?? b?.state}</span>
            <span aria-hidden>→</span>
            <span className="inline-flex items-center gap-1 rounded-xs bg-surface-2 px-1.5 py-0.5 text-[12px]"><StateGlyph state={(a?.state ?? "backlog") as IssueState} labelled={false} size={12} />{STATE_LABEL[a?.state ?? ""] ?? a?.state}</span>
            {canRevert && <button type="button" onClick={() => revert(e)} className="h-6 rounded-xs border border-control px-2 text-[12px] text-ink-muted hover:bg-surface-2 hover:text-ink">Revert</button>}
          </span>
        );
      }
      case "created": return <span className="text-[13px] text-ink-muted">created this issue{issue.source !== "web" ? ` via ${issue.source}` : ""}</span>;
      case "dispatched": return <span className="text-[13px] text-ink-muted">dispatched to <strong className="font-medium text-ink">{(a as { agent?: string } | null)?.agent ?? "an agent"}</strong> ({(a as { trigger?: string } | null)?.trigger})</span>;
      case "dispatch_completed": return <span className="text-[13px] text-healthy">finished its session</span>;
      case "dispatch_failed": return <span className="text-[13px] text-urgent">session failed{(a as { reason?: string } | null)?.reason ? `: ${(a as { reason?: string }).reason}` : ""}</span>;
      default: return <span className="text-[13px] text-ink-muted">{e.action.replace(/_/g, " ")}</span>;
    }
  };

  // group 3+ consecutive agent entries within 2 minutes into one summary
  const timeline = useMemo(() => {
    const out: (Entry | { group: Entry[]; id: string })[] = [];
    let run: Entry[] = [];
    const flush = () => {
      if (run.length >= 3) out.push({ group: run, id: `g-${run[0]!.id}` });
      else out.push(...run);
      run = [];
    };
    for (const e of entries) {
      const prev = run.at(-1);
      if (e.actorType === "agent" && (!prev || (prev.actorId === e.actorId && Date.parse(e.at) - Date.parse(prev.at) < 120_000))) run.push(e);
      else { flush(); if (e.actorType === "agent") run.push(e); else out.push(e); }
    }
    flush();
    return out;
  }, [entries]);
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});

  const renderEntry = (e: Entry) =>
    e.kind === "comment" && e.actorType === "system" ? (
      <li key={e.id} className="flex flex-wrap items-baseline gap-x-2 py-1 pl-3">
        {actorLine(e.actorType, e.actorId, e.at, e.repeat && e.repeat > 1 ? <span>×{e.repeat}</span> : null)}
        <span className="text-[13px] text-ink-muted">{e.comment!.body}</span>
      </li>
    ) : e.kind === "comment" ? (
      <li key={e.id} className={`rounded-md border p-3 ${e.actorType === "agent" ? "border-lining bg-surface-1" : "border-lining-faint"} ${e.comment!.pending ? "opacity-70" : ""}`}>
        {actorLine(e.actorType, e.actorId, e.at, e.repeat && e.repeat > 1 ? <span>×{e.repeat}</span> : e.comment!.pending ? <span>sending</span> : null)}
        <div className="mt-1.5"><Markdown source={e.comment!.body} /></div>
      </li>
    ) : (
      <li key={e.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 py-1 pl-3">
        {actorLine(e.actorType, e.actorId, e.at)}
        {renderEvent(e.event!)}
      </li>
    );

  const prop = "flex h-8 w-full items-center gap-2 rounded-sm px-2 text-left text-[13px] text-ink hover:bg-surface-2";
  const cycle = meta.cycles.find((c) => c.id === issue.cycleId);
  const project = meta.projects.find((p) => p.id === issue.projectId);
  const creator = names.actor(issue.creatorType, issue.creatorId);

  return (
    <main className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-lining-faint px-4">
        <Link href="/issues" className="text-[13px] text-ink-subtle hover:text-ink">Issues</Link>
        <span aria-hidden className="text-ink-tertiary">/</span>
        <span className="font-mono text-[12px] text-ink-muted">{issue.key}</span>
        <button type="button" onClick={() => { void navigator.clipboard?.writeText(window.location.href); toast.push({ message: `Link to ${issue.key} copied` }); }} className="h-7 rounded-sm px-2 text-[12px] text-ink-subtle hover:bg-surface-2 hover:text-ink">Copy link</button>
        <span className="ml-auto hidden items-center gap-2 text-[11px] text-ink-subtle md:flex"><span><Kbd>s</Kbd> state</span><span><Kbd>p</Kbd> priority</span><span><Kbd>a</Kbd> assign</span><span><Kbd>e</Kbd> title</span><span><Kbd>d</Kbd> description</span></span>
      </header>
      <div className="scroll-quiet min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto grid max-w-[1100px] gap-8 px-4 py-6 sm:px-6 lg:grid-cols-[minmax(0,1fr)_288px]">
          <div className="min-w-0">
            {editingTitle ? (
              <input
                autoFocus defaultValue={issue.title} aria-label="Issue title"
                onBlur={() => setEditingTitle(false)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") { const v = e.currentTarget.value.trim(); if (v && v !== issue.title) editors.setTitle(like, v); setEditingTitle(false); }
                  else if (e.key === "Escape") { e.stopPropagation(); setEditingTitle(false); }
                }}
                className="w-full rounded-sm border border-control bg-surface-2 px-2 py-1 text-[24px] font-semibold leading-tight"
              />
            ) : (
              <h1 className="text-[24px] font-semibold leading-tight tracking-[-0.4px]">
                <button type="button" onClick={() => setEditingTitle(true)} title="Edit title (e)" className="w-full rounded-sm text-left hover:bg-surface-2">{issue.title}</button>
              </h1>
            )}
            {issue.creatorType === "agent" && (
              <p className="mt-2 flex flex-wrap items-center gap-1.5 text-[12px] text-ink-muted">
                <Glint size={12} label={`Filed by agent ${creator}`} />
                Filed by <span className="font-medium text-ink">{creator}</span> via {issue.source}
                <time dateTime={issue.createdAt} title={abs(issue.createdAt)} className="text-ink-subtle" suppressHydrationWarning>{relTime(issue.createdAt)} ago</time>
              </p>
            )}

            <section aria-label="Description" className="mt-5">
              {editingDesc ? (
                <div>
                  <textarea
                    autoFocus value={descDraft} onChange={(e) => setDescDraft(e.target.value)} aria-label="Description (markdown)" rows={10}
                    onKeyDown={(e) => {
                      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); saveDesc(); }
                      else if (e.key === "Escape") { e.stopPropagation(); setEditingDesc(false); }
                    }}
                    className="w-full resize-y rounded-sm border border-control bg-surface-2 p-3 font-mono text-[13px] text-ink"
                  />
                  <div className="mt-2 flex items-center gap-2">
                    <button type="button" onClick={saveDesc} className="h-8 rounded-sm bg-accent px-3 text-[13px] font-medium text-on-accent hover:bg-accent-hover">Save description</button>
                    <button type="button" onClick={() => setEditingDesc(false)} className="h-8 rounded-sm px-3 text-[13px] text-ink-muted hover:bg-surface-2">Cancel</button>
                    <span className="ml-auto text-[11px] text-ink-subtle">Markdown · <Kbd>⌘⏎</Kbd> save · draft auto-saves</span>
                  </div>
                </div>
              ) : issue.description ? (
                <div className="group relative rounded-sm">
                  <Markdown source={issue.description} />
                  <button type="button" onClick={startDesc} className="mt-2 h-7 rounded-sm px-2 text-[12px] text-ink-subtle hover:bg-surface-2 hover:text-ink">Edit description <Kbd>d</Kbd></button>
                </div>
              ) : (
                <button type="button" onClick={startDesc} className="h-9 w-full rounded-sm border border-dashed border-lining-strong px-3 text-left text-[13px] text-ink-subtle hover:bg-surface-2">Add a description. What is wrong, and how will we know it is fixed?</button>
              )}
            </section>

            <SummarizeButton issueKey={issue.key} />

            {serverIssue.children.length > 0 && (
              <section aria-label="Sub-issues" className="mt-8">
                <h2 className="text-[13px] font-semibold">Sub-issues <span className="font-normal tabular-nums text-ink-subtle">{serverIssue.children.length}</span></h2>
                <ul className="mt-2 divide-y divide-lining-faint rounded-md border border-lining bg-surface-1">
                  {serverIssue.children.map((c) => (
                    <li key={c.key}><Link href={`/issues/${c.key}`} className="flex h-9 items-center gap-3 px-3 text-[13px] text-ink-muted hover:bg-surface-2"><span className="font-mono text-[12px] text-ink-subtle">{c.key}</span><span className="truncate">{c.title}</span></Link></li>
                  ))}
                </ul>
              </section>
            )}

            <SessionTimeline
              issueKey={issue.key}
              initial={sessions}
              outcomes={outcomes}
              onRerun={(s) => void rerun(s)}
              onReassign={(a) => editors.pickAssignee(a, [like])}
            />

            <section aria-label="Activity" className="mt-8">
              <h2 className="text-[13px] font-semibold">Activity</h2>
              <ol className="mt-3 space-y-2">
                {timeline.map((t) =>
                  "group" in t ? (
                    <li key={t.id} className="rounded-md border border-lining-faint p-2">
                      <button type="button" aria-expanded={!!openGroups[t.id]} onClick={() => setOpenGroups((o) => ({ ...o, [t.id]: !o[t.id] }))} className="flex w-full items-center gap-2 rounded-xs px-1 text-left text-[13px] text-ink-muted hover:bg-surface-2">
                        <Glint size={12} label="" />
                        <span><strong className="font-medium text-ink">{names.actor("agent", t.group[0]!.actorId)}</strong> made {t.group.length} changes</span>
                        <time className="ml-auto text-[12px] text-ink-subtle" dateTime={t.group[0]!.at} title={abs(t.group[0]!.at)} suppressHydrationWarning>{relTime(t.group[0]!.at)} ago</time>
                        <span aria-hidden className="text-ink-subtle">{openGroups[t.id] ? "−" : "+"}</span>
                      </button>
                      {openGroups[t.id] && <ol className="mt-2 space-y-2">{t.group.map(renderEntry)}</ol>}
                    </li>
                  ) : (
                    renderEntry(t)
                  ),
                )}
              </ol>
              <form onSubmit={(e) => { e.preventDefault(); void submit(); }} className="relative mt-4">
                <label htmlFor="comment-box" className="sr-only">Comment</label>
                <textarea
                  id="comment-box" ref={ta} value={body} rows={3}
                  placeholder="Leave a comment. Mention an agent with @ to hand it this issue."
                  aria-autocomplete="list" aria-controls={mention ? "mention-list" : undefined}
                  onChange={(e) => onChange(e.target.value, e.target.selectionStart)}
                  onKeyDown={(e) => {
                    if (mention && mentionOptions.length) {
                      if (e.key === "ArrowDown") { e.preventDefault(); setMi((i) => Math.min(i + 1, mentionOptions.length - 1)); return; }
                      if (e.key === "ArrowUp") { e.preventDefault(); setMi((i) => Math.max(i - 1, 0)); return; }
                      if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); insertMention(mentionOptions[mi]!.name); return; }
                      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setMention(null); return; }
                    }
                    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); void submit(); }
                  }}
                  className="w-full resize-y rounded-sm border border-control bg-surface-2 px-3 py-2 text-[14px] text-ink placeholder:text-ink-subtle"
                />
                {mention && mentionOptions.length > 0 && (
                  <ul id="mention-list" role="listbox" aria-label="Mention" className="absolute bottom-full left-0 z-10 mb-1 w-64 overflow-hidden rounded-md border border-lining-strong bg-surface-3 p-1">
                    {mentionOptions.map((o, i) => (
                      <li key={o.id} role="option" aria-selected={i === mi} onMouseDown={(e) => { e.preventDefault(); insertMention(o.name); }} className={`flex h-8 cursor-pointer items-center gap-2 rounded-xs px-2 text-[13px] ${i === mi ? "bg-surface-4 text-ink" : "text-ink-muted"}`}>
                        <Assignee type={o.agent ? "agent" : "human"} name={o.name} size={16} />@{o.name}{o.agent && <span className="ml-auto text-[11px] text-ink-subtle">agent</span>}
                      </li>
                    ))}
                  </ul>
                )}
                <div className="mt-2 flex items-center justify-between">
                  <span className="text-[11px] text-ink-subtle"><Kbd>⌘⏎</Kbd> to comment · draft auto-saves</span>
                  <button type="submit" disabled={sending || !body.trim()} className="h-8 rounded-sm bg-accent px-3 text-[13px] font-medium text-on-accent hover:bg-accent-hover disabled:opacity-50">Comment</button>
                </div>
              </form>
            </section>
          </div>

          <aside aria-label="Properties" className="lg:sticky lg:top-0 lg:self-start">
            <h2 className="px-2 pb-1 text-[11px] font-medium uppercase tracking-[0.4px] text-ink-subtle">Properties</h2>
            <div className="space-y-0.5">
              <button ref={stateBtn} type="button" className={prop} onClick={(e) => editors.pickState(e.currentTarget, [like])} aria-label={`State: ${STATE_LABEL[issue.state]}. Change`}>
                <StateGlyph state={issue.state} labelled={false} />{STATE_LABEL[issue.state]}<span className="ml-auto"><Kbd>s</Kbd></span>
              </button>
              <button ref={prioBtn} type="button" className={prop} onClick={(e) => editors.pickPriority(e.currentTarget, [like])} aria-label={`Priority: ${PRIORITY_LABEL[issue.priority]}. Change`}>
                <PriorityGlyph priority={issue.priority} />{PRIORITY_LABEL[issue.priority]}<span className="ml-auto"><Kbd>p</Kbd></span>
              </button>
              <button ref={assignBtn} type="button" className={prop} onClick={(e) => editors.pickAssignee(e.currentTarget, [like])} aria-label={`Assignee: ${assigneeName ?? "Unassigned"}. Change`}>
                <Assignee type={issue.assigneeType} name={assigneeName} size={16} />{assigneeName ?? "Unassigned"}{issue.assigneeType === "agent" && <span className="text-[12px] text-ink-subtle">agent</span>}<span className="ml-auto"><Kbd>a</Kbd></span>
              </button>
            </div>
            <dl className="mt-4 space-y-3 px-2 text-[13px]">
              <div>
                <dt className="text-[12px] text-ink-subtle">Labels</dt>
                <dd className="mt-1">
                  {issue.labels.length === 0 ? <span className="text-ink-subtle">None</span> : (
                    <ul className="flex flex-wrap gap-1.5">{issue.labels.map((l) => <li key={l.id} className="flex items-center gap-1.5 rounded-full border border-lining px-2 py-0.5 text-[12px] text-ink-muted"><span aria-hidden className="h-2 w-2 rounded-full" style={{ background: l.color }} />{l.name}</li>)}</ul>
                  )}
                </dd>
              </div>
              <div>
                <dt className="text-[12px] text-ink-subtle">Cycle</dt>
                <dd><button type="button" className="-ml-2 mt-0.5 h-7 w-full rounded-sm px-2 text-left text-ink hover:bg-surface-2" aria-label={`Cycle: ${cycle ? `Cycle ${cycle.number}` : "none"}. Change`} onClick={(e) => editors.pickCycle(e.currentTarget, [like])}>{cycle ? `${meta.teams.find((t) => t.id === cycle.teamId)?.key ?? ""} Cycle ${cycle.number}${cycle.name ? ` · ${cycle.name}` : ""}` : <span className="text-ink-subtle">No cycle</span>}</button></dd>
              </div>
              <div>
                <dt className="text-[12px] text-ink-subtle">Project</dt>
                <dd><button type="button" className="-ml-2 mt-0.5 h-7 w-full rounded-sm px-2 text-left text-ink hover:bg-surface-2" aria-label={`Project: ${project?.name ?? "none"}. Change`} onClick={(e) => editors.pickProject(e.currentTarget, [like])}>{project?.name ?? <span className="text-ink-subtle">No project</span>}</button></dd>
              </div>
              <div>
                  <dt><label htmlFor="estimate" className="text-[12px] text-ink-subtle">Estimate</label></dt>
                  <dd><input id="estimate" type="number" min={0} inputMode="numeric" defaultValue={issue.estimate ?? ""} key={`est-${issue.estimate}`} placeholder="none" onBlur={(e) => { const v = e.currentTarget.value === "" ? null : Math.max(0, Math.round(Number(e.currentTarget.value))); if (v !== (issue.estimate ?? null)) void apply([{ key: issue.key, patch: { estimate: v }, prior: { estimate: issue.estimate ?? null } }], `${issue.key} estimate updated`); }} className="mt-0.5 h-8 w-full rounded-sm border border-control bg-transparent px-2 text-[13px] tabular-nums" /></dd>
                </div>
                <div>
                  <dt><label htmlFor="due" className="text-[12px] text-ink-subtle">Due</label></dt>
                  <dd><input id="due" type="date" defaultValue={issue.dueDate ? issue.dueDate.slice(0, 10) : ""} key={`due-${issue.dueDate}`} onChange={(e) => { const v = e.currentTarget.value ? new Date(`${e.currentTarget.value}T12:00:00Z`).toISOString() : null; void apply([{ key: issue.key, patch: { dueDate: v }, prior: { dueDate: issue.dueDate ?? null } }], `${issue.key} due date updated`); }} className="mt-0.5 h-8 w-full rounded-sm border border-control bg-transparent px-1.5 text-[12px]" /></dd>
                </div>
              <div>
                <dt className="text-[12px] text-ink-subtle">Created</dt>
                <dd className="text-ink-muted" title={abs(issue.createdAt)} suppressHydrationWarning>{relTime(issue.createdAt)} ago by {creator}</dd>
              </div>
              <div>
                <dt className="text-[12px] text-ink-subtle">Updated</dt>
                <dd className="text-ink-muted" title={abs(issue.updatedAt)} suppressHydrationWarning>{relTime(issue.updatedAt)} ago</dd>
              </div>
            </dl>
          </aside>
        </div>
      </div>
    </main>
  );
}
