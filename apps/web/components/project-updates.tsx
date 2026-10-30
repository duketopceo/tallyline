"use client";

import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import {
  HEALTH_META,
  UPDATE_HEALTH,
  type UpdateHealth,
} from "@/lib/project-updates";

interface Draft {
  suggestedHealth: UpdateHealth;
  body: string;
  empty: boolean;
}

// Composer for a project's status feed. Posts through the same-origin bridge
// and refreshes the server-rendered feed; errors stay visible.
export function ProjectUpdateComposer({ projectId }: { projectId: string }) {
  const router = useRouter();
  const uid = useId();
  const [health, setHealth] = useState<UpdateHealth>("on_track");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);

  async function prefill() {
    setBusy(true);
    setStatus(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/updates`);
      const draft = (await res.json().catch(() => null)) as Draft | null;
      if (!res.ok || !draft) {
        setStatus({ ok: false, text: "The draft did not load. Nothing was changed." });
      } else if (draft.empty) {
        setStatus({ ok: true, text: "No activity since the last update, so there is nothing to draft." });
      } else {
        setHealth(draft.suggestedHealth);
        setBody(draft.body);
        setStatus({ ok: true, text: "Draft loaded. Edit it before posting." });
      }
    } catch {
      setStatus({ ok: false, text: "The draft did not load. Nothing was changed." });
    } finally {
      setBusy(false);
    }
  }

  async function post(e: React.FormEvent) {
    e.preventDefault();
    if (!body.trim() || busy) return;
    setBusy(true);
    setStatus(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/updates`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ health, body: body.trim() }),
      });
      if (!res.ok) {
        setStatus({ ok: false, text: `The update was not posted (${res.status}). Your text is still here.` });
        return;
      }
      setBody("");
      setStatus({ ok: true, text: "Update posted." });
      router.refresh();
    } catch {
      setStatus({ ok: false, text: "The update was not posted. Your text is still here." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={post} className="flex flex-col gap-3 rounded-md border border-lining-faint bg-surface-2 p-4" aria-label="Post a status update">
      <div className="flex flex-wrap items-end gap-3">
        <label htmlFor={`${uid}-health`} className="text-[12px] text-ink-subtle">
          Health
          <select
            id={`${uid}-health`}
            value={health}
            onChange={(e) => setHealth(e.target.value as UpdateHealth)}
            className="mt-1 block h-8 rounded-sm border border-control bg-surface-2 px-2 text-[13px] text-ink"
          >
            {UPDATE_HEALTH.map((h) => (
              <option key={h} value={h}>{HEALTH_META[h].label}</option>
            ))}
          </select>
        </label>
        <button
          type="button"
          onClick={() => void prefill()}
          disabled={busy}
          className="h-8 rounded-sm border border-control px-2.5 text-[12px] text-ink-muted hover:bg-surface-3 hover:text-ink disabled:opacity-50"
        >
          Draft from activity
        </button>
      </div>
      <label htmlFor={`${uid}-body`} className="text-[12px] text-ink-subtle">
        Update (markdown)
        <textarea
          id={`${uid}-body`}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={5}
          maxLength={20_000}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              void post(e as unknown as React.FormEvent);
            }
          }}
          className="mt-1 w-full resize-y rounded-sm border border-control bg-surface-2 px-3 py-2 text-[13px] text-ink"
        />
      </label>
      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={busy || !body.trim()}
          className="h-8 rounded-sm bg-accent px-3 text-[13px] font-medium text-on-accent hover:bg-accent-hover disabled:opacity-50"
        >
          Post update
        </button>
        <p role="status" aria-live="polite" className={`text-[12px] ${status && !status.ok ? "text-attention" : "text-ink-subtle"}`}>
          {status?.text ?? ""}
        </p>
      </div>
    </form>
  );
}
