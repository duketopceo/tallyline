"use client";

import { useEffect, useState } from "react";

// LLM assist: renders nothing when the workspace has no AI provider (its own
// or the server's); the status probe keeps the UI honest instead of showing a
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
            const body = (await res.json().catch(() => null)) as
              | { summary?: string; error?: { message?: string } }
              | null;
            // the API's message is plain words (limit reached, provider down)
            if (!res.ok || !body?.summary) return setError(body?.error?.message ?? "Summary unavailable right now.");
            setSummary(body.summary);
          } catch {
            setError("Summary unavailable right now.");
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

interface SubIssueDraft {
  title: string;
  description: string;
}

// S3-U4 break-down: the model proposes sub-issues, nothing is written until a
// person clicks Create on the ones they want. Created rows link to the parent.
export function BreakdownButton({
  issueKey,
  parentId,
  onCreated,
}: {
  issueKey: string;
  parentId: string | undefined;
  onCreated: () => void;
}) {
  const [enabled, setEnabled] = useState(false);
  const [drafts, setDrafts] = useState<(SubIssueDraft & { created?: string })[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/llm-status")
      .then((r) => r.json())
      .then((d: { enabled?: boolean }) => setEnabled(!!d.enabled))
      .catch(() => {});
  }, []);

  if (!enabled || !parentId) return null;
  const teamKey = issueKey.split("-")[0];

  async function suggest() {
    setBusy("suggest");
    setError(null);
    try {
      const res = await fetch(`/api/issues/${issueKey}/breakdown-suggest`, { method: "POST" });
      const body = (await res.json().catch(() => null)) as
        | { subIssues?: SubIssueDraft[]; error?: { message?: string } }
        | null;
      if (!res.ok || !body?.subIssues) {
        setError(body?.error?.message ?? "Break-down unavailable right now.");
        return;
      }
      setDrafts(body.subIssues);
    } catch {
      setError("Break-down unavailable right now.");
    } finally {
      setBusy(null);
    }
  }

  async function create(i: number) {
    const d = drafts?.[i];
    if (!d || d.created) return;
    setBusy(`create-${i}`);
    setError(null);
    const res = await fetch("/api/issues", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: d.title,
        ...(d.description ? { description: d.description } : {}),
        ...(teamKey ? { teamKey } : {}),
        parentId,
      }),
    });
    const body = (await res.json().catch(() => null)) as { key?: string; error?: { message?: string } } | null;
    setBusy(null);
    if (!res.ok || !body?.key) {
      setError(body?.error?.message ?? "Couldn't create that sub-issue.");
      return;
    }
    const createdKey = body.key;
    setDrafts((prev) => prev?.map((x, j) => (j === i ? { ...x, created: createdKey } : x)) ?? null);
    onCreated();
  }

  return (
    <div className="mt-3">
      <button
        type="button"
        disabled={busy !== null}
        onClick={() => void suggest()}
        className="h-7 rounded-sm border border-control px-2.5 text-[12px] text-ink-muted hover:bg-surface-2 hover:text-ink disabled:opacity-50"
      >
        {busy === "suggest" ? "Thinking" : drafts ? "Suggest again" : "Suggest sub-issues"}
      </button>
      {error && <span className="ml-2 text-[12px] text-urgent" role="alert">{error}</span>}
      {drafts && drafts.length === 0 && (
        <p className="mt-2 text-[13px] text-ink-subtle">This already looks small enough to do in one go.</p>
      )}
      {drafts && drafts.length > 0 && (
        <section aria-label="Suggested sub-issues" className="mt-2 max-w-[72ch]">
          <p className="text-[12px] text-ink-subtle">Suggestions only. Nothing is created until you click Create.</p>
          <ul className="mt-1 divide-y divide-lining-faint rounded-md border border-lining bg-surface-1">
            {drafts.map((d, i) => (
              <li key={`${i}-${d.title}`} className="flex items-start gap-3 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] text-ink">{d.title}</p>
                  {d.description && <p className="mt-0.5 text-[12px] text-ink-muted">{d.description}</p>}
                </div>
                {d.created ? (
                  <span className="shrink-0 font-mono text-[12px] text-healthy">{d.created}</span>
                ) : (
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() => void create(i)}
                    aria-label={`Create sub-issue: ${d.title}`}
                    className="h-7 shrink-0 rounded-sm border border-control px-2.5 text-[12px] text-ink-muted hover:bg-surface-2 hover:text-ink disabled:opacity-50"
                  >
                    {busy === `create-${i}` ? "Creating" : "Create"}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
