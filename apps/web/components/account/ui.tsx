"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";

// Shared pieces for the account-lifecycle screens (Settings > Account,
// Settings > Workspace, password reset, email verification). Token classes
// only; see docs/design/silver-lining.md.

export const field =
  "mt-1 w-full rounded-sm border border-control bg-surface-2 px-3 py-2 text-sm text-ink outline-none focus:border-lining-strong";
export const labelCls = "mt-4 block text-xs text-ink-subtle";
export const primaryBtn =
  "inline-flex min-h-8 items-center justify-center rounded-sm bg-accent px-3 py-1.5 text-[13px] font-medium text-on-accent hover:bg-accent-hover disabled:opacity-60";
export const ghostBtn =
  "inline-flex min-h-8 items-center justify-center rounded-sm border border-control px-3 py-1.5 text-[13px] text-ink-muted hover:bg-surface-2 hover:text-ink disabled:opacity-60";
export const dangerBtn =
  "inline-flex min-h-8 items-center justify-center rounded-sm border border-urgent px-3 py-1.5 text-[13px] font-medium text-urgent hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-60";

export function Panel({
  title,
  hint,
  children,
  tone,
}: {
  title: string;
  hint?: ReactNode;
  children?: ReactNode;
  tone?: "danger";
}) {
  const id = useId();
  return (
    <section
      aria-labelledby={id}
      className={`rounded-md border bg-surface-1 p-5 ${tone === "danger" ? "border-urgent" : "border-lining"}`}
    >
      <h2 id={id} className="text-sm font-semibold text-ink">
        {title}
      </h2>
      {hint && <div className="mt-1 text-[13px] text-ink-muted">{hint}</div>}
      {children}
    </section>
  );
}

// status is never color alone: a shape glyph and a text label ride along
export function Notice({
  tone,
  title,
  children,
}: {
  tone: "error" | "attention" | "healthy";
  title: string;
  children?: ReactNode;
}) {
  const color = tone === "error" ? "text-urgent" : tone === "attention" ? "text-attention" : "text-healthy";
  const glyph = tone === "error" ? "✕" : tone === "attention" ? "!" : "✓";
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className="rounded-md border border-lining-bright bg-surface-1 p-4"
    >
      <p className={`flex items-center gap-2 text-sm font-medium ${color}`}>
        <span aria-hidden="true" className="font-mono">
          {glyph}
        </span>
        {title}
      </p>
      {children && <div className="mt-2 text-[13px] text-ink-muted">{children}</div>}
    </div>
  );
}

export async function errorMessage(res: Response, fallback: string): Promise<string> {
  const d = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
  return d?.error?.message ?? fallback;
}

/**
 * Typed confirmation for irreversible actions (Silver Lining section 7):
 * the confirm button stays disabled until the user types `expected` exactly.
 * Esc or Cancel closes and returns focus to the control that opened it.
 */
export function TypeToConfirm({
  title,
  expected,
  inputLabel,
  confirmLabel,
  busy,
  error,
  onConfirm,
  onCancel,
  children,
}: {
  title: string;
  expected: string;
  inputLabel: string;
  confirmLabel: string;
  busy?: boolean;
  error?: string | null;
  onConfirm: (typed: string) => void;
  onCancel: () => void;
  children?: ReactNode;
}) {
  const [typed, setTyped] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const inputId = useId();
  const matches = typed.trim() === expected;
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    inputRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      opener?.focus?.();
    };
  }, [onCancel]);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-scrim px-4">
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onSubmit={(e) => {
          e.preventDefault();
          if (matches && !busy) onConfirm(typed.trim());
        }}
        className="w-full max-w-md rounded-md border border-lining bg-surface-1 p-5"
      >
        <h2 id={titleId} className="text-sm font-semibold text-ink">
          {title}
        </h2>
        <div className="mt-2 space-y-2 text-[13px] text-ink-muted">{children}</div>
        <label htmlFor={inputId} className={labelCls}>
          {inputLabel}
        </label>
        <input
          id={inputId}
          ref={inputRef}
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          autoComplete="off"
          spellCheck={false}
          className={`${field} font-mono`}
        />
        {error && (
          <p role="alert" className="mt-3 text-[13px] text-urgent">
            {error}
          </p>
        )}
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <button type="button" onClick={onCancel} className={ghostBtn}>
            Cancel
          </button>
          <button type="submit" disabled={!matches || busy} className={dangerBtn}>
            {busy ? "Working…" : confirmLabel}
          </button>
        </div>
      </form>
    </div>
  );
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}
