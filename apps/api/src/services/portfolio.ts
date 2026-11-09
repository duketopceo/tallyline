// Portfolio / client overview: one read that answers "how is each project
// going" for the whole workspace. Every query is scoped by workspace_id and the
// number of queries does not depend on the number of projects.
import { and, asc, eq, isNotNull, notInArray, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { githubRepos, issues, projectMilestones, projects, teams } from "../db/schema.js";
import { workspaceErrorHealth } from "./glitchtip-sync.js";

const ISSUE_STATES = ["triage", "backlog", "todo", "in_progress", "in_review", "done", "canceled", "duplicate"] as const;
type IssueStateKey = (typeof ISSUE_STATES)[number];

/** Most milestones returned per project; the totals still cover all of them. */
export const MILESTONE_LIMIT = 8;
/** Recent events kept per project, and how far back they look. */
export const RECENT_LIMIT = 5;
export const RECENT_WINDOW_DAYS = 30;

export interface PortfolioMilestone {
  id: string;
  title: string;
  targetDate: Date | null;
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
  createdAt: Date;
}

export interface PortfolioProject {
  id: string;
  name: string;
  description: string | null;
  status: string;
  iconUrl: string | null;
  teamKey: string | null;
  startDate: Date | null;
  targetDate: Date | null;
  createdAt: Date;
  counts: Record<IssueStateKey, number>;
  /** done over total, canceled and duplicate excluded; percent is 0 when there is nothing to count */
  progress: { total: number; done: number; percent: number };
  milestones: { total: number; completed: number; items: PortfolioMilestone[] };
  repos: string[];
  recent: PortfolioActivity[];
  lastActivityAt: Date | null;
  errors: {
    mapped: boolean;
    status: string | null;
    openCount: number;
    openCapped: boolean;
    stale: boolean;
    lastSyncedAt: Date | null;
  };
}

function emptyCounts(): Record<IssueStateKey, number> {
  return Object.fromEntries(ISSUE_STATES.map((s) => [s, 0])) as Record<IssueStateKey, number>;
}

export async function portfolioForWorkspace(workspaceId: string): Promise<{ projects: PortfolioProject[] }> {
  const projectRows = await db
    .select({ project: projects, teamKey: teams.key })
    .from(projects)
    .leftJoin(teams, and(eq(teams.id, projects.teamId), eq(teams.workspaceId, workspaceId)))
    .where(eq(projects.workspaceId, workspaceId))
    .orderBy(asc(projects.createdAt));
  if (projectRows.length === 0) return { projects: [] };

  const [stateRows, milestoneRows, milestoneCounts, repoRows, recentRows, errorRows] = await Promise.all([
    db
      .select({
        projectId: issues.projectId,
        state: issues.state,
        n: sql<number>`count(*)::int`,
        lastAt: sql<string | null>`max(${issues.updatedAt})`,
      })
      .from(issues)
      .where(and(eq(issues.workspaceId, workspaceId), isNotNull(issues.projectId)))
      .groupBy(issues.projectId, issues.state),
    db
      .select()
      .from(projectMilestones)
      .where(eq(projectMilestones.workspaceId, workspaceId))
      .orderBy(asc(projectMilestones.sortOrder), asc(projectMilestones.createdAt)),
    db
      .select({
        id: issues.milestoneId,
        total: sql<number>`count(*)::int`,
        done: sql<number>`count(*) filter (where ${issues.state} = 'done')::int`,
      })
      .from(issues)
      .where(
        and(
          eq(issues.workspaceId, workspaceId),
          isNotNull(issues.milestoneId),
          notInArray(issues.state, ["canceled", "duplicate"]),
        ),
      )
      .groupBy(issues.milestoneId),
    db
      .select({ projectId: githubRepos.projectId, fullName: githubRepos.fullName })
      .from(githubRepos)
      .where(and(eq(githubRepos.workspaceId, workspaceId), isNotNull(githubRepos.projectId)))
      .orderBy(asc(githubRepos.fullName)),
    recentActivity(workspaceId),
    workspaceErrorHealth(workspaceId),
  ]);

  const countsBy = new Map<string, Record<IssueStateKey, number>>();
  const lastIssueAt = new Map<string, Date>();
  for (const r of stateRows) {
    if (!r.projectId) continue;
    const c = countsBy.get(r.projectId) ?? emptyCounts();
    c[r.state] = r.n;
    countsBy.set(r.projectId, c);
    if (r.lastAt) {
      const at = new Date(r.lastAt);
      const prev = lastIssueAt.get(r.projectId);
      if (!prev || at > prev) lastIssueAt.set(r.projectId, at);
    }
  }
  const msProgress = new Map(milestoneCounts.map((m) => [m.id, m]));
  const msBy = new Map<string, PortfolioMilestone[]>();
  for (const m of milestoneRows) {
    const p = msProgress.get(m.id);
    const list = msBy.get(m.projectId) ?? [];
    list.push({
      id: m.id,
      title: m.title,
      targetDate: m.targetDate,
      done: m.done,
      progress: { total: p?.total ?? 0, done: p?.done ?? 0 },
    });
    msBy.set(m.projectId, list);
  }
  const reposBy = new Map<string, string[]>();
  for (const r of repoRows) {
    if (!r.projectId) continue;
    reposBy.set(r.projectId, [...(reposBy.get(r.projectId) ?? []), r.fullName]);
  }
  const recentBy = new Map<string, PortfolioActivity[]>();
  for (const r of recentRows) {
    recentBy.set(r.projectId, [...(recentBy.get(r.projectId) ?? []), r.activity]);
  }
  const errorsBy = new Map(errorRows.map((e) => [e.projectId, e]));

  return {
    projects: projectRows.map(({ project: p, teamKey }) => {
      const counts = countsBy.get(p.id) ?? emptyCounts();
      const total = ISSUE_STATES.filter((s) => s !== "canceled" && s !== "duplicate").reduce((n, s) => n + counts[s], 0);
      const ms = msBy.get(p.id) ?? [];
      const recent = recentBy.get(p.id) ?? [];
      const err = errorsBy.get(p.id);
      const lastActivityAt =
        [recent[0]?.createdAt, lastIssueAt.get(p.id)]
          .filter((d): d is Date => !!d)
          .sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
      return {
        id: p.id,
        name: p.name,
        description: p.description,
        status: p.status,
        iconUrl: p.iconUrl,
        teamKey,
        startDate: p.startDate,
        targetDate: p.targetDate,
        createdAt: p.createdAt,
        counts,
        progress: { total, done: counts.done, percent: total === 0 ? 0 : Math.round((counts.done / total) * 100) },
        milestones: {
          total: ms.length,
          completed: ms.filter((m) => m.done).length,
          items: ms.slice(0, MILESTONE_LIMIT),
        },
        repos: reposBy.get(p.id) ?? [],
        recent,
        lastActivityAt,
        errors: err
          ? {
              mapped: true,
              status: err.status,
              openCount: err.openCount,
              openCapped: err.openCapped,
              stale: err.stale,
              lastSyncedAt: err.lastSyncedAt,
            }
          : { mapped: false, status: null, openCount: 0, openCapped: false, stale: false, lastSyncedAt: null },
      };
    }),
  };
}

interface RecentRow {
  projectId: string;
  activity: PortfolioActivity;
}

// Newest RECENT_LIMIT issue events per project in one statement. Only the
// action, actor name and issue key/title leave: never the before/after payloads.
async function recentActivity(workspaceId: string): Promise<RecentRow[]> {
  const res = await db.execute(sql`
    select t.id, t.action, t.actor_type, t.project_id, t.key, t.title, t.created_at,
           case when t.actor_type = 'agent' then a.name when t.actor_type = 'human' then u.name end as actor_name
    from (
      select e.id, e.action, e.actor_type, e.actor_id, e.created_at, i.key, i.title, i.project_id,
             row_number() over (partition by i.project_id order by e.id desc) as rn
      from events e
      join issues i on i.id = e.entity_id and i.workspace_id = ${workspaceId}
      where e.workspace_id = ${workspaceId}
        and e.entity_type = 'issue'
        and i.project_id is not null
        and e.created_at > now() - make_interval(days => ${RECENT_WINDOW_DAYS})
    ) t
    left join users u on u.id = t.actor_id
    left join agents a on a.id = t.actor_id
    where t.rn <= ${RECENT_LIMIT}
    order by t.project_id, t.id desc
  `);
  return (res.rows as Record<string, unknown>[]).map((r) => ({
    projectId: String(r.project_id),
    activity: {
      id: Number(r.id),
      action: String(r.action),
      actorType: String(r.actor_type),
      actorName: r.actor_name === null || r.actor_name === undefined ? null : String(r.actor_name),
      issueKey: String(r.key),
      issueTitle: String(r.title),
      createdAt: new Date(r.created_at as string | Date),
    },
  }));
}
