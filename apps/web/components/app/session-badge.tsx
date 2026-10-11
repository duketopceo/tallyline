// Session status uses the fixed status colours plus a text label and shape
// (Silver Lining section 5/10); a running session shows a static dot, because
// nothing animates at rest.
const MAP: Record<string, { label: string; tone: string; shape: "dot" | "ring" | "x" | "check" }> = {
  queued: { label: "Queued", tone: "text-ink-muted", shape: "ring" },
  claimed: { label: "Running", tone: "text-accent", shape: "dot" },
  completed: { label: "Done", tone: "text-healthy", shape: "check" },
  dispatch_failed: { label: "Failed", tone: "text-urgent", shape: "x" },
  canceled: { label: "Canceled", tone: "text-ink-subtle", shape: "ring" },
};

export function sessionStatus(status: string) {
  return MAP[status] ?? { label: status, tone: "text-ink-muted", shape: "ring" as const };
}

export function SessionBadge({ status }: { status: string }) {
  const s = sessionStatus(status);
  return (
    <span className={`inline-flex items-center gap-1 text-[12px] font-medium ${s.tone}`}>
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
        {s.shape === "dot" && <circle cx="6" cy="6" r="3" fill="currentColor" stroke="none" />}
        {s.shape === "ring" && <circle cx="6" cy="6" r="3.5" />}
        {s.shape === "x" && <path d="M3 3l6 6M9 3l-6 6" />}
        {s.shape === "check" && <path d="M2.5 6.3l2.3 2.3 4.7-5" />}
      </svg>
      {s.label}
    </span>
  );
}
