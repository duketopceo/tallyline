// Agent inbox (U20): what is waiting for one agent beyond assigned work.
// Items are derived from rows the producing code already writes, so nothing
// can drift: a mention is the dispatch an @agent comment creates, and an
// answered question is a human `prompt` activity on one of the agent's
// sessions (the elicitation reply path). The agent's `inbox_acked_at` mark
// hides what it has already handled; it only moves forward.
import { and, asc, eq, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import {
  agentActivities,
  agents,
  agentSessions,
  dispatches,
  issues,
} from "../db/schema.js";

export type AgentInboxKind = "mention" | "answer";

export interface AgentInboxItem {
  kind: AgentInboxKind;
  // stable per source row, prefixed by kind so the two id spaces cannot collide
  id: string;
  issueKey: string;
  issueTitle: string;
  excerpt: string;
  createdAt: string;
}

const EXCERPT_MAX = 500;

function excerpt(text: string | null): string {
  const t = (text ?? "").trim();
  return t.length > EXCERPT_MAX ? `${t.slice(0, EXCERPT_MAX)}…` : t;
}

export async function listAgentInbox(
  workspaceId: string,
  agentId: string,
  limit: number,
): Promise<{ items: AgentInboxItem[]; ackedAt: string | null }> {
  const [agent] = await db
    .select({ ackedAt: agents.inboxAckedAt })
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.workspaceId, workspaceId)));
  const mark = agent?.ackedAt ?? null;

  const mentionQuery = db
    .select({
      id: dispatches.id,
      body: dispatches.commentBody,
      createdAt: dispatches.createdAt,
      issueKey: issues.key,
      issueTitle: issues.title,
    })
    .from(dispatches)
    .innerJoin(issues, eq(issues.id, dispatches.issueId))
    .where(
      and(
        eq(dispatches.workspaceId, workspaceId),
        eq(dispatches.agentId, agentId),
        eq(dispatches.trigger, "mention"),
        mark ? sql`date_trunc('milliseconds', ${dispatches.createdAt}) > ${mark.toISOString()}::timestamptz` : undefined,
      ),
    )
    .orderBy(asc(dispatches.createdAt))
    .limit(limit);

  const answerQuery = db
    .select({
      id: agentActivities.id,
      content: agentActivities.content,
      createdAt: agentActivities.createdAt,
      issueKey: issues.key,
      issueTitle: issues.title,
    })
    .from(agentActivities)
    .innerJoin(agentSessions, eq(agentSessions.id, agentActivities.sessionId))
    .innerJoin(issues, eq(issues.id, agentSessions.issueId))
    .where(
      and(
        eq(agentSessions.workspaceId, workspaceId),
        eq(agentSessions.agentId, agentId),
        eq(agentActivities.type, "prompt"),
        eq(agentActivities.actorType, "human"),
        mark ? sql`date_trunc('milliseconds', ${agentActivities.createdAt}) > ${mark.toISOString()}::timestamptz` : undefined,
      ),
    )
    .orderBy(asc(agentActivities.createdAt))
    .limit(limit);

  const [mentionRows, answerRows] = await Promise.all([mentionQuery, answerQuery]);

  const items: AgentInboxItem[] = [
    ...mentionRows.map((r) => ({
      kind: "mention" as const,
      id: `mention:${r.id}`,
      issueKey: r.issueKey,
      issueTitle: r.issueTitle,
      excerpt: excerpt(r.body),
      createdAt: r.createdAt.toISOString(),
    })),
    ...answerRows.map((r) => ({
      kind: "answer" as const,
      id: `answer:${r.id}`,
      issueKey: r.issueKey,
      issueTitle: r.issueTitle,
      excerpt: excerpt(typeof r.content.body === "string" ? r.content.body : null),
      createdAt: r.createdAt.toISOString(),
    })),
  ]
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
    .slice(0, limit);

  return { items, ackedAt: mark ? mark.toISOString() : null };
}

// Advance the ack mark to `through`, clamped to now and never backwards.
export async function ackAgentInbox(
  workspaceId: string,
  agentId: string,
  through: Date,
): Promise<string | null> {
  const target = through.getTime() > Date.now() ? new Date() : through;
  const [row] = await db
    .update(agents)
    .set({
      inboxAckedAt: sql`greatest(coalesce(${agents.inboxAckedAt}, ${target.toISOString()}::timestamptz), ${target.toISOString()}::timestamptz)`,
    })
    .where(and(eq(agents.id, agentId), eq(agents.workspaceId, workspaceId)))
    .returning({ ackedAt: agents.inboxAckedAt });
  // null when the agent row is gone (concurrent cleanup)
  return row?.ackedAt?.toISOString() ?? null;
}
