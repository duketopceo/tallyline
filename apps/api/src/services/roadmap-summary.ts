import { and, count, countDistinct, eq, gte, isNotNull, lte, or, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { events, issues } from "../db/schema.js";
import { clock } from "./clock.js";
import { feedEventsQuery, type FeedRow } from "./event-hub.js";

// One round trip for the roadmap's at-a-glance layer: exact per-project and
// per-milestone counts (no row cap), "done since" counts and the merge ticker.
// Everything is read from issues + the append-only event log.

const TERMINAL = ["done", "canceled", "duplicate"] as const;
const RECENT_PER_PROJECT = 15;
const MERGE_LIMIT = 40;
const MAX_WINDOW_MS = 31 * 86_400_000;
const DEFAULT_WINDOW_MS = 24 * 3_600_000;

export interface RoadmapProjectSummary {
  projectId: string;
  total: number;
  /** issues in `done` right now */
  done: number;
  /** done + canceled + duplicate: nothing left to do */
  closed: number;
  inProgress: number;
  inReview: number;
  byState: Record<string, number>;
  /** issues currently done that were moved to done inside the window */
  doneSince: number;
  /** a bounded, open-first sample for the project detail panel */
  recent: { key: string; title: string; state: string }[];
}

export interface RoadmapMilestoneSummary {
  milestoneId: string;
  total: number;
  done: number;
}

export interface RoadmapMerge {
  /** event id of the newest event behind this item (string: bigserial) */
  id: string;
  issueKey: string;
  issueTitle: string;
  projectId: string | null;
  /** human or agent who moved it, else the PR author, else null (system) */
  actorName: string | null;
  actorType: string;
  at: string;
  /** set when a GitHub PR merge is behind it */
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

export function resolveSince(raw: string | undefined, nowMs: number): Date {
  const t = raw ? Date.parse(raw) : Number.NaN;
  if (!Number.isFinite(t)) return new Date(nowMs - DEFAULT_WINDOW_MS);
  return new Date(Math.min(nowMs, Math.max(nowMs - MAX_WINDOW_MS, t)));
}

function prOf(after: unknown): RoadmapMerge["pr"] {
  if (!after || typeof after !== "object") return null;
  const a = after as Record<string, unknown>;
  const pr = typeof a.pr === "number" ? a.pr : null;
  const url = typeof a.url === "string" ? a.url : null;
  if (pr === null || !url) return null;
  return {
    number: pr,
    url,
    title: typeof a.title === "string" ? a.title : null,
    repo: typeof a.repo === "string" ? a.repo : null,
  };
}

function actorOf(row: FeedRow): string | null {
  if (row.actorType === "agent") return row.agentName;
  if (row.actorType === "human") return row.userName;
  return null;
}

/**
 * Fold the window's done/merge events into one ticker item per issue: the PR
 * (when a webhook saw one) plus whoever moved the ticket. Newest first.
 */
export function foldMerges(rows: FeedRow[]): RoadmapMerge[] {
  const byKey = new Map<string, RoadmapMerge>();
  // rows arrive newest-first; the first row seen for an issue fixes its position
  for (const r of rows) {
    if (!r.issueKey) continue;
    const pr = r.action === "pr_merged" ? prOf(r.after) : null;
    const author =
      r.action === "pr_merged" && r.after && typeof r.after === "object"
        ? ((r.after as Record<string, unknown>).author as string | undefined)
        : undefined;
    const prev = byKey.get(r.issueKey);
    if (!prev) {
      byKey.set(r.issueKey, {
        id: String(r.id),
        issueKey: r.issueKey,
        issueTitle: r.issueTitle ?? r.issueKey,
        projectId: r.projectId,
        actorName: actorOf(r) ?? author ?? null,
        actorType: r.actorType,
        at: r.createdAt.toISOString(),
        pr,
      });
      continue;
    }
    // an older event for the same issue fills what the newer one lacked
    prev.pr ??= pr;
    prev.actorName ??= actorOf(r) ?? author ?? null;
  }
  return [...byKey.values()];
}

export async function computeRoadmapSummary(
  workspaceId: string,
  since: Date,
): Promise<RoadmapSummary> {
  const [stateCounts, doneRows, recentSub, milestoneRows, mergeRows] =
    await Promise.all([
      db
        .select({ projectId: issues.projectId, state: issues.state, n: count() })
        .from(issues)
        .where(eq(issues.workspaceId, workspaceId))
        .groupBy(issues.projectId, issues.state),
      db
        .select({
          projectId: issues.projectId,
          n: countDistinct(events.entityId),
        })
        .from(events)
        .innerJoin(issues, eq(issues.id, events.entityId))
        .where(
          and(
            eq(events.workspaceId, workspaceId),
            eq(events.entityType, "issue"),
            eq(events.action, "state_changed"),
            sql`${events.after}->>'state' = 'done'`,
            gte(events.createdAt, since),
            eq(issues.state, "done"),
          ),
        )
        .groupBy(issues.projectId),
      (async () => {
        const rn = sql<number>`row_number() over (
          partition by ${issues.projectId}
          order by (${issues.state} in ('done','canceled','duplicate')), ${issues.updatedAt} desc
        )`.as("rn");
        const sub = db
          .select({
            key: issues.key,
            title: issues.title,
            state: issues.state,
            projectId: issues.projectId,
            rn,
          })
          .from(issues)
          .where(and(eq(issues.workspaceId, workspaceId), isNotNull(issues.projectId)))
          .as("t");
        return db.select().from(sub).where(lte(sub.rn, RECENT_PER_PROJECT));
      })(),
      db
        .select({
          milestoneId: issues.milestoneId,
          state: issues.state,
          n: count(),
        })
        .from(issues)
        .where(and(eq(issues.workspaceId, workspaceId), isNotNull(issues.milestoneId)))
        .groupBy(issues.milestoneId, issues.state),
      feedEventsQuery(
        and(
          eq(events.workspaceId, workspaceId),
          eq(events.entityType, "issue"),
          gte(events.createdAt, since),
          or(
            eq(events.action, "pr_merged"),
            and(
              eq(events.action, "state_changed"),
              sql`${events.after}->>'state' = 'done'`,
            ),
          ),
        ),
        "desc",
        MERGE_LIMIT * 3,
      ),
    ]);

  const doneSince = new Map<string, number>();
  for (const r of doneRows) if (r.projectId) doneSince.set(r.projectId, r.n);
  const unassignedDoneSince = doneRows.find((r) => !r.projectId)?.n ?? 0;

  const byProject = new Map<string, RoadmapProjectSummary>();
  const totals = { issues: 0, done: 0, closed: 0, doneSince: 0 };
  for (const r of stateCounts) {
    totals.issues += r.n;
    if (r.state === "done") totals.done += r.n;
    if ((TERMINAL as readonly string[]).includes(r.state)) totals.closed += r.n;
    if (!r.projectId) continue;
    let p = byProject.get(r.projectId);
    if (!p) {
      p = {
        projectId: r.projectId,
        total: 0,
        done: 0,
        closed: 0,
        inProgress: 0,
        inReview: 0,
        byState: {},
        doneSince: doneSince.get(r.projectId) ?? 0,
        recent: [],
      };
      byProject.set(r.projectId, p);
    }
    p.total += r.n;
    p.byState[r.state] = r.n;
    if (r.state === "done") p.done += r.n;
    if ((TERMINAL as readonly string[]).includes(r.state)) p.closed += r.n;
    if (r.state === "in_progress") p.inProgress += r.n;
    if (r.state === "in_review") p.inReview += r.n;
  }
  totals.doneSince = unassignedDoneSince;
  for (const p of byProject.values()) totals.doneSince += p.doneSince;

  for (const r of recentSub.sort((a, b) => Number(a.rn) - Number(b.rn))) {
    if (r.projectId) byProject.get(r.projectId)?.recent.push({ key: r.key, title: r.title, state: r.state });
  }

  const ms = new Map<string, RoadmapMilestoneSummary>();
  for (const r of milestoneRows) {
    if (!r.milestoneId) continue;
    const m = ms.get(r.milestoneId) ?? { milestoneId: r.milestoneId, total: 0, done: 0 };
    m.total += r.n;
    if (r.state === "done") m.done += r.n;
    ms.set(r.milestoneId, m);
  }

  return {
    generatedAt: clock.now().toISOString(),
    since: since.toISOString(),
    totals,
    projects: [...byProject.values()],
    milestones: [...ms.values()],
    merges: foldMerges(mergeRows).slice(0, MERGE_LIMIT),
  };
}
