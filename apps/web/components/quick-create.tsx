"use client";

import { useRouter } from "next/navigation";
import {
  type FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

const DRAFT_KEY = "dok:quick-create-draft";
const DRAFT_DELAY_MS = 2000;

interface Draft {
  title: string;
  description: string;
  priority: string;
}

const EMPTY: Draft = { title: "", description: "", priority: "none" };

function loadDraft(): Draft {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (raw) return { ...EMPTY, ...(JSON.parse(raw) as Partial<Draft>) };
  } catch {
    // corrupt draft — start clean
  }
  return EMPTY;
}

function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  return (
    el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName)
  );
}

export function QuickCreate() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [restored, setRestored] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(null);

  useEffect(() => {
    document.documentElement.dataset.qcReady = "1";
    return () => {
      delete document.documentElement.dataset.qcReady;
    };
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "c" && !open && !isTypingTarget(e.target)) {
        e.preventDefault();
        setDraft(loadDraft());
        setRestored(localStorage.getItem(DRAFT_KEY) !== null);
        setOpen(true);
      } else if (e.key === "Escape" && open) {
        setOpen(false);
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  useEffect(() => {
    if (open) titleRef.current?.focus();
  }, [open]);

  const update = useCallback((patch: Partial<Draft>) => {
    setDraft((d) => {
      const next = { ...d, ...patch };
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        if (next.title || next.description) {
          localStorage.setItem(DRAFT_KEY, JSON.stringify(next));
        } else {
          localStorage.removeItem(DRAFT_KEY);
        }
      }, DRAFT_DELAY_MS);
      return next;
    });
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!draft.title.trim() || submitting) return;
    setSubmitting(true);
    setError(null);
    const res = await fetch("/api/issues", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: draft.title.trim(),
        description: draft.description || undefined,
        priority: draft.priority,
        state: "triage",
      }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as {
        error?: { message?: string };
      } | null;
      setError(body?.error?.message ?? "failed to create issue");
      setSubmitting(false);
      return;
    }
    localStorage.removeItem(DRAFT_KEY);
    setDraft(EMPTY);
    setSubmitting(false);
    setOpen(false);
    router.refresh();
  }

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-canvas/80 pt-[15vh]"
      role="dialog"
      aria-modal="true"
      aria-label="Quick create issue"
      onClick={(e) => {
        if (e.target === e.currentTarget) setOpen(false);
      }}
    >
      <form
        onSubmit={submit}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
            e.preventDefault();
            void submit(e);
          }
        }}
        className="w-full max-w-lg rounded-md border border-lining-bright bg-surface-1 shadow-lg"
      >
        <div className="flex items-center justify-between border-b border-lining-faint px-4 py-2">
          <span className="font-mono text-[11px] uppercase tracking-wider text-ink-tertiary">
            New issue → triage
          </span>
          {restored && (
            <span className="font-mono text-[11px] text-attention">
              draft restored
            </span>
          )}
        </div>
        <div className="space-y-3 px-4 py-4">
          <input
            ref={titleRef}
            value={draft.title}
            onChange={(e) => update({ title: e.target.value })}
            placeholder="Issue title"
            required
            className="w-full rounded-sm border border-control bg-surface-2 px-3 py-2 text-sm text-ink placeholder:text-ink-tertiary focus:border-accent focus:outline-none"
          />
          <textarea
            value={draft.description}
            onChange={(e) => update({ description: e.target.value })}
            placeholder="Description (optional)"
            rows={3}
            className="w-full resize-none rounded-sm border border-control bg-surface-2 px-3 py-2 text-sm text-ink placeholder:text-ink-tertiary focus:border-accent focus:outline-none"
          />
          <select
            value={draft.priority}
            onChange={(e) => update({ priority: e.target.value })}
            className="rounded-sm border border-control bg-surface-2 px-2 py-1.5 text-[13px] text-ink-muted focus:border-accent focus:outline-none"
            aria-label="Priority"
          >
            <option value="none">No priority</option>
            <option value="urgent">Urgent</option>
            <option value="high">High</option>
            <option value="medium">Medium</option>
            <option value="low">Low</option>
          </select>
        </div>
        {error && (
          <p
            className="border-t border-l-2 border-lining-faint border-l-urgent px-4 py-2 text-[13px] text-urgent"
            role="alert"
          >
            {error} — check your connection and retry.
          </p>
        )}
        <div className="flex items-center justify-between border-t border-lining-faint px-4 py-2">
          <span className="font-mono text-[11px] text-ink-tertiary">
            <kbd>⌘⏎</kbd> create · <kbd>esc</kbd> close · draft auto-saves
          </span>
          <button
            type="submit"
            disabled={submitting || !draft.title.trim()}
            className="h-7 rounded-sm bg-accent px-3 text-[13px] font-medium text-on-accent hover:bg-accent-hover disabled:opacity-50"
          >
            {submitting ? "Creating…" : "Create issue"}
          </button>
        </div>
      </form>
    </div>
  );
}
