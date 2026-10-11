import { notFound } from "next/navigation";
import { IssueDetailView, type DetailComment, type DetailEvent, type FullIssue } from "@/components/issue-detail";
import type { Session } from "@/components/session-timeline";
import { api, type Me } from "@/lib/api";

export default async function IssuePage({ params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  const me = await api<Me>("/v1/auth/me");
  if (!me.data) return <main className="p-8 text-sm text-ink-subtle">Not signed in.</main>;
  const base = `/v1/workspaces/${me.data.workspaceSlug}/issues/${key}`;
  const [issue, comments, events, sessions] = await Promise.all([
    api<FullIssue>(base),
    api<{ comments: DetailComment[] }>(`${base}/comments`),
    api<{ events: DetailEvent[] }>(`${base}/events`),
    api<{ sessions: Session[] }>(`${base}/sessions`),
  ]);
  if (!issue.data) notFound();
  return (
    <IssueDetailView
      issue={issue.data}
      comments={comments.data?.comments ?? []}
      events={events.data?.events ?? []}
      sessions={sessions.data?.sessions ?? []}
    />
  );
}
