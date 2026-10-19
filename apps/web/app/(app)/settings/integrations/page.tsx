import { api, type Me } from "@/lib/api";
import {
  GithubRepoPanel,
  type GithubRepoRow,
} from "@/components/github-repos";
import { SettingsTabs } from "@/components/settings-tabs";

interface ReposResponse {
  repos?: GithubRepoRow[];
}
interface InstallUrlResponse {
  installUrl?: string;
}

export default async function IntegrationsPage() {
  const me = await api<Me>("/v1/auth/me");
  if (!me.data)
    return <main className="p-8 text-sm text-ink-subtle">Not signed in.</main>;
  const role = me.data.memberships.find(
    (m) => m.workspaceSlug === me.data!.workspaceSlug,
  )?.role;
  const canAdmin = role === "owner" || role === "admin";
  if (!canAdmin) {
    return (
      <main className="flex min-h-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center border-b border-lining-faint px-4">
          <h1 className="text-sm font-semibold">Integrations</h1>
        </header>
        <p className="p-4 text-sm text-ink-subtle">Requires admin access.</p>
      </main>
    );
  }

  const [reposRes, installRes, projectsRes] = await Promise.all([
    api<ReposResponse>(`/v1/workspaces/${me.data.workspaceSlug}/github/repos`),
    api<InstallUrlResponse>(
      `/v1/workspaces/${me.data.workspaceSlug}/github/install-url`,
    ),
    api<{ projects?: { id: string; name: string }[] }>(
      `/v1/workspaces/${me.data.workspaceSlug}/projects`,
    ),
  ]);
  const repos = reposRes.data?.repos ?? [];
  // an installationId on any row proves the App is installed + bound here;
  // rows with installationId === null were registered via the import path
  const installed = repos.some((r) => r.installationId != null);
  const manageUrl = "https://github.com/settings/installations";

  return (
    <main className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-4 border-b border-lining-faint px-4">
        <h1 className="text-sm font-semibold">Integrations</h1>
        <SettingsTabs />
        <a
          href={installed ? manageUrl : (installRes.data?.installUrl ?? manageUrl)}
          target="_blank"
          rel="noreferrer"
          className="ml-auto font-mono text-[11px] text-ink-tertiary hover:text-ink"
        >
          {installed ? "manage on GitHub ↗" : "install App ↗"}
        </a>
      </header>
      <GithubRepoPanel
        repos={repos}
        installed={installed}
        installUrl={installRes.data?.installUrl ?? null}
        projects={projectsRes.data?.projects ?? []}
      />
    </main>
  );
}
