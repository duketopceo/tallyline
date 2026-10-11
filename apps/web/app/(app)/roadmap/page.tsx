import { PageHeader } from "@/components/app/page-header";
import type { RoadmapCycle, RoadmapIssue, RoadmapMilestone, RoadmapProject, RoadmapTeam } from "@/components/roadmap-client";
import { RoadmapLoader } from "@/components/roadmap-loader";
import { ErrorState } from "@/components/primitives";
import { api, type Me } from "@/lib/api";

export default async function RoadmapPage() {
  const me = await api<Me>("/v1/auth/me");
  if (!me.data) return <main className="p-8 text-sm text-ink-subtle">Not signed in.</main>;
  const slug = me.data.workspaceSlug;
  const [projectsRes, cyclesRes, teamsRes, milestonesRes, issuesRes] = await Promise.all([
    api<{ projects?: RoadmapProject[] }>(`/v1/workspaces/${slug}/projects`),
    api<{ cycles?: RoadmapCycle[] }>(`/v1/workspaces/${slug}/cycles`),
    api<{ teams?: RoadmapTeam[] }>(`/v1/workspaces/${slug}/teams`),
    api<{ milestones?: RoadmapMilestone[] }>(`/v1/workspaces/${slug}/milestones`),
    api<{ issues?: RoadmapIssue[] }>(`/v1/workspaces/${slug}/issues?limit=200`),
  ]);
  if (!projectsRes.ok) {
    return (
      <main className="flex min-h-0 flex-1 flex-col">
        <PageHeader title="Roadmap" />
        <div className="p-4"><ErrorState title="The roadmap did not load" detail="The API did not answer. Nothing was changed." actionLabel="Retry" actionHref="/roadmap" /></div>
      </main>
    );
  }
  return (
    <main className="flex min-h-0 flex-1 flex-col">
      <PageHeader title="Roadmap" count={projectsRes.data?.projects?.length ?? 0} hint={`projects, ${cyclesRes.data?.cycles?.length ?? 0} cycles`} />
      <RoadmapLoader
        projects={projectsRes.data?.projects ?? []}
        cycles={cyclesRes.data?.cycles ?? []}
        teams={teamsRes.data?.teams ?? []}
        milestones={milestonesRes.data?.milestones ?? []}
        issues={issuesRes.data?.issues ?? []}
      />
    </main>
  );
}
