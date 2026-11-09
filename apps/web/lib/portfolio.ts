// View-model for the portfolio overview. The API (GET /v1/workspaces/:ws/portfolio,
// apps/api/src/services/portfolio.ts) owns the contract; this mirrors it and holds
// the display rules, so every rule is unit-tested without React.

export interface PortfolioMilestone {
  id: string;
  title: string;
  targetDate: string | null;
  done: boolean;
  progress: { total: number; done: number };
}

export interface PortfolioActivity {
  id: number;
  action: string;
  actorType: string;
  actorName: string | null;
  issueKey: string;
  issueTitle: string;
  createdAt: string;
}

export interface PortfolioErrors {
  mapped: boolean;
  status: string | null;
  openCount: number;
  openCapped: boolean;
  stale: boolean;
  lastSyncedAt: string | null;
}

export interface PortfolioProject {
  id: string;
  name: string;
  description: string | null;
  status: string;
  iconUrl: string | null;
  teamKey: string | null;
  startDate: string | null;
  targetDate: string | null;
  createdAt: string;
  counts: Record<string, number>;
  progress: { total: number; done: number; percent: number };
  milestones: { total: number; completed: number; items: PortfolioMilestone[] };
  repos: string[];
  recent: PortfolioActivity[];
  lastActivityAt: string | null;
  errors: PortfolioErrors;
}

export interface Portfolio {
  projects: PortfolioProject[];
}

// terminal projects sink below live ones; within a group the nearest target
// date comes first, undated last, then by name so the order never jitters
const TERMINAL = new Set(["completed", "canceled"]);

export function sortProjects(projects: readonly PortfolioProject[]): PortfolioProject[] {
  return [...projects].sort((a, b) => {
    const ta = TERMINAL.has(a.status) ? 1 : 0;
    const tb = TERMINAL.has(b.status) ? 1 : 0;
    if (ta !== tb) return ta - tb;
    const da = a.targetDate ? new Date(a.targetDate).getTime() : Infinity;
    const db = b.targetDate ? new Date(b.targetDate).getTime() : Infinity;
    if (da !== db) return da < db ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

export interface PortfolioTotals {
  projects: number;
  open: number;
  inProgress: number;
  done: number;
  errors: number;
}

const OPEN_STATES = ["triage", "backlog", "todo"] as const;
const ACTIVE_STATES = ["in_progress", "in_review"] as const;

export function openCount(counts: Record<string, number>): number {
  return OPEN_STATES.reduce((n, s) => n + (counts[s] ?? 0), 0);
}

export function activeCount(counts: Record<string, number>): number {
  return ACTIVE_STATES.reduce((n, s) => n + (counts[s] ?? 0), 0);
}

export function portfolioTotals(projects: readonly PortfolioProject[]): PortfolioTotals {
  const t: PortfolioTotals = { projects: projects.length, open: 0, inProgress: 0, done: 0, errors: 0 };
  for (const p of projects) {
    t.open += openCount(p.counts);
    t.inProgress += activeCount(p.counts);
    t.done += p.counts["done"] ?? 0;
    t.errors += p.errors.openCount;
  }
  return t;
}

export interface ErrorChip {
  label: string;
  tone: string;
  glyph: string;
  /** one line for the title attribute: staleness and sync trouble in words */
  detail: string;
}

// Words and a glyph carry the meaning; color only reinforces it (DESIGN.md).
export function errorChip(e: PortfolioErrors): ErrorChip {
  if (!e.mapped) {
    return { label: "No error tracking", tone: "text-ink-subtle", glyph: "–", detail: "This project is not linked to error tracking." };
  }
  const trouble = e.status !== null && e.status !== "ok";
  const never = e.status === null && e.lastSyncedAt === null;
  if (never) {
    return { label: "Not synced yet", tone: "text-ink-subtle", glyph: "–", detail: "Errors have not been read yet." };
  }
  const count = `${e.openCount}${e.openCapped ? "+" : ""}`;
  if (e.openCount > 0) {
    const stale = e.stale || trouble ? " (last known)" : "";
    return {
      label: `${count} open ${e.openCount === 1 && !e.openCapped ? "error" : "errors"}${stale}`,
      tone: "text-urgent",
      glyph: "!",
      detail: trouble ? "Error tracking is having trouble; this is the last known count." : e.stale ? "This count is out of date." : "Up to date.",
    };
  }
  if (trouble || e.stale) {
    return {
      label: "No open errors (last known)",
      tone: "text-attention",
      glyph: "▲",
      detail: trouble ? "Error tracking is having trouble; this is the last known count." : "This count is out of date.",
    };
  }
  return { label: "No open errors", tone: "text-healthy", glyph: "●", detail: "Up to date." };
}

export function activityText(a: Pick<PortfolioActivity, "action" | "actorName" | "actorType">): string {
  const verb = a.action.replace(/[._]/g, " ");
  const who = a.actorName ?? (a.actorType === "system" ? "system" : null);
  return who ? `${verb} by ${who}` : verb;
}

/** Row focus for the list's keyboard handler: j/ArrowDown, k/ArrowUp, Home, End. Clamped, never wraps. */
export function nextRowIndex(current: number, key: string, count: number): number {
  if (count === 0) return -1;
  const last = count - 1;
  switch (key) {
    case "j":
    case "ArrowDown":
      return current < 0 ? 0 : Math.min(last, current + 1);
    case "k":
    case "ArrowUp":
      return current < 0 ? 0 : Math.max(0, current - 1);
    case "Home":
      return 0;
    case "End":
      return last;
    default:
      return current;
  }
}
