"use client";

<<<<<<< HEAD
import { useEffect, useState } from "react";
=======
import type { IssueState } from "@tallyline/types";
import { legalTransitions } from "@tallyline/types";
import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useState } from "react";
import { failureMessage } from "@/lib/plan-limit";
>>>>>>> db7ef51 (feat(web): Settings > Usage, plan-limit copy, public legal and trust pages)

// LLM assist: renders nothing when the workspace has no TALLYLINE_LLM_*
// configured; the status probe keeps the UI honest instead of showing a
// button that always 503s. No sparkle: the glint means "an agent touched this".
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
          try {
            const res = await fetch(`/api/issues/${issueKey}/summarize`, { method: "POST" });
            const body = (await res.json().catch(() => null)) as { summary?: string } | null;
            if (!res.ok || !body?.summary) return setError("Summary unavailable. LLM assist may be misconfigured.");
            setSummary(body.summary);
          } catch {
            setError("Summary unavailable. LLM assist may be misconfigured.");
          } finally {
            setBusy(false);
          }
        }}
        className="h-7 rounded-sm border border-control px-2.5 text-[12px] text-ink-muted hover:bg-surface-2 hover:text-ink disabled:opacity-50"
      >
        {busy ? "Summarizing" : "Summarize"}
      </button>
      {error && <span className="ml-2 text-[12px] text-urgent" role="alert">{error}</span>}
      {summary && <p className="mt-2 max-w-[72ch] border-l-2 border-lining-strong pl-3 text-[13px] leading-relaxed text-ink-muted">{summary}</p>}
    </div>
  );
}
<<<<<<< HEAD
=======

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
      setError(await failureMessage(res, "comment failed to post — retry"));
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
        <span className="font-mono text-[10px] text-ink-tertiary">
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
>>>>>>> db7ef51 (feat(web): Settings > Usage, plan-limit copy, public legal and trust pages)
