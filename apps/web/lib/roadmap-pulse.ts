// Pure helpers behind the roadmap's at-a-glance layer: ring geometry,
// milestone status, window math and the live-event reducer. No React here, so
// every rule is unit-tested.

export interface RoadmapProjectSummary {
  projectId: string;
  total: number;
  done: number;
  closed: number;
  inProgress: number;
  inReview: number;
  byState: Record<string, number>;
  doneSince: number;
  recent: { key: string; title: string; state: string }[];
}

export interface RoadmapMilestoneSummary {
  milestoneId: string;
  total: number;
  done: number;
}

export interface RoadmapMerge {
  id: string;
  issueKey: string;
  issueTitle: string;
  projectId: string | null;
  actorName: string | null;
  actorType: string;
  at: string;
  pr: { number: number; url: string; title: string | null; repo: string | null } | null;
}

export interface RoadmapSummary {
  generatedAt: string;
  since: string;
  totals: { issues: number; done: number; closed: number; doneSince: number };
  projects: RoadmapProjectSummary[];
  milestones: RoadmapMilestoneSummary[];
  merges: RoadmapMerge[];
}

/** the slice of a feed event the live reducer reads (see GET /events/stream) */
export interface LiveFeedEvent {
  id: string;
  entityType: string;
  action: string;
  actorType: string;
  actorName: string | null;
  issueKey: string | null;
  issueTitle: string | null;
  projectId: string | null;
  before: unknown;
  after: unknown;
  createdAt: string;
}

export const EMPTY_SUMMARY: RoadmapSummary = {
  generatedAt: new Date(0).toISOString(),
  since: new Date(0).toISOString(),
  totals: { issues: 0, done: 0, closed: 0, doneSince: 0 },
  projects: [],
  milestones: [],
  merges: [],
};

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const MERGE_CAP = 40;

export type WindowKey = "today" | "24h" | "7d";
export const WINDOWS: { key: WindowKey; label: string }[] = [
  { key: "today", label: "today" },
  { key: "24h", label: "24h" },
  { key: "7d", label: "7d" },
];

/** window start as epoch ms: local midnight, or a rolling span */
export function windowStart(key: WindowKey, now: number): number {
  if (key === "24h") return now - DAY;
  if (key === "7d") return now - 7 * DAY;
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export interface RingShare {
  /** 0–100 of the ring in each band */
  done: number;
  active: number;
  /** done as a whole percent, for the centre label */
  percent: number;
}

/** closed (green) then in-flight (accent) as shares of the whole project */
export function ringShare(p: { total: number; closed: number; inProgress: number; inReview: number }): RingShare {
  if (p.total <= 0) return { done: 0, active: 0, percent: 0 };
  const closed = Math.min(p.closed, p.total);
  const active = Math.min(p.inProgress + p.inReview, p.total - closed);
  return {
    done: (closed / p.total) * 100,
    active: (active / p.total) * 100,
    percent: Math.floor((closed / p.total) * 100),
  };
}

export type MilestoneTone = "done" | "late" | "soon" | "ahead" | "undated";
export interface MilestoneStatus {
  tone: MilestoneTone;
  glyph: string;
  label: string;
  /** whole days to target (negative once past); null when done or undated */
  days: number | null;
}

const SOON_DAYS = 3;

/** text + shape, never colour alone */
export function milestoneStatus(m: { done: boolean; targetDate: string | null }, now: number): MilestoneStatus {
  if (m.done) return { tone: "done", glyph: "✓", label: "done", days: null };
  if (!m.targetDate) return { tone: "undated", glyph: "–", label: "undated", days: null };
  const days = Math.ceil((new Date(m.targetDate).getTime() - now) / DAY);
  if (days < 0) return { tone: "late", glyph: "!", label: `${-days}d late`, days };
  if (days === 0) return { tone: "soon", glyph: "▲", label: "due today", days };
  if (days <= SOON_DAYS) return { tone: "soon", glyph: "▲", label: `${days}d left`, days };
  return { tone: "ahead", glyph: "◆", label: `${days}d left`, days };
}

export function relAgo(iso: string, now: number): string {
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 45) return "now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

function str(v: unknown, k: string): string | null {
  if (!v || typeof v !== "object") return null;
  const x = (v as Record<string, unknown>)[k];
  return typeof x === "string" ? x : null;
}

/** an event that belongs on the merge ticker: a PR merge or a move into done */
export function isShipEvent(e: LiveFeedEvent): boolean {
  if (e.entityType !== "issue" || !e.issueKey) return false;
  if (e.action === "pr_merged") return true;
  return e.action === "state_changed" && str(e.after, "state") === "done" && str(e.before, "state") !== "done";
}

/**
 * Fold one live event into the summary without waiting for a refetch: the
 * ticker gains (or enriches) the issue's item, and a fresh move to done bumps
 * its project ring. A debounced refetch reconciles anything this can't know.
 */
export function applyLiveEvent(s: RoadmapSummary, e: LiveFeedEvent, sinceMs: number): RoadmapSummary {
  if (!isShipEvent(e) || new Date(e.createdAt).getTime() < sinceMs) return s;
  const key = e.issueKey!;
  const merges = [...s.merges];
  const at = merges.findIndex((m) => m.issueKey === key);
  const url = str(e.after, "url");
  const prNum = e.action === "pr_merged" && e.after && typeof e.after === "object" ? (e.after as { pr?: unknown }).pr : null;
  const pr =
    url && typeof prNum === "number" && prNum > 0
      ? { number: prNum, url, title: str(e.after, "title"), repo: str(e.after, "repo") }
      : null;
  const author = e.action === "pr_merged" ? str(e.after, "author") : null;
  if (at >= 0) {
    const prev = merges[at]!;
    merges.splice(at, 1);
    merges.unshift({
      ...prev,
      id: e.id,
      at: e.createdAt,
      pr: pr ?? prev.pr,
      // a PR merge never displaces the person who moved the ticket
      actorName: e.action === "pr_merged" ? (prev.actorName ?? author) : (e.actorName ?? prev.actorName),
      // a PR merge is recorded by the system; only a move names who acted
      actorType: e.action === "pr_merged" ? prev.actorType : e.actorType,
    });
  } else {
    merges.unshift({
      id: e.id,
      issueKey: key,
      issueTitle: e.issueTitle ?? key,
      projectId: e.projectId,
      actorName: e.actorName ?? author,
      actorType: e.actorType,
      at: e.createdAt,
      pr,
    });
  }

  let { projects, totals } = s;
  if (e.action === "state_changed") {
    const from = str(e.before, "state");
    totals = { ...totals, done: totals.done + 1, closed: totals.closed + 1, doneSince: totals.doneSince + 1 };
    if (e.projectId) {
      projects = projects.map((p) =>
        p.projectId !== e.projectId
          ? p
          : {
              ...p,
              done: p.done + 1,
              closed: p.closed + 1,
              doneSince: p.doneSince + 1,
              inProgress: p.inProgress - (from === "in_progress" ? 1 : 0),
              inReview: p.inReview - (from === "in_review" ? 1 : 0),
            },
      );
    }
  }
  return { ...s, projects, totals, merges: merges.slice(0, MERGE_CAP) };
}
