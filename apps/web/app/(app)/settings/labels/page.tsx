import { api, type Me } from "@/lib/api";
import { LabelsSettings, type LabelRow } from "@/components/labels-settings";
import { SettingsHeader } from "@/components/settings/settings-header";

interface LabelsResponse {
  labels?: LabelRow[];
}

export default async function LabelsPage() {
  const me = await api<Me>("/v1/auth/me");
  if (!me.data) {
    return <main className="p-8 text-sm text-ink-subtle">Not signed in.</main>;
  }
  const res = await api<LabelsResponse>(
    `/v1/workspaces/${me.data.workspaceSlug}/labels`,
  );
  const rows = res.data?.labels ?? [];

  return (
    <main className="flex min-h-0 flex-1 flex-col">
      <SettingsHeader
        title="Labels"
        actions={
        <span className="font-mono text-[11px] text-ink-tertiary">
          {rows.length}
        </span>
        }
      />
      <LabelsSettings labels={rows} />
    </main>
  );
}
