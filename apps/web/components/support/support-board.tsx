"use client";

import type { IssueState } from "@tallyline/types";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { StateGlyph } from "@/components/app/ui";
import { useMeta } from "@/components/app/providers";
import { useToast } from "@/components/app/toast";
import { relTime } from "@/lib/format";
import {
  isSupportKind,
  KIND_FILTERS,
  KIND_LABEL,
  kindTone,
  reporterLabel,
  type SupportKind,
} from "./kind";

// Helpdesk (plan 2026-11-03 U6): intake-origin reports, filtered by kind and
// project, with a thread view whose reply box can mark the reply public. A
// public reply is exactly what the reporter's follow-up handle shows, so the
// checkbox is the delivery decision — it is never implied.

export interface SupportReporter {
  name: string | null;
  email: string | null;
}

export interface SupportItem {
  key: string;
  title: string;
  state: IssueState;
  kind: SupportKind;
  provider: string;
  reporter: SupportReporter | null;
  handleExpired: boolean;
  publicReplies: number;
  lastPublicReplyAt: string | null;
  occurrences: number;
  projectId: string | null;
  projectName: string | null;
  createdAt: string;
}

interface ThreadComment {
  id: string;
  body: string;
  actorType: string;
  visibility: string;
  createdAt: string;
}

const THREAD_GET_TIMEOUT_MS = 15_000;

export function SupportBoard({
  items,
  truncated,
}: {
  items: SupportItem[];
  truncated: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const meta = useMeta();
  const toast = useToast();

  const kind = params.get("kind");
  const project = params.get("project");
  const activeKind = isSupportKind(kind) && kind !== "unknown" ? kind : null;

  const [selected, setSelected] = useState<string | null>(items[0]?.key ?? null);
  const [comments, setComments] = useState<ThreadComment[] | null>(null);
  const [threadError, setThreadError] = useState(false);
  const [draft, setDraft] = useState("");
  const [isPublic, setIsPublic] = useState(true);
  const [sending, setSending] = useState(false);
  const [reporterLink, setReporterLink] = useState<string | null>(null);
  const [minting, setMinting] = useState(false);

  const item = useMemo(
    () => items.find((i) => i.key === selected) ?? null,
    [items, selected],
  );

  const setFilter = useCallback(
    (next: { kind?: SupportKind | null; project?: string | null }) => {
      const sp = new URLSearchParams(params.toString());
      if ("kind" in next) {
        if (next.kind) sp.set("kind", next.kind);
        else sp.delete("kind");
      }
      if ("project" in next) {
        if (next.project) sp.set("project", next.project);
        else sp.delete("project");
      }
      const qs = sp.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [params, pathname, router],
  );

  // thread read: internal comments included, because this is the staff view
  const threadKey = item?.key ?? null;
  useEffect(() => {
    if (!threadKey) {
      setComments(null);
      return;
    }
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), THREAD_GET_TIMEOUT_MS);
    setComments(null);
    setThreadError(false);
    setReporterLink(null);
    void (async () => {
      try {
        const res = await fetch(`/api/issues/${threadKey}/comments`, {
          signal: ac.signal,
          cache: "no-store",
        });
        clearTimeout(timer);
        if (!res.ok) throw new Error(String(res.status));
        const data = (await res.json()) as { comments?: ThreadComment[] };
        if (!ac.signal.aborted) setComments(data.comments ?? []);
      } catch {
        clearTimeout(timer);
        if (!ac.signal.aborted) setThreadError(true);
      }
    })();
    return () => {
      clearTimeout(timer);
      ac.abort();
    };
  }, [threadKey]);

  const sendReply = useCallback(async () => {
    if (!item || sending) return;
    const body = draft.trim();
    if (!body) return;
    setSending(true);
    try {
      const res = await fetch(`/api/issues/${item.key}/comments`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body, public: isPublic }),
      });
      if (!res.ok) throw new Error(String(res.status));
      setDraft("");
      const read = await fetch(`/api/issues/${item.key}/comments`, {
        cache: "no-store",
      });
      if (read.ok) {
        const data = (await read.json()) as { comments?: ThreadComment[] };
        setComments(data.comments ?? []);
      }
      toast.push({
        message: isPublic
          ? `Replied to ${item.key} — visible through the reporter's link`
          : `Replied to ${item.key} — internal note, the reporter cannot see it`,
      });
      router.refresh();
    } catch {
      toast.push({
        error: true,
        message: "Reply not saved: the server rejected it. Your text is still here.",
      });
    } finally {
      setSending(false);
    }
  }, [draft, isPublic, item, router, sending, toast]);

  const mintLink = useCallback(async () => {
    if (!item || minting) return;
    setMinting(true);
    try {
      const res = await fetch(`/api/support/${item.key}/handle`, {
        method: "POST",
      });
      if (!res.ok) throw new Error(String(res.status));
      const data = (await res.json()) as { url?: string };
      if (!data.url) throw new Error("no url");
      setReporterLink(data.url);
      try {
        await navigator.clipboard.writeText(data.url);
        toast.push({ message: "Reporter link copied — share it only with the reporter" });
      } catch {
        toast.push({ message: "Reporter link ready — select it to copy" });
      }
    } catch {
      toast.push({
        error: true,
        message: "Reporter link not minted: the server rejected it.",
      });
    } finally {
      setMinting(false);
    }
  }, [item, minting, toast]);

  return (
    <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
      <section
        aria-label="Reports"
        className="flex min-h-0 w-full flex-col border-b border-lining-faint lg:w-[46%] lg:border-b-0 lg:border-r"
      >
        <div className="flex flex-wrap items-center gap-1.5 border-b border-lining-faint px-4 py-2">
          <button
            type="button"
            onClick={() => setFilter({ kind: null })}
            aria-pressed={activeKind === null}
            className={`h-7 rounded-sm border px-2 text-xs ${
              activeKind === null
                ? "border-lining-strong bg-surface-2 text-ink"
                : "border-transparent text-ink-subtle hover:bg-surface-2 hover:text-ink"
            }`}
          >
            All kinds
          </button>
          {KIND_FILTERS.map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setFilter({ kind: k })}
              aria-pressed={activeKind === k}
              className={`h-7 rounded-sm border px-2 text-xs ${
                activeKind === k
                  ? "border-lining-strong bg-surface-2 text-ink"
                  : "border-transparent text-ink-subtle hover:bg-surface-2 hover:text-ink"
              }`}
            >
              <span className={kindTone(k)}>{KIND_LABEL[k]}</span>
            </button>
          ))}
          <label className="ml-auto flex items-center gap-1.5 text-xs text-ink-subtle">
            <span className="sr-only">Filter by project</span>
            <select
              value={project ?? ""}
              onChange={(e) => setFilter({ project: e.target.value || null })}
              className="h-7 rounded-sm border border-control bg-surface-1 px-1.5 text-xs text-ink"
            >
              <option value="">All projects</option>
              {meta.projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        </div>

        {truncated && (
          <p className="border-b border-lining-faint bg-surface-2 px-4 py-1.5 text-xs text-ink-subtle">
            Showing the newest {items.length} reports; older ones are not in this
            filter yet.
          </p>
        )}

        {items.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center px-8 py-12 text-center">
            <p className="text-sm font-medium text-ink">No reports match</p>
            <p className="mt-1 max-w-sm text-body text-ink-subtle">
              {activeKind || project
                ? "Widen a filter to see more reports."
                : "Reports filed through an intake key land here."}
            </p>
          </div>
        ) : (
          <div role="list" aria-label="Reports" className="min-h-0 flex-1 overflow-y-auto scroll-quiet">
            {items.map((row) => {
              const current = row.key === selected;
              return (
                <div role="listitem" key={row.key}>
                  <button
                    type="button"
                    onClick={() => setSelected(row.key)}
                    aria-current={current ? "true" : undefined}
                    className={`flex w-full items-start gap-3 border-b border-lining-faint border-l-2 px-4 py-2.5 text-left ${
                      current
                        ? "border-l-accent bg-surface-2"
                        : "border-l-transparent hover:bg-surface-2"
                    }`}
                  >
                    <span className="mt-0.5">
                      <StateGlyph state={row.state} labelled={false} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2">
                        <span className="font-mono text-micro text-ink-subtle">{row.key}</span>
                        <span className={`text-micro font-medium ${kindTone(row.kind)}`}>
                          {KIND_LABEL[row.kind]}
                        </span>
                        <span className="truncate text-micro text-ink-tertiary">
                          {row.provider}
                        </span>
                      </span>
                      <span className="mt-0.5 block truncate text-body text-ink">
                        {row.title}
                      </span>
                      <span className="mt-1 flex items-center gap-2 text-xs text-ink-subtle">
                        <span className="truncate">{reporterLabel(row.reporter)}</span>
                        {row.handleExpired && (
                          <span className="shrink-0 text-ink-tertiary">link expired</span>
                        )}
                        {row.projectName && (
                          <span className="truncate text-ink-tertiary">{row.projectName}</span>
                        )}
                        {row.publicReplies > 0 && (
                          <span className="text-ink-tertiary">
                            {row.publicReplies} public {row.publicReplies === 1 ? "reply" : "replies"}
                          </span>
                        )}
                        <time
                          dateTime={row.createdAt}
                          className="ml-auto shrink-0 tabular-nums text-ink-tertiary"
                        >
                          {relTime(row.createdAt)}
                        </time>
                      </span>
                    </span>
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section aria-label="Report thread" className="flex min-h-0 flex-1 flex-col">
        {!item ? (
          <div className="flex flex-1 items-center justify-center px-8 text-center text-body text-ink-subtle">
            Select a report to read the thread.
          </div>
        ) : (
          <>
            <header className="border-b border-lining-faint px-4 py-2">
              <div className="flex items-center gap-2">
                <Link
                  href={`/issues/${item.key}`}
                  className="font-mono text-xs text-ink-subtle hover:text-ink"
                >
                  {item.key}
                </Link>
                <span className={`text-xs font-medium ${kindTone(item.kind)}`}>
                  {KIND_LABEL[item.kind]}
                </span>
                <StateGlyph state={item.state} />
                {item.occurrences > 1 && (
                  <span
                    title={`${item.occurrences} occurrences grouped by fingerprint`}
                    className="font-mono text-micro text-ink-subtle"
                  >
                    ×{item.occurrences}
                  </span>
                )}
              </div>
              <h2 className="mt-1 text-sm font-medium text-ink">{item.title}</h2>
              <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-subtle">
                <span>
                  Reporter <span className="text-ink-muted">{reporterLabel(item.reporter)}</span>
                  {item.handleExpired && (
                    <span className="text-attention"> · link expired</span>
                  )}
                </span>
                <span>
                  via <span className="text-ink-muted">{item.provider}</span>
                </span>
                <span>
                  opened <span className="text-ink-muted">{relTime(item.createdAt)}</span> ago
                </span>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => void mintLink()}
                  disabled={minting}
                  className="h-7 rounded-sm border border-control px-2 text-xs text-ink-muted hover:bg-surface-2 hover:text-ink disabled:opacity-60"
                >
                  {minting ? "Minting link…" : "Copy reporter link"}
                </button>
                {reporterLink && (
                  <input
                    readOnly
                    value={reporterLink}
                    aria-label="Reporter follow-up link"
                    onFocus={(e) => e.currentTarget.select()}
                    className="h-7 min-w-0 flex-1 rounded-sm border border-control bg-surface-2 px-2 font-mono text-micro text-ink-muted"
                  />
                )}
              </div>
              <p className="mt-1 text-micro text-ink-tertiary">
                The reporter link shows this report&apos;s status and its public
                replies. Share it only with that reporter.
              </p>
            </header>

            <div className="min-h-0 flex-1 overflow-y-auto scroll-quiet px-4 py-3">
              {threadError ? (
                <p role="alert" className="text-body text-urgent">
                  The thread did not load. The report is unchanged.
                </p>
              ) : comments === null ? (
                <p className="text-body text-ink-subtle">Loading the thread…</p>
              ) : comments.length === 0 ? (
                <p className="text-body text-ink-subtle">
                  Nothing here yet. A public reply is what the reporter sees.
                </p>
              ) : (
                <ul className="space-y-3">
                  {comments.map((c) => (
                    <li key={c.id} className="rounded-sm border border-lining-faint bg-surface-1 p-3">
                      <div className="flex items-center gap-2 text-micro text-ink-subtle">
                        <span className="font-medium text-ink-muted">{c.actorType}</span>
                        <span
                          className={
                            c.visibility === "public" ? "text-accent" : "text-ink-tertiary"
                          }
                        >
                          {c.visibility === "public" ? "Public" : "Internal"}
                        </span>
                        <time dateTime={c.createdAt} className="ml-auto tabular-nums">
                          {relTime(c.createdAt)}
                        </time>
                      </div>
                      <p className="mt-1 whitespace-pre-wrap text-body text-ink">{c.body}</p>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <form
              onSubmit={(e) => {
                e.preventDefault();
                void sendReply();
              }}
              className="border-t border-lining-faint px-4 py-3"
            >
              <label htmlFor="support-reply" className="text-xs text-ink-subtle">
                Reply to {reporterLabel(item.reporter)}
              </label>
              <textarea
                id="support-reply"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                rows={3}
                maxLength={50_000}
                placeholder="Tell them what happens next."
                className="mt-1 w-full rounded-sm border border-control bg-surface-1 px-2 py-1.5 text-body text-ink outline-none focus:border-lining-strong"
              />
              <div className="mt-1.5 flex flex-wrap items-center gap-3">
                <label className="flex items-center gap-1.5 text-xs text-ink-muted">
                  <input
                    type="checkbox"
                    checked={isPublic}
                    onChange={(e) => setIsPublic(e.target.checked)}
                    className="accent-accent"
                  />
                  Public reply — visible through{" "}
                  {item.reporter?.email
                    ? item.reporter.email
                    : "the reporter's link"}
                </label>
                <span className="text-micro text-ink-tertiary">
                  Unchecked replies stay internal.
                </span>
                <button
                  type="submit"
                  disabled={sending || draft.trim().length === 0}
                  className="ml-auto h-8 rounded-sm bg-accent px-3 text-body font-medium text-on-accent hover:bg-accent-hover disabled:opacity-60"
                >
                  {sending ? "Sending…" : isPublic ? "Send public reply" : "Save internal note"}
                </button>
              </div>
            </form>
          </>
        )}
      </section>
    </div>
  );
}
