// Repo-to-project binding and the backfill of already-synced issues (U12).
// Dry-run first: nothing is written unless `apply` is true. The backfill only
// ever fills a NULL project — an issue already in a project is never moved.
import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { githubIssueLinks, githubRepos, issues, projects } from "../db/schema.js";
import { HttpError } from "../lib/errors.js";
import { clock } from "./clock.js";

export interface RepoBackfillRow {
  fullName: string;
  projectId: string;
  projectName: string;
  /** true when this run (re)binds the repo to the project */
  bind: boolean;
  /** unassigned issues that get the project */
  assign: number;
  /** unassigned issues skipped: team-scoped project of a different team */
  skippedTeamMismatch: number;
}

export interface RepoBackfillResult {
  applied: boolean;
  repos: RepoBackfillRow[];
  /** repos with unassigned issues and no project (bound or in the map) */
  unmapped: { fullName: string; issues: number }[];
  totals: { assign: number; skippedTeamMismatch: number; unmapped: number };
}

// a project must live in the workspace; a team-scoped one only takes its own team's issues
export async function getWorkspaceProject(workspaceId: string, projectId: string) {
  const [p] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.workspaceId, workspaceId)));
  if (!p) throw new HttpError(422, "INVALID_PROJECT", "project not in workspace");
  return p;
}

export async function backfillRepoProjects(
  workspaceId: string,
  map: Record<string, string>,
  apply: boolean,
): Promise<RepoBackfillResult> {
  const repos = await db.select().from(githubRepos).where(eq(githubRepos.workspaceId, workspaceId));
  const byName = new Map(repos.map((r) => [r.fullName, r]));
  for (const name of Object.keys(map)) {
    if (!byName.has(name)) throw new HttpError(404, "NOT_FOUND", `repo '${name}' not linked`);
  }
  const projectIds = new Set([...Object.values(map), ...repos.map((r) => r.projectId).filter((x): x is string => !!x)]);
  const projectById = new Map<string, typeof projects.$inferSelect>();
  for (const id of projectIds) projectById.set(id, await getWorkspaceProject(workspaceId, id));

  // unassigned, GitHub-linked issues grouped by repo and team
  const counts = await db
    .select({ repoId: githubIssueLinks.repoId, teamId: issues.teamId, n: sql<number>`count(*)::int` })
    .from(githubIssueLinks)
    .innerJoin(issues, eq(githubIssueLinks.issueId, issues.id))
    .where(and(eq(githubIssueLinks.workspaceId, workspaceId), isNull(issues.projectId)))
    .groupBy(githubIssueLinks.repoId, issues.teamId);

  const result: RepoBackfillResult = {
    applied: apply,
    repos: [],
    unmapped: [],
    totals: { assign: 0, skippedTeamMismatch: 0, unmapped: 0 },
  };
  const plans: { repo: typeof repos[number]; project: typeof projects.$inferSelect; bind: boolean }[] = [];

  for (const repo of [...repos].sort((a, b) => a.fullName.localeCompare(b.fullName))) {
    const projectId = map[repo.fullName] ?? repo.projectId;
    const rowCounts = counts.filter((c) => c.repoId === repo.id);
    const total = rowCounts.reduce((s, c) => s + c.n, 0);
    if (!projectId) {
      if (total > 0) result.unmapped.push({ fullName: repo.fullName, issues: total });
      continue;
    }
    const project = projectById.get(projectId)!;
    const assign = rowCounts
      .filter((c) => project.teamId === null || project.teamId === c.teamId)
      .reduce((s, c) => s + c.n, 0);
    const row: RepoBackfillRow = {
      fullName: repo.fullName,
      projectId,
      projectName: project.name,
      bind: repo.projectId !== projectId,
      assign,
      skippedTeamMismatch: total - assign,
    };
    result.repos.push(row);
    result.totals.assign += assign;
    result.totals.skippedTeamMismatch += row.skippedTeamMismatch;
    plans.push({ repo, project, bind: row.bind });
  }
  result.totals.unmapped = result.unmapped.reduce((s, u) => s + u.issues, 0);

  if (apply) {
    await db.transaction(async (tx) => {
      for (const { repo, project, bind } of plans) {
        if (bind) await tx.update(githubRepos).set({ projectId: project.id }).where(eq(githubRepos.id, repo.id));
        await tx
          .update(issues)
          .set({ projectId: project.id, updatedAt: clock.now() })
          .where(
            and(
              eq(issues.workspaceId, workspaceId),
              isNull(issues.projectId),
              project.teamId ? eq(issues.teamId, project.teamId) : undefined,
              sql`${issues.id} in (select ${githubIssueLinks.issueId} from ${githubIssueLinks} where ${githubIssueLinks.repoId} = ${repo.id})`,
            ),
          );
      }
    });
  }
  return result;
}
