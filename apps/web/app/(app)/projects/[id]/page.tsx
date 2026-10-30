import Link from "next/link";
import { PageHeader } from "@/components/app/page-header";
import { ProjectUpdateComposer } from "@/components/project-updates";
import { EmptyState, ErrorState, RelativeTime } from "@/components/primitives";
import type { RoadmapProject } from "@/components/roadmap-client";
import { getActorDirectory } from "@/lib/actors";
import { api, type Me } from "@/lib/api";
import { Markdown } from "@/lib/markdown";
import { HEALTH_META, updateAuthor, type ProjectUpdate } from "@/lib/project-updates";

// A project's status feed (U14): dated health notes, newest first, with a
// composer. Reads the shipped update endpoints; no new API surface.
export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const me = await api<Me>("/v1/auth/me");
  if (!me.data) return <main className="p-8 text-sm text-ink-subtle">Not signed in.</main>;
  const base = `/v1/workspaces/${me.data.workspaceSlug}`;
  const [projectsRes, updatesRes, directory] = await Promise.all([
    api<{ projects?: RoadmapProject[] }>(`${base}/projects`),
    api<{ updates?: ProjectUpdate[] }>(`${base}/projects/${encodeURIComponent(id)}/updates?limit=50`),
    getActorDirectory(me.data.workspaceSlug),
  ]);
  if (!projectsRes.ok) {
    return (
      <main className="flex min-h-0 flex-1 flex-col">
        <PageHeader title="Project" />
        <div className="p-4"><ErrorState title="The project did not load" detail="The API did not answer. Nothing was changed." actionLabel="Retry" actionHref={`/projects/${id}`} /></div>
      </main>
    );
  }
  const project = projectsRes.data?.projects?.find((p) => p.id === id);
  if (!project || updatesRes.status === 404) {
    return (
      <main className="flex min-h-0 flex-1 flex-col">
        <PageHeader title="Project not found" />
        <EmptyState title="No such project" detail="It may have been deleted, or it belongs to another workspace." />
        <p className="px-4 text-[13px]"><Link href="/projects" className="text-accent hover:underline">Back to projects</Link></p>
      </main>
    );
  }
  const updates = updatesRes.data?.updates ?? [];

  return (
    <main className="flex min-h-0 flex-1 flex-col">
      <PageHeader title={project.name}>
        <Link href="/projects" className="text-[12px] text-ink-muted hover:text-ink hover:underline">All projects</Link>
      </PageHeader>
      <div className="flex min-h-0 flex-col gap-4 overflow-y-auto p-4">
        <ProjectUpdateComposer projectId={project.id} />
        <section aria-labelledby="updates-heading" className="flex flex-col gap-3">
          <h2 id="updates-heading" className="text-[11px] uppercase text-ink-tertiary">Status updates</h2>
          {!updatesRes.ok ? (
            <ErrorState title="Updates did not load" detail="The API did not answer. Nothing was changed." actionLabel="Retry" actionHref={`/projects/${project.id}`} />
          ) : updates.length === 0 ? (
            <EmptyState title="No status updates yet" detail="Post the first one above. Draft from activity fills it in from the event log." />
          ) : (
            <ol className="flex flex-col gap-3">
              {updates.map((u) => {
                const meta = HEALTH_META[u.health];
                const author = updateAuthor(u, directory);
                return (
                  <li key={u.id} data-update-id={u.id} className="rounded-md border border-lining-faint bg-surface-2 p-4">
                    <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px]">
                      <span className={`inline-flex items-center gap-1.5 font-medium ${meta.text}`}>
                        <span aria-hidden="true" className={`inline-block h-2 w-2 rounded-full ${meta.dot}`} />
                        {meta.label}
                      </span>
                      <span className="text-ink-muted">
                        {author.name}
                        {author.isAgent && <span className="ml-1.5 rounded-sm border border-lining px-1 font-mono text-[11px] text-ink-subtle">agent</span>}
                      </span>
                      <span className="ml-auto"><RelativeTime iso={u.createdAt} /></span>
                    </div>
                    <div className="text-[13px] leading-relaxed text-ink-muted"><Markdown source={u.body} /></div>
                  </li>
                );
              })}
            </ol>
          )}
        </section>
      </div>
    </main>
  );
}
