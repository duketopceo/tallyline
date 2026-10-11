"use client";

import type { IssueState } from "@tallyline/types";
import { legalTransitions } from "@tallyline/types";
import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useState } from "react";

const NEXT_LABEL: Partial<Record<IssueState, string>> = {
  backlog: "→ backlog",
  todo: "→ todo",
  in_progress: "start work",
  in_review: "→ review",
  done: "✓ done",
  canceled: "cancel",
  duplicate: "mark duplicate",
};

export function StateActions({
  issueKey,
  state,
}: {
  issueKey: string;
  state: IssueState;
}) {
  const router = useRouter();
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const next = legalTransitions(state);

  if (next.length === 0) {
    return (
      <span className="font-mono text-[11px] text-ink-tertiary">
        terminal state
      </span>
    );
  }

  return (
    <div className="flex items-center gap-2">
      {next.map((to) => (
        <button
          key={to}
          type="button"
          disabled={pending !== null}
          onClick={async () => {
            setPending(to);
            setError(null);
            const res = await fetch(`/api/issues/${issueKey}`, {
              method: "PATCH",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ state: to }),
            });
            setPending(null);
            if (!res.ok) {
              setError("transition rejected — refresh and retry");
              return;
            }
            router.refresh();
          }}
          className={`h-7 rounded-sm px-2.5 font-mono text-[11px] transition-colors disabled:opacity-50 ${
            to === "done"
              ? "bg-healthy/20 text-healthy hover:bg-healthy/30"
              : to === "canceled" || to === "duplicate"
                ? "border border-control text-ink-subtle hover:border-urgent hover:text-urgent"
                : "border border-control text-ink-muted hover:border-accent hover:text-accent"
          }`}
        >
          {pending === to ? "…" : (NEXT_LABEL[to] ?? `→ ${to}`)}
        </button>
      ))}
      {error && (
        <span className="text-[11px] text-urgent" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

// LLM assist — renders nothing when the workspace has no TALLYLINE_LLM_*
// configured; the status probe keeps the UI honest instead of showing a
// button that always 503s.
export function SummarizeButton({ issueKey }: { issueKey: string }) {
  const [enabled, setEnabled] = useState(false);
  const [summary, setSummary] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/llm-status")
      .then((r) => r.json())
      .then((d: { enabled?: boolean }) => setEnabled(!!d.enabled))
      .catch(() => {});
  }, []);

  if (!enabled) return null;

  return (
    <div className="mt-3">
      <button
        type="button"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          const res = await fetch(`/api/issues/${issueKey}/summarize`, {
            method: "POST",
          });
          const body = (await res.json().catch(() => null)) as {
            summary?: string;
          } | null;
          setBusy(false);
          if (!res.ok || !body?.summary) {
            setError("summary unavailable — LLM assist may be misconfigured");
            return;
          }
          setSummary(body.summary);
        }}
        className="h-6 rounded-sm border border-control px-2 font-mono text-[11px] text-ink-subtle hover:border-accent hover:text-accent disabled:opacity-50"
      >
        {busy ? "summarizing…" : "✦ summarize"}
      </button>
      {error && (
        <span className="ml-2 text-[11px] text-urgent" role="alert">
          {error}
        </span>
      )}
      {summary && (
        <p className="mt-2 max-w-prose border-l-2 border-accent/40 pl-3 text-[13px] leading-relaxed text-ink-muted">
          {summary}
        </p>
      )}
    </div>
  );
}

export function CommentComposer({ issueKey }: { issueKey: string }) {
  const router = useRouter();
  const [body, setBody] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!body.trim() || submitting) return;
    setSubmitting(true);
    setError(null);
    const res = await fetch(`/api/issues/${issueKey}/comments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: body.trim() }),
    });
    setSubmitting(false);
    if (!res.ok) {
      setError("comment failed to post — retry");
      return;
    }
    setBody("");
    router.refresh();
  }

  return (
    <form
      onSubmit={submit}
      onKeyDown={(e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
          e.preventDefault();
          void submit(e);
        }
      }}
      className="mt-4"
    >
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder="Leave a comment…"
        rows={3}
        className="w-full resize-none rounded-sm border border-control bg-surface-2 px-3 py-2 text-sm text-ink placeholder:text-ink-tertiary focus:border-accent focus:outline-none"
      />
      {error && (
        <p className="mt-1 text-[12px] text-urgent" role="alert">
          {error}
        </p>
      )}
      <div className="mt-2 flex items-center justify-between">
        <span className="font-mono text-[11px] text-ink-tertiary">
          <kbd>⌘⏎</kbd> to comment
        </span>
        <button
          type="submit"
          disabled={submitting || !body.trim()}
          className="h-7 rounded-sm bg-accent px-3 text-[13px] font-medium text-on-accent hover:bg-accent-hover disabled:opacity-50"
        >
          {submitting ? "Posting…" : "Comment"}
        </button>
      </div>
    </form>
  );
}
