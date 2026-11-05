import { PageHeader } from "@/components/app/page-header";
import { EmptyState, ErrorState } from "@/components/primitives";
import { isSupportKind } from "@/components/support/kind";
import {
  SupportBoard,
  type SupportItem,
} from "@/components/support/support-board";
import { api, type Me } from "@/lib/api";

// Helpdesk (plan 2026-11-03 U6). Intake-origin reports only: an outside app
// filed them with a project key, so each one has a kind, a source app and a
// reporter who can be answered through a follow-up link.
export default async function SupportPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const rawKind = typeof sp.kind === "string" ? sp.kind : null;
  const project = typeof sp.project === "string" ? sp.project : null;
  const kind = isSupportKind(rawKind) ? rawKind : null;

  const me = await api<Me>("/v1/auth/me");
  if (!me.data) {
    return <main className="p-8 text-sm text-ink-subtle">Not signed in.</main>;
  }

  const qs = new URLSearchParams();
  if (kind) qs.set("kind", kind);
  if (project) qs.set("project", project);
  const res = await api<{ issues?: SupportItem[]; truncated?: boolean }>(
    `/v1/workspaces/${me.data.workspaceSlug}/support${qs.size ? `?${qs.toString()}` : ""}`,
  );
  if (!res.ok) {
    return (
      <main className="flex min-h-0 flex-1 flex-col">
        <PageHeader title="Support" />
        <div className="p-4">
          <ErrorState
            title="Reports did not load"
            detail="The API did not answer. Nothing was changed."
            actionLabel="Retry"
            actionHref="/support"
          />
        </div>
      </main>
    );
  }

  const items = res.data?.issues ?? [];
  const truncated = res.data?.truncated ?? false;
  return (
    <main className="flex min-h-0 flex-1 flex-col">
      <PageHeader title="Support" count={items.length} hint="reports" />
      {items.length === 0 && !kind && !project ? (
        <EmptyState
          title="No reports yet"
          detail="Reports filed by an app through an intake key land here, with the reporter's follow-up link."
        />
      ) : (
        <SupportBoard items={items} truncated={truncated} />
      )}
    </main>
  );
}
