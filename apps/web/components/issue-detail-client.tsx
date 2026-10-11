"use client";

import { useEffect, useState } from "react";

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
          const res = await fetch(`/api/issues/${issueKey}/summarize`, { method: "POST" });
          const body = (await res.json().catch(() => null)) as { summary?: string } | null;
          setBusy(false);
          if (!res.ok || !body?.summary) return setError("Summary unavailable. LLM assist may be misconfigured.");
          setSummary(body.summary);
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
