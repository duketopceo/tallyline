import { PageHeader } from "@/components/app/page-header";
import type { RoadmapCycle, RoadmapMilestone, RoadmapProject, RoadmapTeam } from "@/components/roadmap-client";
import { PushLoader, RoadmapLoader } from "@/components/roadmap-loader";
import { ErrorState } from "@/components/primitives";
import { api, type Me } from "@/lib/api";
import { EMPTY_SUMMARY, type RoadmapSummary } from "@/lib/roadmap-pulse";

export default async function RoadmapPage({
  searchParams,
}: {
  searchParams: Promise<{ push?: string }>;
}) {
  const { push } = await searchParams;
  const me = await api<Me>("/v1/auth/me");
  if (!me.data) return <main className="p-8 text-sm text-ink-subtle">Not signed in.</main>;
  const slug = me.data.workspaceSlug;
  // exact counts come from the roadmap summary, not a capped issue list
  const [projectsRes, cyclesRes, teamsRes, milestonesRes, summaryRes] = await Promise.all([
    api<{ projects?: RoadmapProject[] }>(`/v1/workspaces/${slug}/projects`),
    api<{ cycles?: RoadmapCycle[] }>(`/v1/workspaces/${slug}/cycles`),
    api<{ teams?: RoadmapTeam[] }>(`/v1/workspaces/${slug}/teams`),
    api<{ milestones?: RoadmapMilestone[] }>(`/v1/workspaces/${slug}/milestones`),
    api<RoadmapSummary>(`/v1/workspaces/${slug}/roadmap/summary`),
  ]);
  if (!projectsRes.ok) {
    return (
      <main className="flex min-h-0 flex-1 flex-col">
        <PageHeader title="Roadmap" />
        <div className="p-4"><ErrorState title="The roadmap did not load" detail="The API did not answer. Nothing was changed." actionLabel="Retry" actionHref="/roadmap" /></div>
      </main>
    );
  }
  const summary = summaryRes.data ?? EMPTY_SUMMARY;
  if (push === "1") {
    return (
      <PushLoader
        summary={summary}
        projects={projectsRes.data?.projects ?? []}
        milestones={milestonesRes.data?.milestones ?? []}
      />
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
        summary={summary}
      />
    </main>
  );
}
