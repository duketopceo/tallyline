import { PageHeader } from "@/components/app/page-header";
import { ErrorState } from "@/components/primitives";
import { WelcomeChecklist } from "@/components/welcome-checklist";
import { api, type Me } from "@/lib/api";
import { adminChecklist, memberChecklist, type SystemStatus } from "@/lib/setup-checklist";

// First-run checklist (S2-U3). Admins see the install's health from
// GET /system/status; everyone else gets a short getting-started list that says
// nothing about the server. Read-only: every step links to where it is fixed.
export default async function WelcomePage() {
  const me = await api<Me>("/v1/auth/me");
  if (!me.data) return <main className="p-8 text-sm text-ink-subtle">Not signed in.</main>;
  const slug = me.data.workspaceSlug;
  const role = me.data.memberships.find((m) => m.workspaceSlug === slug)?.role ?? "member";
  const isAdmin = role === "admin" || role === "owner";

  if (!isAdmin) {
    return (
      <main className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <PageHeader title="Welcome" />
        <WelcomeChecklist steps={memberChecklist(null)} workspace={slug} heading="Getting started" />
      </main>
    );
  }

  const res = await api<SystemStatus>(`/v1/workspaces/${slug}/system/status`);
  if (!res.data) {
    return (
      <main className="flex min-h-0 flex-1 flex-col">
        <PageHeader title="Welcome" />
        <div className="p-4">
          <ErrorState
            title="The setup checklist did not load"
            detail="The API did not answer. Nothing was changed."
            actionLabel="Retry"
            actionHref="/welcome"
          />
        </div>
      </main>
    );
  }
  return (
    <main className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <PageHeader title="Welcome" />
      <WelcomeChecklist steps={adminChecklist(res.data)} workspace={slug} heading="Set up your Tallyline" />
    </main>
  );
}
