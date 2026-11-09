import { PageHeader } from "@/components/app/page-header";
import { PortfolioOverview } from "@/components/portfolio-overview";
import { EmptyState, ErrorState } from "@/components/primitives";
import { api, type Me } from "@/lib/api";
import type { Portfolio } from "@/lib/portfolio";

// The landing page: how every project in the workspace is going. One request;
// the API does the counting, so the page never fans out per project and never
// talks to the error tracker itself.
export default async function OverviewPage() {
  const me = await api<Me>("/v1/auth/me");
  if (!me.data) return <main className="p-8 text-sm text-ink-subtle">Not signed in.</main>;
  const res = await api<Portfolio>(`/v1/workspaces/${me.data.workspaceSlug}/portfolio`);
  if (!res.ok || !res.data) {
    return (
      <main className="flex min-h-0 flex-1 flex-col">
        <PageHeader title="Overview" />
        <div className="p-4"><ErrorState title="The overview did not load" detail="The API did not answer. Nothing was changed." actionLabel="Retry" actionHref="/overview" /></div>
      </main>
    );
  }
  const projects = res.data.projects ?? [];
  return (
    <main className="flex min-h-0 flex-1 flex-col">
      <PageHeader title="Overview" count={projects.length} hint={projects.length === 1 ? "project" : "projects"} />
      {projects.length === 0 ? (
        <EmptyState title="No projects yet" detail="When a project is created it shows up here with its tickets, progress and recent activity." />
      ) : (
        <PortfolioOverview projects={projects} now={Date.now()} />
      )}
    </main>
  );
}
