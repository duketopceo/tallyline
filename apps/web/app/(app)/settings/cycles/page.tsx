import { api, type Me } from "@/lib/api";
import { CyclesSettings, type CycleRow, type TeamRow } from "@/components/cycles-settings";
import { SettingsTabs } from "@/components/settings-tabs";

interface CyclesResponse {
  cycles?: CycleRow[];
}
interface TeamsResponse {
  teams?: TeamRow[];
}

export default async function CyclesPage() {
  const me = await api<Me>("/v1/auth/me");
  if (!me.data) {
    return <main className="p-8 text-sm text-ink-subtle">Not signed in.</main>;
  }
  const ws = me.data.workspaceSlug;
  const [cyclesRes, teamsRes] = await Promise.all([
    api<CyclesResponse>(`/v1/workspaces/${ws}/cycles`),
    api<TeamsResponse>(`/v1/workspaces/${ws}/teams`),
  ]);
  const rows = cyclesRes.data?.cycles ?? [];
  const teams = teamsRes.data?.teams ?? [];

  return (
    <main className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center border-b border-lining-faint px-4">
        <h1 className="text-sm font-semibold">Cycles</h1>
        <SettingsTabs />
        <span className="ml-auto font-mono text-[11px] text-ink-tertiary">
          {rows.length}
        </span>
      </header>
      <CyclesSettings cycles={rows} teams={teams} />
    </main>
  );
}
