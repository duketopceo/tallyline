import Link from "next/link";
import { PageHeader } from "@/components/app/page-header";
import type { FeedEvent } from "@/components/activity-feed";
import type { GithubRepoRow } from "@/components/github-repos";
import { EmptyState, ErrorState, RelativeTime } from "@/components/primitives";
import type { RoadmapProject } from "@/components/roadmap-client";
import { api, type Me } from "@/lib/api";
import {
  countIssues,
  findRoadmapIssue,
  recentProjectEvents,
  reposForProject,
  type HealthIssue,
} from "@/lib/project-health";

// Read-only "how is each project doing" page. Composed from existing
// endpoints only: projects, issues?project=, github/repos and the event feed.
export default async function ProjectsPage() {
  const me = await api<Me>("/v1/auth/me");
  if (!me.data) return <main className="p-8 text-sm text-ink-subtle">Not signed in.</main>;
  const base = `/v1/workspaces/${me.data.workspaceSlug}`;
  const [projectsRes, reposRes, eventsRes] = await Promise.all([
    api<{ projects?: RoadmapProject[] }>(`${base}/projects`),
    api<{ repos?: GithubRepoRow[] }>(`${base}/github/repos`),
    api<{ events?: FeedEvent[] }>(`${base}/events?limit=200`),
  ]);
  if (!projectsRes.ok) {
    return (
      <main className="flex min-h-0 flex-1 flex-col">
        <PageHeader title="Projects" />
        <div className="p-4"><ErrorState title="Projects did not load" detail="The API did not answer. Nothing was changed." actionLabel="Retry" actionHref="/projects" /></div>
      </main>
    );
  }
  const projects = projectsRes.data?.projects ?? [];
  const repos = reposRes.data?.repos ?? [];
  const events = eventsRes.data?.events ?? [];
  const issueLists = await Promise.all(
    projects.map((p) =>
      api<{ issues?: HealthIssue[] }>(`${base}/issues?project=${p.id}&limit=200`),
    ),
  );

  return (
    <main className="flex min-h-0 flex-1 flex-col">
      <PageHeader title="Projects" count={projects.length} hint="projects" />
      {projects.length === 0 ? (
        <EmptyState title="No projects yet" detail="Agents or people can create one; it shows up here with its progress." />
      ) : (
        <ul className="grid gap-3 overflow-y-auto p-4 md:grid-cols-2 xl:grid-cols-3">
          {projects.map((p, idx) => {
            const res = issueLists[idx];
            const failed = !res?.ok;
            const issues = res?.data?.issues ?? [];
            const capped = issues.length >= 200;
            const counts = countIssues(issues);
            const roadmap = findRoadmapIssue(issues);
            const recent = recentProjectEvents(events, issues);
            const linked = reposForProject(repos, p.id);
            return (
              <li key={p.id} className="flex flex-col gap-3 rounded-md border border-lining-faint bg-surface-2 p-4">
                <div className="flex items-baseline gap-2">
                  <h2 className="text-[14px] font-semibold">{p.name}</h2>
                  <span className="font-mono text-[11px] uppercase text-ink-subtle">{p.status}</span>
                </div>
                {failed && <p className="text-[12px] text-attention">Issues did not load for this project; counts are unknown.</p>}
                {capped && <p className="text-[12px] text-ink-subtle">Counts cover the newest 200 issues.</p>}
                <dl className="grid grid-cols-3 gap-2 text-center">
                  {([["open", counts.open], ["in progress", counts.inProgress], ["done", counts.done]] as const).map(([label, n]) => (
                    <div key={label} className="rounded border border-lining-faint py-2">
                      <dd className="text-[17px] font-semibold tabular-nums">{n}</dd>
                      <dt className="text-[11px] text-ink-subtle">{label}</dt>
                    </div>
                  ))}
                </dl>
                <p className="text-[12px] text-ink-subtle">
                  Roadmap issue:{" "}
                  {roadmap ? (
                    <Link href={`/issues/${roadmap.key}`} className="font-mono text-ink hover:underline">
                      {roadmap.key} {roadmap.title}
                    </Link>
                  ) : (
                    "none"
                  )}
                </p>
                <p className="text-[12px] text-ink-subtle">
                  Repos:{" "}
                  {linked.length === 0 ? "none linked" : linked.map((r) => (
                    <a key={r.id} href={`https://github.com/${r.fullName}`} className="mr-2 font-mono text-ink hover:underline">
                      {r.fullName}
                    </a>
                  ))}
                </p>
                <div>
                  <h3 className="mb-1 text-[11px] uppercase text-ink-tertiary">Recent activity (last 200 workspace events)</h3>
                  {recent.length === 0 ? (
                    <p className="text-[12px] text-ink-subtle">Nothing recent.</p>
                  ) : (
                    <ul className="flex flex-col gap-1">
                      {recent.map((e) => (
                        <li key={e.id} className="flex items-center gap-2 text-[12px]">
                          <Link href={`/issues/${e.issueKey}`} className="font-mono hover:underline">{e.issueKey}</Link>
                          <span className="truncate text-ink-subtle">{e.action.replace(/[._]/g, " ")}{e.actorName ? ` by ${e.actorName}` : ""}</span>
                          <span className="ml-auto"><RelativeTime iso={e.createdAt} /></span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}
