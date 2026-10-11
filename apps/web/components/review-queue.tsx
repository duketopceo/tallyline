"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { Sparkle } from "./primitives";

interface QueueRow {
  id: string;
  key: string;
  title: string;
  priority: string;
  dispatchStatus: string;
  agentName: string;
  sessionAt: string;
}

export function ReviewQueue({ queue }: { queue: QueueRow[] }) {
  const router = useRouter();
  const [rows] = useState(queue);
  const [cursor, setCursor] = useState(0);
  const [sendBackKey, setSendBackKey] = useState<string | null>(null);
  const [feedback, setFeedback] = useState("");
  const [busy, setBusy] = useState(false);
  const feedbackRef = useRef<HTMLInputElement>(null);

  const act = useCallback(
    async (key: string, action: "approve" | "send_back", fb?: string) => {
      setBusy(true);
      const res = await fetch(`/api/issues/${key}/review`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, feedback: fb }),
      });
      setBusy(false);
      if (res.ok) {
        setSendBackKey(null);
        setFeedback("");
        router.refresh();
      }
    },
    [router],
  );

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (sendBackKey !== null) {
        if (e.key === "Escape") setSendBackKey(null);
        return; // typing in the feedback box
      }
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement
      ) {
        return;
      }
      if (e.key === "j") setCursor((c) => Math.min(c + 1, rows.length - 1));
      else if (e.key === "k") setCursor((c) => Math.max(c - 1, 0));
      else if (e.key === "a" && rows[cursor]) {
        void act(rows[cursor]!.key, "approve");
      } else if (e.key === "x" && rows[cursor]) {
        setSendBackKey(rows[cursor]!.key);
      } else if (e.key === "Enter" && rows[cursor]) {
        router.push(`/issues/${rows[cursor]!.key}`);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [rows, cursor, sendBackKey, act, router]);

  useEffect(() => {
    if (sendBackKey !== null) feedbackRef.current?.focus();
  }, [sendBackKey]);

  if (rows.length === 0) {
    return (
      <p className="px-4 py-8 font-mono text-xs text-ink-tertiary">
        queue empty — agent sessions that finish in review land here
      </p>
    );
  }

  return (
    <ul className="divide-y divide-lining-faint">
      {rows.map((r, i) => (
        <li
          key={r.key}
          className={`flex items-center gap-3 px-4 py-2 ${
            i === cursor ? "bg-surface-2" : ""
          }`}
        >
          <Link
            href={`/issues/${r.key}`}
            className="font-mono text-xs text-ink-tertiary hover:text-ink"
          >
            {r.key}
          </Link>
          <Sparkle size={12} label="agent session" />
          <span className="truncate text-[13px] text-ink-muted">{r.title}</span>
          <span className="ml-auto flex items-center gap-3 font-mono text-[11px] text-ink-tertiary">
            <span>@{r.agentName}</span>
            <span>{r.dispatchStatus}</span>
          </span>
          {sendBackKey === r.key ? (
            <form
              className="flex items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void act(r.key, "send_back", feedback);
              }}
            >
              <input
                ref={feedbackRef}
                value={feedback}
                onChange={(e) => setFeedback(e.target.value)}
                placeholder="feedback for the agent…"
                className="h-7 w-64 rounded-sm border border-control bg-surface-1 px-2 text-[12px] text-ink placeholder:text-ink-tertiary focus:outline-1 focus:outline-accent"
              />
              <button
                type="submit"
                disabled={busy || !feedback.trim()}
                className="h-7 rounded-sm border border-control px-2 font-mono text-[11px] text-ink-muted hover:bg-surface-2 disabled:opacity-40"
              >
                send
              </button>
            </form>
          ) : (
            <div className="flex items-center gap-1.5">
              <button
                onClick={() => void act(r.key, "approve")}
                disabled={busy}
                className="h-7 rounded-sm border border-control px-2 font-mono text-[11px] text-ink-muted hover:bg-surface-2 hover:text-ink disabled:opacity-40"
              >
                a approve
              </button>
              <button
                onClick={() => setSendBackKey(r.key)}
                className="h-7 rounded-sm border border-control px-2 font-mono text-[11px] text-ink-muted hover:bg-surface-2 hover:text-ink"
              >
                x send back
              </button>
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}
