import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { events, issues } from "../db/schema.js";

// A merged GitHub PR becomes a `pr_merged` event on every ticket it names, so
// the roadmap's merge ticker can show who shipped what and link the PR. It
// only records; moving tickets stays with the lifecycle automation.

const BRANCH_KEY = /^([A-Za-z][A-Za-z0-9]*-\d+)/;
const TITLE_KEYS = /\(([A-Z][A-Z0-9]*-\d+)\)/g;

/** every ticket key a merged PR names: its branch, then each `(KEY-n)` in the title */
export function mergedPrKeys(branch: string | null | undefined, title: string | null | undefined): string[] {
  const keys = new Set<string>();
  const b = branch ? BRANCH_KEY.exec(branch) : null;
  if (b) keys.add(b[1]!.toUpperCase());
  for (const m of (title ?? "").matchAll(TITLE_KEYS)) keys.add(m[1]!);
  return [...keys];
}

interface MergedPr {
  number: number;
  merged?: boolean;
  title: string;
  html_url: string;
  head?: { ref: string };
  user?: { login: string };
}

export async function recordPrMerge(
  repo: { workspaceId: string },
  payload: Record<string, unknown>,
): Promise<void> {
  const pr = payload.pull_request as MergedPr | undefined;
  if (payload.action !== "closed" || !pr?.merged || !pr.html_url) return;
  const keys = mergedPrKeys(pr.head?.ref, pr.title);
  if (keys.length === 0) return;
  const linked = await db
    .select({ id: issues.id })
    .from(issues)
    .where(and(eq(issues.workspaceId, repo.workspaceId), inArray(issues.key, keys)));
  const fullName = (payload.repository as { full_name?: string } | undefined)?.full_name ?? null;
  for (const issue of linked) {
    // a redelivered close must not tick the ticker twice
    const [seen] = await db
      .select({ id: events.id })
      .from(events)
      .where(
        and(
          eq(events.workspaceId, repo.workspaceId),
          eq(events.entityId, issue.id),
          eq(events.action, "pr_merged"),
          sql`${events.after}->>'url' = ${pr.html_url}`,
        ),
      )
      .limit(1);
    if (seen) continue;
    await db.insert(events).values({
      workspaceId: repo.workspaceId,
      entityType: "issue",
      entityId: issue.id,
      action: "pr_merged",
      actorType: "system",
      actorId: null,
      after: {
        pr: pr.number,
        url: pr.html_url,
        title: pr.title,
        author: pr.user?.login ?? null,
        repo: fullName,
      },
    });
  }
}
