const UNITS: [number, string][] = [[60, "s"], [60, "m"], [24, "h"], [7, "d"], [4.345, "w"], [12, "mo"]];

// compact relative time ("3h", "2d"); deterministic given `now` so SSR and
// hydration agree when the caller passes the same reference time
export function relTime(iso: string, now = Date.now()): string {
  let n = Math.max(0, (now - new Date(iso).getTime()) / 1000);
  for (const [div, unit] of UNITS) {
    if (n < div) return `${Math.max(1, Math.floor(n))}${unit}`;
    n /= div;
  }
  return `${Math.floor(n)}y`;
}

export const PRIORITY_LABEL: Record<string, string> = {
  none: "No priority", urgent: "Urgent", high: "High", medium: "Medium", low: "Low",
};

export const STATE_LABEL: Record<string, string> = {
  triage: "Triage", backlog: "Backlog", todo: "Todo", in_progress: "In progress",
  in_review: "In review", done: "Done", canceled: "Canceled", duplicate: "Duplicate",
};

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "?") + (parts[1]?.[0] ?? "")).toUpperCase();
}
