import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { IssueState } from "@tallyline/types";
import { db } from "../db/client.js";
import {
  comments,
  intakeCredentials,
  issues,
  projects,
  reporterHandles,
} from "../db/schema.js";
import { clock } from "./clock.js";

// Web helpdesk (plan 2026-11-03 U6). A read model over issues that came in
// through intake: kind, source app, reporter and age in one row, so staff can
// work reports without opening the full issue board.
//
// The report kind was never given its own column — `ingestIntake` records it
// in the issue description's provenance line ("Reported via <provider>
// (<kind>[, <severity>])"). This module owns that parse; if a migration ever
// stores kind structurally, only this file changes.

export const SUPPORT_KINDS = ["error", "bug", "help", "issue"] as const;
export type SupportKind = (typeof SUPPORT_KINDS)[number] | "unknown";

/** one page of the helpdesk; newest first, so an old report cannot crowd out a new one */
export const SUPPORT_LIST_LIMIT = 500;

const PROVENANCE =
  /Reported via (.+?) \((error|bug|help|issue)(?:, (?:fatal|error|warning|info))?\)/;

export interface IntakeProvenance {
  provider: string;
  kind: SupportKind;
}

/**
 * Pull the source app and kind out of the provenance line `ingestIntake`
 * writes. Returns null for anything that is not an intake description (a
 * hand-written description, an empty body), so callers never guess.
 */
export function parseIntakeProvenance(
  description: string | null,
): IntakeProvenance | null {
  if (!description) return null;
  const m = PROVENANCE.exec(description);
  if (!m?.[1] || !m[2]) return null;
  return { provider: m[1].trim(), kind: m[2] as SupportKind };
}

export interface SupportReporter {
  name: string | null;
  email: string | null;
}

/** One helpdesk row. Everything is display data; ids stay workspace-internal. */
export interface SupportIssue {
  key: string;
  title: string;
  state: IssueState;
  kind: SupportKind;
  provider: string;
  reporter: SupportReporter | null;
  /** the newest handle for this report has lapsed: show the issue, not a dead link */
  handleExpired: boolean;
  publicReplies: number;
  lastPublicReplyAt: string | null;
  occurrences: number;
  projectId: string | null;
  projectName: string | null;
  createdAt: string;
}

export interface SupportListOptions {
  kind?: SupportKind | undefined;
  projectId?: string | undefined;
}

export interface SupportList {
  issues: SupportIssue[];
  /** true when the page hit SUPPORT_LIST_LIMIT before filters ran */
  truncated: boolean;
}

/**
 * The helpdesk page for one workspace. Only `source = 'intake'` issues are
 * listed: a hand-filed bug has no reporter and no follow-up handle.
 *
 * Kind and project are both derived rather than stored on the issue — kind
 * lives in the description's provenance line, and an intake issue gets its
 * project from the credential that filed it (via the reporter handle), not
 * from `issues.project_id`. Both filters therefore run over the fetched page,
 * and `truncated` tells the UI when that page was capped.
 */
export async function listSupportIssues(
  workspaceId: string,
  options: SupportListOptions = {},
): Promise<SupportList> {
  const rows = await db
    .select({
      id: issues.id,
      key: issues.key,
      title: issues.title,
      state: issues.state,
      description: issues.description,
      occurrences: issues.occurrenceCount,
      projectId: issues.projectId,
      createdAt: issues.createdAt,
    })
    .from(issues)
    .where(
      and(eq(issues.workspaceId, workspaceId), eq(issues.source, "intake")),
    )
    .orderBy(desc(issues.createdAt))
    .limit(SUPPORT_LIST_LIMIT);

  const truncated = rows.length === SUPPORT_LIST_LIMIT;
  const ids = rows.map((r) => r.id);

  // newest handle per issue: the reporter who filed most recently, and the
  // credential whose project the report belongs to. Expired handles are read
  // too — a lapsed link must leave the report on the list, marked expired,
  // instead of making the reporter vanish.
  const handleRows = ids.length
    ? await db
        .select({
          issueId: reporterHandles.issueId,
          reporterName: reporterHandles.reporterName,
          reporterEmail: reporterHandles.reporterEmail,
          expiresAt: reporterHandles.expiresAt,
          credentialProjectId: intakeCredentials.projectId,
        })
        .from(reporterHandles)
        .leftJoin(
          intakeCredentials,
          eq(intakeCredentials.id, reporterHandles.credentialId),
        )
        .where(
          and(
            eq(reporterHandles.workspaceId, workspaceId),
            inArray(reporterHandles.issueId, ids),
          ),
        )
        .orderBy(desc(reporterHandles.createdAt))
    : [];
  const now = clock.now().getTime();
  const handles = new Map<
    string,
    {
      reporter: SupportReporter;
      credentialProjectId: string | null;
      expired: boolean;
    }
  >();
  for (const h of handleRows) {
    const expired = h.expiresAt.getTime() <= now;
    const prev = handles.get(h.issueId);
    // rows are newest first: keep the first, but a lapsed newest handle must
    // not hide an older live one
    if (prev && (!prev.expired || expired)) continue;
    handles.set(h.issueId, {
      reporter: { name: h.reporterName, email: h.reporterEmail },
      credentialProjectId: h.credentialProjectId,
      expired,
    });
  }

  // a report's project is its issue project when set, else the filing
  // credential's — that is the only project signal a public report carries
  const projectOf = new Map<string, string>();
  for (const r of rows) {
    const projectId = r.projectId ?? handles.get(r.id)?.credentialProjectId ?? null;
    if (projectId) projectOf.set(r.id, projectId);
  }
  const projectIds = [...new Set(projectOf.values())];
  const projectNames = new Map<string, string>();
  if (projectIds.length) {
    for (const p of await db
      .select({ id: projects.id, name: projects.name })
      .from(projects)
      .where(
        and(
          eq(projects.workspaceId, workspaceId),
          inArray(projects.id, projectIds),
        ),
      )) {
      projectNames.set(p.id, p.name);
    }
  }

  // public replies only: the count is what the reporter can already see
  const replyRows = ids.length
    ? await db
        .select({
          issueId: comments.issueId,
          count: sql<number>`count(*)::int`,
          lastAt: sql<Date>`max(${comments.createdAt})`,
        })
        .from(comments)
        .where(
          and(
            eq(comments.workspaceId, workspaceId),
            inArray(comments.issueId, ids),
            eq(comments.visibility, "public"),
          ),
        )
        .groupBy(comments.issueId)
    : [];
  const replies = new Map(
    replyRows.map((r) => [r.issueId, { count: r.count, lastAt: r.lastAt }]),
  );

  const parsed = rows.map((r): SupportIssue => {
    const provenance = parseIntakeProvenance(r.description);
    const handle = handles.get(r.id);
    const reply = replies.get(r.id);
    const projectId = projectOf.get(r.id) ?? null;
    return {
      key: r.key,
      title: r.title,
      state: r.state,
      kind: provenance?.kind ?? "unknown",
      provider: provenance?.provider ?? "intake",
      reporter: handle?.reporter ?? null,
      handleExpired: handle?.expired ?? false,
      publicReplies: reply?.count ?? 0,
      lastPublicReplyAt: reply?.lastAt ? new Date(reply.lastAt).toISOString() : null,
      occurrences: r.occurrences,
      projectId,
      projectName: projectId ? (projectNames.get(projectId) ?? null) : null,
      createdAt: r.createdAt.toISOString(),
    };
  });

  const issuesPage = parsed.filter((i) =>
    (options.kind ? i.kind === options.kind : true) &&
    (options.projectId ? i.projectId === options.projectId : true),
  );
  return { issues: issuesPage, truncated };
}
