// Helpdesk kind labels and the filter set (plan 2026-11-03 U6). The intake
// schema's kinds are error | bug | help | issue; `issue` is what an end user
// calls a feature request, so the helpdesk presents it that way. `unknown`
// covers a report whose provenance line was edited away.

export type SupportKind = "error" | "bug" | "help" | "issue" | "unknown";

export const KIND_LABEL: Record<SupportKind, string> = {
  error: "Error",
  bug: "Bug",
  help: "Help",
  issue: "Feature",
  unknown: "Report",
};

/** the four filterable kinds, in the order staff scan them */
export const KIND_FILTERS = ["error", "bug", "help", "issue"] as const;

const TONE: Record<SupportKind, string> = {
  error: "text-urgent",
  bug: "text-attention",
  help: "text-ink-muted",
  issue: "text-accent",
  unknown: "text-ink-subtle",
};

export function kindTone(kind: SupportKind): string {
  return TONE[kind];
}

export function isSupportKind(value: string | null | undefined): value is SupportKind {
  return (
    value === "error" ||
    value === "bug" ||
    value === "help" ||
    value === "issue" ||
    value === "unknown"
  );
}

/** "name" > "email" > a stable anonymous label — never a blank cell */
export function reporterLabel(
  reporter: { name: string | null; email: string | null } | null,
): string {
  if (reporter?.name) return reporter.name;
  if (reporter?.email) return reporter.email;
  return "Anonymous reporter";
}
