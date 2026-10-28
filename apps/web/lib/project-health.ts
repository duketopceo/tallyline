import type { IssueState } from "@tallyline/types";

export interface HealthIssue {
  id: string;
  key: string;
  title: string;
  state: IssueState;
  parentId: string | null;
}

export interface HealthEvent {
  id: string;
  action: string;
  actorName: string | null;
  issueKey: string | null;
  issueTitle: string | null;
  createdAt: string;
}

export interface HealthRepo {
  id: string;
  fullName: string;
  projectId?: string | null;
}

export interface ProjectCounts {
  open: number;
  inProgress: number;
  done: number;
}

const OPEN: readonly IssueState[] = ["triage", "backlog", "todo"];
const IN_PROGRESS: readonly IssueState[] = ["in_progress", "in_review"];

// canceled and duplicate issues are neither open nor done, so they drop out
export function countIssues(issues: readonly HealthIssue[]): ProjectCounts {
  const counts: ProjectCounts = { open: 0, inProgress: 0, done: 0 };
  for (const i of issues) {
    if (OPEN.includes(i.state)) counts.open += 1;
    else if (IN_PROGRESS.includes(i.state)) counts.inProgress += 1;
    else if (i.state === "done") counts.done += 1;
  }
  return counts;
}

// The roadmap issue is the project's top-level issue (no parent) that parents
// the most other issues in the same project. Null when no issue parents any.
export function findRoadmapIssue(
  issues: readonly HealthIssue[],
): HealthIssue | null {
  const children = new Map<string, number>();
  for (const i of issues) {
    if (i.parentId) children.set(i.parentId, (children.get(i.parentId) ?? 0) + 1);
  }
  let best: HealthIssue | null = null;
  let bestCount = 0;
  for (const i of issues) {
    if (i.parentId !== null) continue;
    const n = children.get(i.id) ?? 0;
    if (n > bestCount) {
      best = i;
      bestCount = n;
    }
  }
  return best;
}

// events arrive newest-first; keep that order
export function recentProjectEvents(
  events: readonly HealthEvent[],
  issues: readonly HealthIssue[],
  limit = 5,
): HealthEvent[] {
  const keys = new Set(issues.map((i) => i.key));
  return events
    .filter((e) => e.issueKey !== null && keys.has(e.issueKey))
    .slice(0, limit);
}

export function reposForProject(
  repos: readonly HealthRepo[],
  projectId: string,
): HealthRepo[] {
  return repos.filter((r) => r.projectId === projectId);
}
