import type { IssueState, Priority } from "@tallyline/types";
import { initials, PRIORITY_LABEL, STATE_LABEL } from "@/lib/format";

// Status is never colour-only: every state has its own shape (Silver Lining
// section 5). Glyphs are 14px strokes that stay readable at 16px.
const STATE_TONE: Record<IssueState, string> = {
  triage: "text-attention",
  backlog: "text-neutral",
  todo: "text-ink-muted",
  in_progress: "text-attention",
  in_review: "text-accent",
  done: "text-healthy",
  canceled: "text-ink-tertiary",
  duplicate: "text-ink-tertiary",
};

export function StateGlyph({ state, size = 14, labelled = true }: { state: IssueState; size?: number; labelled?: boolean }) {
  const common = { width: size, height: size, viewBox: "0 0 14 14", fill: "none", stroke: "currentColor", strokeWidth: 1.5, className: `shrink-0 ${STATE_TONE[state]}` } as const;
  const a11y = labelled ? { role: "img", "aria-label": STATE_LABEL[state] } : { "aria-hidden": true };
  return (
    <svg {...common} {...a11y}>
      {state === "triage" && <circle cx="7" cy="7" r="5.25" strokeDasharray="2.2 2" />}
      {state === "backlog" && <circle cx="7" cy="7" r="5.25" strokeDasharray="1 2.2" />}
      {state === "todo" && <circle cx="7" cy="7" r="5.25" />}
      {state === "in_progress" && (<><circle cx="7" cy="7" r="5.25" /><path d="M7 3.5a3.5 3.5 0 0 1 0 7Z" fill="currentColor" stroke="none" /></>)}
      {state === "in_review" && (<><circle cx="7" cy="7" r="5.25" /><path d="M7 3.5a3.5 3.5 0 1 1-3.5 3.5H7Z" fill="currentColor" stroke="none" /></>)}
      {state === "done" && (<><circle cx="7" cy="7" r="5.25" fill="currentColor" fillOpacity=".18" /><path d="M4.6 7.2l1.7 1.7 3.1-3.4" /></>)}
      {state === "canceled" && (<><circle cx="7" cy="7" r="5.25" /><path d="M5 5l4 4M9 5l-4 4" /></>)}
      {state === "duplicate" && (<><circle cx="7" cy="7" r="5.25" /><path d="M4.8 7h4.4" /></>)}
    </svg>
  );
}

export function PriorityGlyph({ priority, size = 14 }: { priority: Priority; size?: number }) {
  const tone = priority === "urgent" ? "text-urgent" : priority === "high" ? "text-attention" : "text-ink-subtle";
  const bars = { none: 0, low: 1, medium: 2, high: 3, urgent: 3 }[priority];
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" role="img" aria-label={PRIORITY_LABEL[priority]} className={`shrink-0 ${tone}`}>
      {priority === "urgent" ? (
        <><rect x="1.5" y="1.5" width="11" height="11" rx="2.5" fill="currentColor" /><path d="M7 4v3.6M7 9.6v.1" stroke="var(--color-canvas)" strokeWidth="1.6" strokeLinecap="round" /></>
      ) : priority === "none" ? (
        <path d="M3 7h8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" opacity=".6" strokeDasharray="1.5 2" />
      ) : (
        [0, 1, 2].map((i) => (
          <rect key={i} x={2 + i * 4} y={9 - i * 3} width="2.5" height={3 + i * 3} rx=".8" fill="currentColor" opacity={i < bars ? 1 : 0.28} />
        ))
      )}
    </svg>
  );
}

export function Glint({ size = 12, label }: { size?: 12 | 16 | 20; label: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className="shrink-0 fill-accent" {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}>
      <path d="M12 1l2.6 7.4L22 11l-7.4 2.6L12 21l-2.6-7.4L2 11l7.4-2.6Z" />
    </svg>
  );
}

// human = initials disc; agent = squared chip with the glint, so the two are
// distinguishable without colour
export function Assignee({ type, name, size = 20 }: { type: "human" | "agent" | null | undefined; name: string | null; size?: number }) {
  if (!type || !name) {
    return (
      <span aria-label="Unassigned" role="img" style={{ width: size, height: size }} className="inline-flex shrink-0 items-center justify-center rounded-full border border-dashed border-lining-strong text-ink-subtle" />
    );
  }
  if (type === "agent") {
    return (
      <span title={`${name} (agent)`} role="img" aria-label={`${name}, agent`} style={{ width: size, height: size }} className="inline-flex shrink-0 items-center justify-center rounded-xs border border-lining-strong bg-surface-3">
        <Glint size={12} label="" />
      </span>
    );
  }
  return (
    <span title={name} role="img" aria-label={name} style={{ width: size, height: size }} className="inline-flex shrink-0 items-center justify-center rounded-full bg-surface-4 text-[11px] font-medium text-ink-muted">
      {initials(name)}
    </span>
  );
}

export function Kbd({ children }: { children: React.ReactNode }) {
  return <kbd className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-xs border border-lining px-1 font-mono text-[11px] text-ink-subtle">{children}</kbd>;
}

export function Skeleton({ className = "" }: { className?: string }) {
  return <div aria-hidden className={`rounded-xs bg-surface-3 ${className}`} />;
}
