import { PageHeader } from "@/components/app/page-header";
import { ErrorState } from "@/components/primitives";
import { ReviewQueue, type QueueRow } from "@/components/review-queue";
import { api, type Me } from "@/lib/api";

export default async function ReviewPage() {
  const me = await api<Me>("/v1/auth/me");
  if (!me.data) return <main className="p-8 text-sm text-ink-subtle">Not signed in.</main>;
  const res = await api<{ queue: QueueRow[] }>(`/v1/workspaces/${me.data.workspaceSlug}/review-queue`);
  if (!res.ok) {
    return (
      <main className="flex min-h-0 flex-1 flex-col">
        <PageHeader title="Review" />
        <div className="p-4"><ErrorState title="The review queue did not load" detail="The API did not answer. Nothing was approved or sent back." actionLabel="Retry" actionHref="/review" /></div>
      </main>
    );
  }
  const queue = res.data?.queue ?? [];
  return (
    <main className="flex min-h-0 flex-1 flex-col">
      <PageHeader title="Review" count={queue.length} hint="waiting on you" />
      <ReviewQueue queue={queue} />
    </main>
  );
}
