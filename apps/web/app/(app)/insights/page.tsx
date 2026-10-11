import { PageHeader } from "@/components/app/page-header";
import type { Insights } from "@/components/insights-charts";
import { InsightsLoader } from "@/components/insights-loader";
import { ErrorState } from "@/components/primitives";
import { api, type Me } from "@/lib/api";

export default async function InsightsPage() {
  const me = await api<Me>("/v1/auth/me");
  if (!me.ok || !me.data) return <main className="p-8 text-sm text-ink-subtle">Not signed in.</main>;
  const res = await api<Insights>(`/v1/workspaces/${me.data.workspaceSlug}/insights`);
  const ins = res.ok ? res.data : null;
  return (
    <main className="flex min-h-0 flex-1 flex-col">
      <PageHeader title="Insights">
        <span className="text-[12px] text-ink-subtle">Events and cycle snapshots, rolling 26 weeks</span>
      </PageHeader>
      {!ins ? (
        <div className="p-4"><ErrorState title="Insights did not load" detail="The API did not answer. Nothing was changed." actionLabel="Retry" actionHref="/insights" /></div>
      ) : (
        <InsightsLoader insights={ins} />
      )}
    </main>
  );
}
