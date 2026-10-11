"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useMeta } from "./providers";

// Live data never moves rows under the cursor (Silver Lining section 9):
// events from other actors are counted in batches of at most one per 250ms
// and surfaced as a "N new" pill; the list only changes when the user clicks.
export function useLiveCount(opts?: { enabled?: boolean }): { count: number; reset: () => void } {
  const meta = useMeta();
  const [count, setCount] = useState(0);
  const pending = useRef(0);
  const enabled = opts?.enabled ?? true;

  useEffect(() => {
    if (!enabled || typeof EventSource === "undefined") return;
    const onMessage = (msg: MessageEvent) => {
      try {
        const e = JSON.parse(msg.data as string) as { entityType?: string; action?: string; actorType?: string; actorId?: string | null };
        if (e.entityType !== "issue" || e.action === "session_update") return;
        if (e.actorType === "human" && e.actorId === meta.userId) return; // my own edit
        pending.current += 1;
      } catch {
        // malformed frame
      }
    };
    let es: EventSource | null = null;
    let cancelled = false;
    // start the stream at the newest event so history is not replayed as "new"
    void (async () => {
      let after = "";
      try {
        const r = await fetch("/api/events?limit=1", { cache: "no-store" });
        const b = r.ok ? ((await r.json()) as { events?: { id: string | number }[] }) : null;
        if (b?.events?.[0]) after = `?after=${b.events[0].id}`;
      } catch {
        // fall through: stream from now without a cursor
      }
      if (cancelled) return;
      es = new EventSource(`/api/events/stream${after}`);
      es.onmessage = onMessage;
    })();
    const t = setInterval(() => {
      if (pending.current) {
        const n = pending.current;
        pending.current = 0;
        setCount((c) => c + n);
      }
    }, 250);
    return () => {
      cancelled = true;
      clearInterval(t);
      es?.close();
    };
  }, [enabled, meta.userId]);

  const reset = useCallback(() => {
    pending.current = 0;
    setCount(0);
  }, []);
  return { count, reset };
}

export function NewPill({ count, onShow }: { count: number; onShow: () => void }) {
  if (!count) return null;
  return (
    <div className="pointer-events-none absolute inset-x-0 top-2 z-10 flex justify-center">
      <button
        type="button"
        onClick={onShow}
        data-new-pill
        className="pointer-events-auto h-7 rounded-full border border-accent bg-surface-3 px-3 text-[12px] font-medium text-accent hover:bg-surface-4"
      >
        {count} new {count === 1 ? "update" : "updates"}: show
      </button>
    </div>
  );
}
