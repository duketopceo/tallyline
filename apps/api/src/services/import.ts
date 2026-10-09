import Papa from "papaparse";
import { and, asc, eq } from "drizzle-orm";
import type { IssueState, Priority } from "@docketry/types";
import { db } from "../db/client.js";
import {
  githubIssueLinks,
  githubRepos,
  issueExternalRefs,
  issues,
  teams,
} from "../db/schema.js";
import { createIssue, type Actor } from "./issues.js";

const SYSTEM: Actor = { type: "system", id: null };
type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

export interface ImportResult {
  created: number;
  skipped: number;
  errors: string[];
}

interface GhIssue {
  id: number;
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  state: "open" | "closed";
  state_reason?: "completed" | "not_planned" | "reopened" | null;
  pull_request?: unknown;
  labels?: { name: string }[];
}

function ghState(s: GhIssue, target: "triage" | "backlog"): IssueState {
  if (s.state === "open") return target;
  return s.state_reason === "not_planned" ? "canceled" : "done";
}

// bulk one-way GH issue import — dedupes via github_issue_links, so re-runs
// are idempotent. `token` is a PAT or installation token supplied by caller.
export async function importGithubIssues(input: {
  workspaceId: string;
  fullName: string;
  token: string;
  target: "triage" | "backlog";
  teamId?: string | undefined;
  fetchImpl?: Fetcher | undefined;
}): Promise<ImportResult> {
  const fetcher = input.fetchImpl ?? fetch;
  const result: ImportResult = { created: 0, skipped: 0, errors: [] };

  const [repo] = await db
    .insert(githubRepos)
    .values({
      workspaceId: input.workspaceId,
      fullName: input.fullName,
      enabled: true,
    })
    .onConflictDoUpdate({
      target: [githubRepos.workspaceId, githubRepos.fullName],
      set: { enabled: true },
    })
    .returning();

  let teamId: string | null = input.teamId ?? repo!.teamId;
  if (!teamId) {
    const [team] = await db
      .select()
      .from(teams)
      .where(eq(teams.workspaceId, input.workspaceId))
      .orderBy(asc(teams.createdAt))
      .limit(1);
    teamId = team?.id ?? null;
  }
  if (!teamId) {
    result.errors.push("no team in workspace");
    return result;
  }

  for (let page = 1; page <= 20; page++) {
    const res = await fetcher(
      `https://api.github.com/repos/${input.fullName}/issues?state=all&per_page=100&page=${page}`,
      {
        headers: {
          authorization: `Bearer ${input.token}`,
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
        },
      },
    );
    if (!res.ok) {
      result.errors.push(`github api returned ${res.status}`);
      return result;
    }
    const pageIssues = (await res.json()) as GhIssue[];
    for (const gh of pageIssues.filter((i) => !i.pull_request)) {
      const [existing] = await db
        .select()
        .from(githubIssueLinks)
        .where(
          and(
            eq(githubIssueLinks.repoId, repo!.id),
            eq(githubIssueLinks.ghIssueId, gh.id),
          ),
        )
        .limit(1);
      if (existing) {
        result.skipped++;
        continue;
      }
      const labelNames = (gh.labels ?? []).map((l) => l.name).join(", ");
      const issue = await createIssue({
        workspaceId: input.workspaceId,
        teamId,
        title: gh.title,
        description: `${gh.body ?? ""}\n\n---\nGitHub: ${gh.html_url}${labelNames ? ` · labels: ${labelNames}` : ""}`.trim(),
        source: "github",
        creator: SYSTEM,
        state: ghState(gh, input.target),
      });
      await db.insert(githubIssueLinks).values({
        workspaceId: input.workspaceId,
        repoId: repo!.id,
        ghIssueId: gh.id,
        ghIssueNumber: gh.number,
        issueId: issue.id,
        ghState: gh.state,
      });
      result.created++;
    }
    if (pageIssues.length < 100) break;
  }
  return result;
}

// ── Linear CSV ────────────────────────────────────────────────────

function linearState(status: string, target: "triage" | "backlog"): IssueState {
  const s = status.toLowerCase();
  if (s.includes("cancel")) return "canceled";
  if (s.includes("dup")) return "duplicate";
  if (s.includes("done") || s.includes("complete") || s.includes("merged"))
    return "done";
  if (s.includes("review")) return "in_review";
  if (s.includes("progress") || s.includes("started")) return "in_progress";
  if (s.includes("triag")) return "triage";
  if (s.includes("backlog")) return "backlog";
  if (s.includes("todo") || s.includes("unstarted") || s.includes("planned"))
    return "todo";
  return target;
}

function linearPriority(p: string): Priority {
  const s = p.toLowerCase();
  if (s.includes("urgent")) return "urgent";
  if (s.includes("high")) return "high";
  if (s.includes("medium") || s.includes("normal")) return "medium";
  if (s.includes("low")) return "low";
  return "none";
}

export async function importLinearCsv(input: {
  workspaceId: string;
  teamId: string;
  csv: string;
  target: "triage" | "backlog";
}): Promise<ImportResult> {
  const result: ImportResult = { created: 0, skipped: 0, errors: [] };
  const parsed = Papa.parse<Record<string, string>>(input.csv, {
    header: true,
    skipEmptyLines: true,
  });
  if (parsed.errors.length > 0) {
    result.errors.push(
      ...parsed.errors.slice(0, 5).map((e) => `csv row ${e.row}: ${e.message}`),
    );
  }
  const col = (row: Record<string, string>, name: string) =>
    row[
      Object.keys(row).find((k) => k.toLowerCase() === name.toLowerCase()) ?? ""
    ];

  for (const row of parsed.data) {
    const externalId = col(row, "ID")?.trim();
    const title = col(row, "Title")?.trim();
    if (!externalId || !title) {
      result.skipped++;
      continue;
    }
    const [existing] = await db
      .select()
      .from(issueExternalRefs)
      .where(
        and(
          eq(issueExternalRefs.workspaceId, input.workspaceId),
          eq(issueExternalRefs.system, "linear"),
          eq(issueExternalRefs.externalId, externalId),
        ),
      )
      .limit(1);
    if (existing) {
      result.skipped++;
      continue;
    }
    const url = col(row, "URL")?.trim();
    const body = col(row, "Description")?.trim();
    const labels = col(row, "Labels")?.trim();
    const issue = await createIssue({
      workspaceId: input.workspaceId,
      teamId: input.teamId,
      title,
      description:
        `${body ?? ""}\n\n---\nLinear: ${externalId}${url ? ` · ${url}` : ""}${labels ? ` · labels: ${labels}` : ""}`.trim(),
      source: "api",
      creator: SYSTEM,
      state: linearState(col(row, "Status") ?? "", input.target),
    });
    const priority = linearPriority(col(row, "Priority") ?? "");
    if (priority !== "none") {
      await db
        .update(issues)
        .set({ priority })
        .where(eq(issues.id, issue.id));
    }
    await db.insert(issueExternalRefs).values({
      workspaceId: input.workspaceId,
      issueId: issue.id,
      system: "linear",
      externalId,
      url: url ?? null,
    });
    result.created++;
  }
  return result;
}
