import type { IssueState } from "@tallyline/types";
import type { ReactNode } from "react";
import { TallyMark } from "./tally-mark";

// DESIGN.md signature primitives — the "silver lining" system.
// Sparkle = agent provenance ONLY. Render it where an agent acted, never as decoration.

export function Sparkle({
  size = 12,
  label = "agent involved",
}: {
  size?: 12 | 16 | 20;
  label?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className="shrink-0 fill-accent"
      aria-label={label}
      role="img"
    >
      <path d="M12 1l2.6 7.4L22 11l-7.4 2.6L12 21l-2.6-7.4L2 11l7.4-2.6Z" />
    </svg>
  );
}

const STATE_PILL: Record<IssueState, string> = {
  triage: "border-attention text-attention",
  backlog: "border-lining text-ink-subtle",
  todo: "border-lining text-ink-subtle",
  in_progress: "border-attention text-attention",
  in_review: "border-accent text-accent",
  done: "border-healthy text-healthy",
  canceled: "border-lining-faint text-ink-tertiary",
  duplicate: "border-lining-faint text-ink-tertiary",
};

export function StatePill({ state }: { state: IssueState }) {
  return (
    <span
      className={`rounded-full border px-2 py-0.5 font-mono text-[11px] uppercase ${STATE_PILL[state]}`}
    >
      {state.replace("_", " ")}
    </span>
  );
}

const STATE_DOT: Record<IssueState, string> = {
  triage: "bg-attention",
  backlog: "bg-neutral",
  todo: "bg-neutral",
  in_progress: "bg-attention",
  in_review: "bg-accent",
  done: "bg-healthy",
  canceled: "bg-ink-tertiary",
  duplicate: "bg-ink-tertiary",
};

export function StateDot({ state }: { state: IssueState }) {
  return (
    <span
      className={`h-2 w-2 shrink-0 rounded-full ${STATE_DOT[state]}`}
      role="img"
      aria-label={state.replace("_", " ")}
      title={state.replace("_", " ")}
    />
  );
}

// DESIGN.md invariant: attention/error states ship all three together —
// lit lining (border-lining-bright) + status color + a recommended action.
export function ErrorState({
  title,
  detail,
  actionLabel,
  onAction,
  actionHref,
}: {
  title: string;
  detail: string;
  actionLabel: string;
  onAction?: () => void;
  actionHref?: string;
}) {
  const action = actionHref ? (
    <a
      href={actionHref}
      className="h-7 rounded-sm bg-accent px-3 text-[13px] font-medium leading-7 text-on-accent hover:bg-accent-hover"
    >
      {actionLabel}
    </a>
  ) : (
    <button
      type="button"
      onClick={onAction}
      className="h-7 rounded-sm bg-accent px-3 text-[13px] font-medium text-on-accent hover:bg-accent-hover"
    >
      {actionLabel}
    </button>
  );
  return (
    <div
      className="rounded-md border border-lining-bright bg-surface-2 p-4"
      role="alert"
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-sm font-medium text-urgent">{title}</p>
          <p className="mt-1 text-[13px] text-ink-subtle">{detail}</p>
        </div>
        {action}
      </div>
    </div>
  );
}

export function EmptyState({
  title,
  detail,
  icon,
}: {
  title: string;
  detail: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center px-8 py-12 text-center">
      {icon ?? (
        <TallyMark size={40} quiet />
      )}
      <p className="mt-4 text-sm font-medium text-ink">{title}</p>
      <p className="mt-1 max-w-sm text-[13px] text-ink-subtle">{detail}</p>
    </div>
  );
}

// Loading state: quiet hairline skeleton rows, shimmer-free (DESIGN.md motion rules);
// opacity pulse is disabled under prefers-reduced-motion by globals.css.
export function LoadingState({ label }: { label: string }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex flex-1 flex-col gap-2 p-6"
    >
      <span className="font-mono text-[11px] text-ink-subtle">{label}</span>
      {[72, 56, 64, 40].map((w, i) => (
        <div
          key={i}
          className="h-9 animate-pulse rounded-xs border-b border-lining-faint"
        >
          <div
            className="mt-3 h-2 rounded-full bg-surface-3"
            style={{ width: `${w}%` }}
          />
        </div>
      ))}
    </div>
  );
}
