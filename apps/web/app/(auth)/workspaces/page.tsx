import { redirect } from "next/navigation";
import { api, type Me } from "@/lib/api";
import { WorkspaceChooser } from "@/components/workspace-chooser";
import { DEFAULT_LANDING } from "@/lib/landing";

// session-gated workspace picker — lives under (auth), not (app): the app
// shell renders Sidebar/CommandPalette bound to a workspaceSlug, which is
// exactly what's being resolved here
export default async function WorkspacesPage() {
  const me = await api<Me>("/v1/auth/me");
  if (!me.data) redirect("/login?error=no_workspace");
  const memberships = me.data.memberships ?? [];
  if (memberships.length === 0) {
    redirect("/login?error=no_workspace");
  }
  if (memberships.length === 1) {
    // nothing to choose — rebind + land; the API session may still point at
    // the only workspace anyway
    redirect(DEFAULT_LANDING);
  }
  return (
    <main className="flex min-h-screen items-center justify-center px-6">
      <div className="w-full max-w-sm rounded-md border border-lining bg-surface-1 p-6">
        <p className="font-mono text-xs uppercase tracking-widest text-accent">
          tallyline
        </p>
        <h1 className="mt-2 text-lg font-semibold">Choose a workspace</h1>
        <WorkspaceChooser memberships={memberships} />
      </div>
    </main>
  );
}
