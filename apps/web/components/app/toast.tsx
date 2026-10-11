"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

// Undo instead of confirm (Silver Lining section 7): a success toast carries
// Undo for 8s and Cmd/Ctrl+Z; error toasts persist until dismissed and are
// announced assertively. Everything else stays quiet.
export interface ToastInput {
  message: string;
  undo?: () => void | Promise<void>;
  error?: boolean;
}
interface ToastItem extends ToastInput { id: number }

const Ctx = createContext<{ push: (t: ToastInput) => void } | null>(null);
export const useToast = () => {
  const v = useContext(Ctx);
  if (!v) throw new Error("ToastProvider missing");
  return v;
};

const UNDO_MS = 8000;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const seq = useRef(0);
  const itemsRef = useRef<ToastItem[]>([]);
  itemsRef.current = items;

  const dismiss = useCallback((id: number) => setItems((l) => l.filter((t) => t.id !== id)), []);
  const push = useCallback((t: ToastInput) => {
    const id = ++seq.current;
    setItems((l) => [...l.slice(-2), { ...t, id }]);
    if (!t.error) setTimeout(() => dismiss(id), t.undo ? UNDO_MS : 4000);
  }, [dismiss]);

  const runUndo = useCallback((t: ToastItem) => {
    dismiss(t.id);
    void t.undo?.();
  }, [dismiss]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z" && !e.shiftKey)) return;
      const el = e.target;
      if (el instanceof HTMLElement && (el.isContentEditable || ["INPUT", "TEXTAREA"].includes(el.tagName))) return;
      const last = [...itemsRef.current].reverse().find((t) => t.undo);
      if (last) {
        e.preventDefault();
        runUndo(last);
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [runUndo]);

  const value = useMemo(() => ({ push }), [push]);
  return (
    <Ctx.Provider value={value}>
      {children}
      <div
        aria-label="Notifications"
        role="region"
        className="pointer-events-none fixed inset-x-0 bottom-12 z-[60] flex flex-col items-center gap-2 px-4 max-sm:bottom-16"
      >
        {items.map((t) => (
          <div
            key={t.id}
            role={t.error ? "alert" : "status"}
            data-toast
            className={`toast-in pointer-events-auto flex min-h-9 max-w-[min(32rem,100%)] items-center gap-3 rounded-md border bg-surface-3 px-3 py-1.5 text-[13px] text-ink ${t.error ? "border-urgent" : "border-lining-strong"}`}
          >
            <span className={t.error ? "text-urgent" : ""}>{t.message}</span>
            {t.undo && (
              <button
                type="button"
                onClick={() => runUndo(t)}
                className="h-6 shrink-0 rounded-xs px-1.5 text-[12px] font-medium text-accent hover:bg-surface-4"
              >
                Undo <kbd className="font-mono text-[11px] text-ink-subtle">⌘Z</kbd>
              </button>
            )}
            {t.error && (
              <button
                type="button"
                onClick={() => dismiss(t.id)}
                className="h-6 shrink-0 rounded-xs px-1.5 text-[12px] text-ink-muted hover:bg-surface-4"
              >
                Dismiss
              </button>
            )}
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}
