"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { SettingsTabs } from "@/components/settings-tabs";

export const field =
  "mt-1 w-full rounded-sm border border-control bg-surface-2 px-3 py-2 text-sm text-ink outline-none focus:border-lining-strong";
export const labelCls = "mt-4 block text-xs text-ink-subtle";
export const primaryBtn =
  "rounded-sm bg-accent px-3 py-1.5 text-[13px] font-medium text-on-accent hover:bg-accent-hover disabled:opacity-60";
export const ghostBtn =
  "rounded-sm border border-control px-3 py-1.5 text-[13px] text-ink-muted hover:bg-surface-2 hover:text-ink disabled:opacity-60";
export const dangerBtn =
  "rounded-sm border border-urgent px-3 py-1.5 text-[13px] font-medium text-urgent hover:bg-surface-2 disabled:opacity-60";

export function PageHeader({ title, meta }: { title: string; meta?: string }) {
  return (
    <header className="flex h-12 shrink-0 items-center gap-4 border-b border-lining-faint px-4">
      <h1 className="shrink-0 text-sm font-semibold">{title}</h1>
      <SettingsTabs />
      {meta && (
        <span className="ml-auto shrink-0 font-mono text-[11px] text-ink-tertiary">{meta}</span>
      )}
    </header>
  );
}

export function Panel({
  title,
  hint,
  children,
  id,
}: {
  title: string;
  hint?: ReactNode;
  children: ReactNode;
  id?: string;
}) {
  return (
    <section
      aria-labelledby={id}
      className="rounded-md border border-lining bg-surface-1 p-5"
    >
      <h2 id={id} className="text-sm font-semibold">
        {title}
      </h2>
      {hint && <p className="mt-1 text-xs text-ink-subtle">{hint}</p>}
      {children}
    </section>
  );
}

// DESIGN.md: attention/error = lit lining + status color + a recommended action
export function Notice({
  tone,
  title,
  children,
}: {
  tone: "error" | "attention" | "healthy";
  title: string;
  children?: ReactNode;
}) {
  const color =
    tone === "error"
      ? "text-urgent"
      : tone === "attention"
        ? "text-attention"
        : "text-healthy";
  return (
    <div
      role={tone === "healthy" ? "status" : "alert"}
      className="rounded-md border border-lining-bright bg-surface-1 p-4"
    >
      <p className={`text-sm font-medium ${color}`}>{title}</p>
      {children && <div className="mt-2 text-[13px] text-ink-muted">{children}</div>}
    </div>
  );
}

export async function errorMessage(res: Response, fallback: string): Promise<string> {
  const d = (await res.json().catch(() => null)) as {
    error?: { message?: string };
  } | null;
  return d?.error?.message ?? fallback;
}

export function ConfirmDialog({
  title,
  confirmLabel,
  onConfirm,
  onCancel,
  children,
}: {
  title: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  children: ReactNode;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    // Esc closes and focus returns to the control that opened the dialog
    const opener = document.activeElement as HTMLElement | null;
    cancelRef.current?.focus();
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-canvas/70 px-6">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        className="w-full max-w-sm rounded-md border border-lining bg-surface-1 p-5"
      >
        <h2 id="confirm-title" className="text-sm font-semibold">
          {title}
        </h2>
        <div className="mt-2 text-sm text-ink-subtle">{children}</div>
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" ref={cancelRef} onClick={onCancel} className={ghostBtn}>
            cancel
          </button>
          <button type="button" onClick={onConfirm} className={dangerBtn}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

// Plaintext credentials are shown exactly once. The value lives only in this
// component's state; dismissing it drops the last reference.
export function SecretReveal({
  label,
  value,
  onDismiss,
}: {
  label: string;
  value: string;
  onDismiss: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setCopyFailed(false);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopyFailed(true);
    }
  }
  return (
    <div
      role="status"
      aria-label={`${label} created`}
      className="mt-4 rounded-md border border-l-4 border-lining-bright border-l-attention bg-surface-2 p-4"
    >
      <p className="text-sm font-medium text-ink">
        Copy this {label} now. It is shown once and cannot be retrieved later.
      </p>
      <p
        data-testid="secret-value"
        className="mt-2 select-all break-all rounded-sm border border-lining bg-surface-1 px-3 py-2 font-mono text-xs text-ink"
      >
        {value}
      </p>
      {copyFailed && (
        <p className="mt-2 text-xs text-ink-subtle">
          Clipboard unavailable — select the value above and copy it manually.
        </p>
      )}
      <div className="mt-3 flex gap-2">
        <button type="button" onClick={copy} className={primaryBtn}>
          {copied ? "Copied" : `Copy ${label}`}
        </button>
        <button type="button" onClick={onDismiss} className={ghostBtn}>
          I have saved it
        </button>
      </div>
    </div>
  );
}

export type Scope = "read" | "write";

// Read-only is the visible default; write is an explicit, labelled opt-in.
export function ScopePicker({
  name,
  value,
  onChange,
}: {
  name: string;
  value: Scope[];
  onChange: (v: Scope[]) => void;
}) {
  const write = value.includes("write");
  return (
    <fieldset className="mt-4">
      <legend className="text-xs text-ink-subtle">Scopes</legend>
      <label className="mt-2 flex items-start gap-2 text-sm text-ink">
        <input
          type="checkbox"
          name={`${name}-read`}
          checked
          disabled
          className="mt-0.5"
          aria-describedby={`${name}-read-d`}
        />
        <span>
          read{" "}
          <span className="font-mono text-[11px] uppercase tracking-wider text-healthy">
            default
          </span>
          <span id={`${name}-read-d`} className="block text-xs text-ink-subtle">
            View issues, comments, cycles and events. Always included.
          </span>
        </span>
      </label>
      <label className="mt-2 flex items-start gap-2 text-sm text-ink">
        <input
          type="checkbox"
          name={`${name}-write`}
          checked={write}
          onChange={(e) => onChange(e.target.checked ? ["read", "write"] : ["read"])}
          className="mt-0.5"
          aria-describedby={`${name}-write-d`}
        />
        <span>
          write
          <span id={`${name}-write-d`} className="block text-xs text-ink-subtle">
            Create and change issues and post comments. Leave off unless needed.
          </span>
        </span>
      </label>
    </fieldset>
  );
}

export function ScopeBadges({ scopes }: { scopes: string[] }) {
  return (
    <span className="inline-flex gap-1">
      {scopes.map((s) => (
        <span
          key={s}
          className={`rounded-full border px-2 py-0.5 font-mono text-[11px] uppercase ${
            s === "write"
              ? "border-attention text-attention"
              : "border-lining text-ink-subtle"
          }`}
        >
          {s}
        </span>
      ))}
    </span>
  );
}

// relative within 7 days ("2h ago"), absolute after; absolute on hover
export function relTime(v: string): string {
  const diff = Date.now() - new Date(v).getTime();
  const future = diff < 0;
  const abs = Math.abs(diff);
  const min = Math.round(abs / 60_000);
  if (abs < 7 * 86_400_000) {
    const text =
      min < 1 ? "just now" : min < 60 ? `${min}m` : min < 1440 ? `${Math.round(min / 60)}h` : `${Math.round(min / 1440)}d`;
    if (text === "just now") return text;
    return future ? `in ${text}` : `${text} ago`;
  }
  return new Date(v).toLocaleDateString();
}

export function Time({ value, empty = "never" }: { value: string | null; empty?: string }) {
  if (!value) return <span className="tabular-nums">{empty}</span>;
  return (
    <time dateTime={value} title={new Date(value).toLocaleString()} className="tabular-nums">
      {relTime(value)}
    </time>
  );
}

export const fmtDate = (v: string | null): string => (v ? relTime(v) : "never");

// Reversible actions get an Undo toast instead of a confirm (silver-lining §7)
export function UndoToast({
  message,
  onUndo,
}: {
  message: string;
  onUndo: () => void;
}) {
  return (
    <div
      role="status"
      className="fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-md border border-lining-bright bg-surface-3 px-4 py-2 text-sm text-ink"
    >
      <span>{message}</span>
      <button type="button" onClick={onUndo} className="rounded-sm border border-control px-2 py-1 font-medium text-ink hover:bg-surface-4">
        Undo
      </button>
    </div>
  );
}

export function ErrorLine({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p
      role="alert"
      className="mb-3 rounded-sm border border-lining-bright px-3 py-2 text-sm text-urgent"
    >
      {message}
    </p>
  );
}
