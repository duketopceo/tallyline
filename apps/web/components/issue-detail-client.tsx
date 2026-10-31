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
      const res = await fetch(`/api/issues/${encodeURIComponent(issueKey)}/breakdown-suggest`, { method: "POST" });
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
    type Created = { ok: boolean; body: { key?: string; error?: { message?: string } } | null };
    const { ok, body }: Created = await fetch("/api/issues", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: d.title,
        ...(d.description ? { description: d.description } : {}),
        ...(teamKey ? { teamKey } : {}),
        parentId,
      }),
    })
      .then(async (res) => ({ ok: res.ok, body: (await res.json().catch(() => null)) as Created["body"] }))
      // network failure: show the error below instead of a stuck panel
      .catch(() => ({ ok: false, body: null }))
      .finally(() => setBusy(null));
    if (!ok || !body?.key) {
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

function useAiEnabled(): boolean {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    fetch("/api/llm-status")
      .then((r) => r.json())
      .then((d: { enabled?: boolean }) => setEnabled(!!d.enabled))
      .catch(() => {});
  }, []);
  return enabled;
}

async function apiMessage(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
  return body?.error?.message ?? fallback;
}

// S3-U4b: a PR description drafted from the issue. Shown for copying; nothing
// is posted anywhere.
export function PrBriefButton({ issueKey }: { issueKey: string }) {
  const enabled = useAiEnabled();
  const [brief, setBrief] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  if (!enabled) return null;

  async function draft() {
    setBusy(true);
    setError(null);
    setCopied(false);
    try {
      const res = await fetch(`/api/issues/${issueKey}/pr-brief`, { method: "POST" });
      if (!res.ok) return setError(await apiMessage(res, "PR brief unavailable right now."));
      const body = (await res.json()) as { brief?: string };
      if (!body.brief) return setError("PR brief unavailable right now.");
      setBrief(body.brief);
    } catch {
      setError("PR brief unavailable right now.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-3">
      <button type="button" disabled={busy} onClick={() => void draft()} className="h-7 rounded-sm border border-control px-2.5 text-[12px] text-ink-muted hover:bg-surface-2 hover:text-ink disabled:opacity-50">
        {busy ? "Drafting" : "Draft PR brief"}
      </button>
      {error && <span className="ml-2 text-[12px] text-urgent" role="alert">{error}</span>}
      {brief && (
        <div className="mt-2 max-w-[72ch] rounded-md border border-lining bg-surface-1 p-3">
          <pre className="whitespace-pre-wrap font-mono text-[12px] leading-relaxed text-ink-muted">{brief}</pre>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard?.writeText(brief).then(() => setCopied(true), () => setError("Copy failed; select the text instead."));
              }}
              className="h-7 rounded-sm border border-control px-2.5 text-[12px] text-ink-muted hover:bg-surface-2 hover:text-ink"
            >
              {copied ? "Copied" : "Copy"}
            </button>
            <button type="button" onClick={() => setBrief(null)} className="h-7 rounded-sm px-2 text-[12px] text-ink-subtle hover:bg-surface-2">
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

interface WaitingSession {
  id: string;
  question: string;
}

// U23 + S3-U4b: an agent waiting on a person shows its question here with a
// reply box. "Draft answer" fills the box from the workspace's AI provider;
// nothing is sent until the person presses Send.
export function AgentQuestions({ issueKey }: { issueKey: string }) {
  const enabled = useAiEnabled();
  const [waiting, setWaiting] = useState<WaitingSession[]>([]);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const res = await fetch(`/api/issues/${issueKey}/agent-sessions`, { cache: "no-store" });
        if (!res.ok) return;
        const { sessions = [] } = (await res.json()) as { sessions?: { id: string; status: string }[] };
        const open = await Promise.all(
          sessions
            .filter((s) => s.status === "awaitingInput")
            .map(async (s) => {
              const r = await fetch(`/api/agent-sessions/${s.id}`, { cache: "no-store" });
              if (!r.ok) return null;
              const { activities = [] } = (await r.json()) as { activities?: { type: string; content: { body?: string } }[] };
              const asked = [...activities].reverse().find((a) => a.type === "elicitation");
              return asked?.content.body ? { id: s.id, question: asked.content.body } : null;
            }),
        );
        if (live) setWaiting(open.filter((x): x is WaitingSession => x !== null));
      } catch {
        // the comment thread still shows the question
      }
    })();
    return () => {
      live = false;
    };
  }, [issueKey]);

  if (waiting.length === 0) return null;
  return (
    <section aria-label="Agent questions" className="mt-8">
      <h2 className="text-[13px] font-semibold">Agent questions</h2>
      <ul className="mt-2 flex flex-col gap-3">
        {waiting.map((w) => (
          <AgentQuestion key={w.id} session={w} aiEnabled={enabled} onSent={() => setWaiting((cur) => cur.filter((x) => x.id !== w.id))} />
        ))}
      </ul>
    </section>
  );
}

function AgentQuestion({ session, aiEnabled, onSent }: { session: WaitingSession; aiEnabled: boolean; onSent: () => void }) {
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState<"draft" | "send" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputId = `answer-${session.id}`;

  async function draft() {
    setBusy("draft");
    setError(null);
    try {
      const res = await fetch(`/api/agent-sessions/${session.id}/answer-draft`, { method: "POST" });
      if (!res.ok) return setError(await apiMessage(res, "Draft unavailable right now."));
      const body = (await res.json()) as { draft?: string };
      if (body.draft) setReply(body.draft);
    } catch {
      setError("Draft unavailable right now.");
    } finally {
      setBusy(null);
    }
  }

  async function send() {
    const text = reply.trim();
    if (!text) return;
    setBusy("send");
    setError(null);
    try {
      const res = await fetch(`/api/agent-sessions/${session.id}/activities`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: { type: "prompt", body: text } }),
      });
      if (!res.ok) return setError(await apiMessage(res, "The reply was not sent. Your text is still here."));
      onSent();
    } catch {
      setError("The reply was not sent. Your text is still here.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <li className="rounded-md border border-lining bg-surface-1 p-3">
      <p className="text-[13px] text-ink">{session.question}</p>
      <label htmlFor={inputId} className="sr-only">Your reply</label>
      <textarea id={inputId} value={reply} onChange={(e) => setReply(e.currentTarget.value)} rows={3} maxLength={20_000} readOnly={busy !== null} placeholder="Reply to the agent" className="mt-2 w-full resize-y rounded-sm border border-control bg-transparent px-3 py-2 text-[13px] text-ink" />
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button type="button" disabled={busy !== null || !reply.trim()} onClick={() => void send()} className="h-7 rounded-sm bg-accent px-3 text-[12px] font-medium text-on-accent hover:bg-accent-hover disabled:opacity-50">
          {busy === "send" ? "Sending" : "Send"}
        </button>
        {aiEnabled && (
          <button type="button" disabled={busy !== null} onClick={() => void draft()} className="h-7 rounded-sm border border-control px-2.5 text-[12px] text-ink-muted hover:bg-surface-2 hover:text-ink disabled:opacity-50">
            {busy === "draft" ? "Drafting" : "Draft answer"}
          </button>
        )}
        {error && <span className="text-[12px] text-urgent" role="alert">{error}</span>}
      </div>
    </li>
  );
}
