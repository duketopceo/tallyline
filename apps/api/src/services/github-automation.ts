import { and, asc, eq } from "drizzle-orm";
import {
  findPath,
  type IssueState,
} from "@docketry/types";
import { db } from "../db/client.js";
import {
  comments,
  events,
  githubIssueLinks,
  githubInstallations,
  githubRepos,
  issueLabels,
  issues,
  labels,
  teams,
} from "../db/schema.js";
import {
  DOCKETRY_COMMENT_MARKER,
  isAppBotSender,
  recordSyncConflict,
} from "./github-sync.js";
import { createIssue, transitionIssue, type Actor } from "./issues.js";
import { queueDeliveries } from "./outbound.js";

const SYSTEM: Actor = { type: "system", id: null };
const KEY_PREFIX = /^([A-Z][A-Z0-9]*-\d+)/;

interface GhRepoRef {
  full_name: string;
}

interface GhIssue {
  id: number;
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  state?: string;
  state_reason?: string | null;
  labels?: { name: string; color?: string }[];
  pull_request?: unknown;
  user?: { login: string };
}

interface GhPullRequest {
  number: number;
  merged?: boolean;
  draft?: boolean;
  title: string;
  html_url: string;
  head: { ref: string };
  user?: { login: string };
}

type Payload = Record<string, unknown>;

// find the enabled repo link for a delivery; null → repo not tracked
async function repoFor(payload: Payload) {
  const repo = payload.repository as GhRepoRef | undefined;
  if (!repo?.full_name) return null;
  const [row] = await db
    .select()
    .from(githubRepos)
    .where(eq(githubRepos.fullName, repo.full_name))
    .limit(1);
  return row?.enabled ? row : null;
}

// issue key from a branch name like `GH-4-fix-the-thing`
async function issueForBranch(workspaceId: string, branch: string) {
  const m = KEY_PREFIX.exec(branch);
  if (!m) return null;
  const [issue] = await db
    .select()
    .from(issues)
    .where(and(eq(issues.workspaceId, workspaceId), eq(issues.key, m[1]!)))
    .limit(1);
  return issue ?? null;
}

// walk the state machine to `target`; no-op when already there or unreachable
// backward (automation never moves issues backwards). Every step is marked
// via=github so intermediate transitions can't echo back to the GitHub API.
async function transitionTo(
  workspaceId: string,
  key: string,
  current: IssueState,
  target: IssueState,
  extra?: Record<string, unknown>,
) {
  if (current === target) return;
  const path = findPath(current, target);
  if (!path) return;
  for (const step of path) {
    await transitionIssue(workspaceId, key, step, SYSTEM, {
      ...(step === path[path.length - 1] ? extra : {}),
      via: "github",
    });
  }
}

async function onPush(repo: { workspaceId: string }, payload: Payload) {
  const ref = payload.ref as string | undefined;
  const branch = ref?.startsWith("refs/heads/") ? ref.slice(11) : ref;
  if (!branch) return;
  const issue = await issueForBranch(repo.workspaceId, branch);
  if (!issue) return;
  await transitionTo(repo.workspaceId, issue.key, issue.state, "in_progress", {
    github: { event: "push", branch },
  });
}

async function onPullRequest(
  repo: { workspaceId: string },
  payload: Payload,
) {
  const pr = payload.pull_request as GhPullRequest | undefined;
  const action = payload.action as string | undefined;
  if (!pr?.head?.ref || !action) return;
  const issue = await issueForBranch(repo.workspaceId, pr.head.ref);
  if (!issue) return;
  const meta = { github: { pr: pr.number, url: pr.html_url } };

  if (action === "opened" || action === "reopened" || action === "ready_for_review") {
    await transitionTo(repo.workspaceId, issue.key, issue.state, "in_progress", meta);
  } else if (action === "review_requested") {
    await transitionTo(repo.workspaceId, issue.key, issue.state, "in_review", meta);
  } else if (action === "closed" && pr.merged) {
    await transitionTo(repo.workspaceId, issue.key, issue.state, "done", meta);
  }
  // closed-unmerged and other actions: no movement
}

async function onPullRequestReview(
  repo: { workspaceId: string },
  payload: Payload,
) {
  const action = payload.action as string | undefined;
  if (action !== "submitted") return;
  const review = payload.review as
    | { state: string; html_url: string; user?: { login: string } }
    | undefined;
  const pr = payload.pull_request as GhPullRequest | undefined;
  if (!review?.state || !pr?.head?.ref) return;
  if (review.state !== "approved" && review.state !== "changes_requested") {
    return; // 'commented' and friends don't produce verdict events
  }
  const issue = await issueForBranch(repo.workspaceId, pr.head.ref);
  if (!issue) return;
  await db.insert(events).values({
    workspaceId: repo.workspaceId,
    entityType: "issue",
    entityId: issue.id,
    action: "github_review",
    actorType: "system",
    actorId: null,
    after: {
      verdict: review.state,
      reviewer: review.user?.login ?? "unknown",
      pr: pr.number,
      url: review.html_url,
    },
  });
  await queueDeliveries({
    workspaceId: repo.workspaceId,
    entityType: "issue",
    entityId: issue.id,
    action: "github_review",
    actorType: "system",
    actorId: null,
    after: {
      verdict: review.state,
      reviewer: review.user?.login ?? "unknown",
      pr: pr.number,
      url: review.html_url,
    },
    issueKey: issue.key,
  });
}

// canonical description format for GH-sourced issues — body plus a
// provenance footer. Sync edits rewrite the same shape so the footer
// never doubles.
function ghIssueDescription(body: string | null | undefined, url: string) {
  return body ? `${body}\n\n---\nGitHub: ${url}` : `GitHub: ${url}`;
}

// local description minus the provenance footer — for comparing the local
// body against `changes.body.from` on inbound edits
function stripGhFooter(desc: string | null): string {
  if (!desc) return "";
  const idx = desc.indexOf("\n\n---\nGitHub:");
  if (idx >= 0) return desc.slice(0, idx);
  if (desc.startsWith("GitHub: ")) return "";
  return desc;
}

async function onIssueOpened(
  repo: { id: string; workspaceId: string; teamId: string | null },
  payload: Payload,
) {
  const gh = payload.issue as GhIssue | undefined;
  if (!gh) return;

  // idempotent: a linked GH issue never double-intakes
  const [existing] = await db
    .select()
    .from(githubIssueLinks)
    .where(
      and(
        eq(githubIssueLinks.repoId, repo.id),
        eq(githubIssueLinks.ghIssueId, gh.id),
      ),
    )
    .limit(1);
  if (existing) return;

  // repo-linked team, else workspace's first team
  let teamId = repo.teamId;
  if (!teamId) {
    const [team] = await db
      .select()
      .from(teams)
      .where(eq(teams.workspaceId, repo.workspaceId))
      .orderBy(asc(teams.createdAt))
      .limit(1);
    teamId = team?.id ?? null;
  }
  if (!teamId) return;

  const issue = await createIssue({
    workspaceId: repo.workspaceId,
    teamId,
    title: gh.title,
    description: ghIssueDescription(gh.body, gh.html_url),
    source: "github",
    creator: SYSTEM,
    state: "triage",
  });

  await db.insert(githubIssueLinks).values({
    workspaceId: repo.workspaceId,
    repoId: repo.id,
    ghIssueId: gh.id,
    ghIssueNumber: gh.number,
    issueId: issue.id,
    ghState: "open",
  });
}

// ── inbound sync on linked issues (#60) ────────────────────────────

type LinkedIssue = typeof issues.$inferSelect;
type IssueLink = typeof githubIssueLinks.$inferSelect;

async function linkForGhIssue(repoId: string, ghIssueId: number) {
  const [row] = await db
    .select()
    .from(githubIssueLinks)
    .where(
      and(
        eq(githubIssueLinks.repoId, repoId),
        eq(githubIssueLinks.ghIssueId, ghIssueId),
      ),
    )
    .limit(1);
  return row ?? null;
}

const TERMINAL_STATES: ReadonlySet<IssueState> = new Set([
  "done",
  "canceled",
  "duplicate",
]);

// issues.edited — mirror title/body field-by-field. A field only changes
// when GitHub reports it in `changes`; if local no longer matches the
// edit's `from`, a divergent local edit collided → apply GitHub's value
// (last writer wins) and record a sync_conflict with both sides.
async function syncEdited(
  repo: { workspaceId: string },
  link: IssueLink,
  issue: LinkedIssue,
  gh: GhIssue,
  payload: Payload,
) {
  const changes = payload.changes as
    | { title?: { from: string }; body?: { from: string | null } }
    | undefined;
  if (!changes) return;

  const fields: { title?: string; description?: string } = {};
  const conflicts: Record<string, unknown>[] = [];

  if (changes.title !== undefined && issue.title !== gh.title) {
    if (issue.title !== changes.title.from) {
      conflicts.push({
        field: "title",
        local: issue.title,
        remote: gh.title,
        remoteFrom: changes.title.from,
      });
    }
    fields.title = gh.title;
  }
  if (changes.body !== undefined) {
    const newDesc = ghIssueDescription(gh.body, gh.html_url);
    if (issue.description !== newDesc) {
      const localBody = stripGhFooter(issue.description);
      const remoteFrom = changes.body.from ?? "";
      if (localBody !== remoteFrom && localBody !== (gh.body ?? "")) {
        conflicts.push({
          field: "body",
          local: localBody,
          remote: gh.body ?? "",
          remoteFrom,
        });
      }
      fields.description = newDesc;
    }
  }

  if (conflicts.length > 0) {
    await recordSyncConflict({
      workspaceId: repo.workspaceId,
      issueId: issue.id,
      conflict: {
        kind: "edit",
        ghIssueNumber: link.ghIssueNumber,
        fields: conflicts,
      },
    });
  }
  if (Object.keys(fields).length === 0) return;

  const before = { title: issue.title, description: issue.description };
  await db
    .update(issues)
    .set({ ...fields, updatedAt: new Date() })
    .where(eq(issues.id, issue.id));
  const after = {
    ...fields,
    via: "github",
    github: { event: "edited", issue: gh.number },
  };
  await db.insert(events).values({
    workspaceId: repo.workspaceId,
    entityType: "issue",
    entityId: issue.id,
    action: "edited",
    actorType: "system",
    actorId: null,
    before,
    after,
  });
  await queueDeliveries({
    workspaceId: repo.workspaceId,
    entityType: "issue",
    entityId: issue.id,
    action: "edited",
    actorType: "system",
    actorId: null,
    before,
    after,
    issueKey: issue.key,
  });
}

// issues.closed → done (state_reason completed) or canceled. A local
// terminal state that disagrees is drift, not a transition → conflict.
async function syncClosed(
  repo: { workspaceId: string },
  link: IssueLink,
  issue: LinkedIssue,
  gh: GhIssue,
) {
  await db
    .update(githubIssueLinks)
    .set({ ghState: "closed" })
    .where(eq(githubIssueLinks.id, link.id));

  const target: IssueState =
    gh.state_reason === "completed" ? "done" : "canceled";
  if (TERMINAL_STATES.has(issue.state)) {
    if (issue.state !== target) {
      await recordSyncConflict({
        workspaceId: repo.workspaceId,
        issueId: issue.id,
        conflict: {
          kind: "state",
          local: issue.state,
          remote: target,
          ghIssueNumber: link.ghIssueNumber,
        },
      });
    }
    return;
  }
  await transitionTo(repo.workspaceId, issue.key, issue.state, target, {
    github: { event: "closed", issue: gh.number, reason: gh.state_reason },
  });
}

// issues.reopened — meaningful only when local thinks the issue is closed.
// Terminal states have no exits in the state machine, so a GH reopen on a
// done/canceled issue is unresolvable → sync_conflict. Non-terminal locals
// are already open: the event is a no-op.
async function syncReopened(
  repo: { workspaceId: string },
  link: IssueLink,
  issue: LinkedIssue,
) {
  await db
    .update(githubIssueLinks)
    .set({ ghState: "open" })
    .where(eq(githubIssueLinks.id, link.id));
  if (!TERMINAL_STATES.has(issue.state)) return;
  await recordSyncConflict({
    workspaceId: repo.workspaceId,
    issueId: issue.id,
    conflict: {
      kind: "state",
      local: issue.state,
      remote: "open",
      ghIssueNumber: link.ghIssueNumber,
      detail: "terminal state cannot reopen — state machine has no exits",
    },
  });
}

// docketry labels are workspace-scoped and matched to GH labels by name;
// missing ones are created (GH color, else neutral default).
async function ensureLabel(
  workspaceId: string,
  name: string,
  color: string,
) {
  const [existing] = await db
    .select()
    .from(labels)
    .where(and(eq(labels.workspaceId, workspaceId), eq(labels.name, name)))
    .limit(1);
  if (existing) return existing;
  const [created] = await db
    .insert(labels)
    .values({ workspaceId, name, color })
    .returning();
  return created!;
}

async function syncLabelAdded(
  repo: { workspaceId: string },
  issue: LinkedIssue,
  payload: Payload,
) {
  const ghLabel = payload.label as
    | { name: string; color?: string }
    | undefined;
  if (!ghLabel?.name) return;
  const label = await ensureLabel(
    repo.workspaceId,
    ghLabel.name,
    ghLabel.color ? `#${ghLabel.color}` : "#94a3b8",
  );
  const [existing] = await db
    .select()
    .from(issueLabels)
    .where(
      and(
        eq(issueLabels.issueId, issue.id),
        eq(issueLabels.labelId, label.id),
      ),
    )
    .limit(1);
  if (existing) return; // our own outbound add echoing back
  await db
    .insert(issueLabels)
    .values({ issueId: issue.id, labelId: label.id });
  const after = {
    label: ghLabel.name,
    via: "github",
    github: { event: "labeled" },
  };
  await db.insert(events).values({
    workspaceId: repo.workspaceId,
    entityType: "issue",
    entityId: issue.id,
    action: "label_added",
    actorType: "system",
    actorId: null,
    after,
  });
  await queueDeliveries({
    workspaceId: repo.workspaceId,
    entityType: "issue",
    entityId: issue.id,
    action: "label_added",
    actorType: "system",
    actorId: null,
    after,
    issueKey: issue.key,
  });
}

async function syncLabelRemoved(
  repo: { workspaceId: string },
  issue: LinkedIssue,
  payload: Payload,
) {
  const ghLabel = payload.label as { name: string } | undefined;
  if (!ghLabel?.name) return;
  const [label] = await db
    .select()
    .from(labels)
    .where(
      and(
        eq(labels.workspaceId, repo.workspaceId),
        eq(labels.name, ghLabel.name),
      ),
    )
    .limit(1);
  if (!label) return;
  const removed = await db
    .delete(issueLabels)
    .where(
      and(
        eq(issueLabels.issueId, issue.id),
        eq(issueLabels.labelId, label.id),
      ),
    )
    .returning({ issueId: issueLabels.issueId });
  if (removed.length === 0) return;
  const after = {
    label: ghLabel.name,
    via: "github",
    github: { event: "unlabeled" },
  };
  await db.insert(events).values({
    workspaceId: repo.workspaceId,
    entityType: "issue",
    entityId: issue.id,
    action: "label_removed",
    actorType: "system",
    actorId: null,
    after,
  });
  await queueDeliveries({
    workspaceId: repo.workspaceId,
    entityType: "issue",
    entityId: issue.id,
    action: "label_removed",
    actorType: "system",
    actorId: null,
    after,
    issueKey: issue.key,
  });
}

async function onIssueSync(
  repo: { id: string; workspaceId: string },
  payload: Payload,
) {
  const action = payload.action as string | undefined;
  const gh = payload.issue as GhIssue | undefined;
  if (!gh || gh.pull_request) return; // PR threads ride the PR events
  if (isAppBotSender(payload)) return; // echo of our own outbound write

  const link = await linkForGhIssue(repo.id, gh.id);
  if (!link) return; // unlinked issue — intake-only
  const [issue] = await db
    .select()
    .from(issues)
    .where(eq(issues.id, link.issueId))
    .limit(1);
  if (!issue) return;

  if (action === "edited") await syncEdited(repo, link, issue, gh, payload);
  else if (action === "closed") await syncClosed(repo, link, issue, gh);
  else if (action === "reopened") await syncReopened(repo, link, issue);
  else if (action === "labeled") await syncLabelAdded(repo, issue, payload);
  else if (action === "unlabeled") await syncLabelRemoved(repo, issue, payload);
}

// issue_comment.created on a linked issue → docketry comment, authored
// by the GH user (system actor + provenance prefix), via=github so the
// outbound mirror never echoes it back.
async function onIssueCommentCreated(
  repo: { id: string; workspaceId: string },
  payload: Payload,
) {
  const gh = payload.issue as GhIssue | undefined;
  if (!gh || gh.pull_request) return;
  if (isAppBotSender(payload)) return;
  const comment = payload.comment as
    | { id: number; body: string; html_url: string; user?: { login: string } }
    | undefined;
  if (!comment?.body) return;
  // our own mirrored comment bouncing back
  if (comment.body.startsWith(DOCKETRY_COMMENT_MARKER)) return;

  const link = await linkForGhIssue(repo.id, gh.id);
  if (!link) return;
  const [issue] = await db
    .select()
    .from(issues)
    .where(eq(issues.id, link.issueId))
    .limit(1);
  if (!issue) return;

  const author = comment.user?.login ?? "unknown";
  const [row] = await db
    .insert(comments)
    .values({
      workspaceId: repo.workspaceId,
      issueId: issue.id,
      actorType: "system",
      actorId: null,
      body: `**@${author}** via GitHub:\n\n${comment.body}`,
      via: "github",
    })
    .returning();
  const after = {
    commentId: row!.id,
    via: "github",
    github: { comment: comment.id, author, url: comment.html_url },
  };
  await db.insert(events).values({
    workspaceId: repo.workspaceId,
    entityType: "issue",
    entityId: issue.id,
    action: "commented",
    actorType: "system",
    actorId: null,
    after,
  });
  await queueDeliveries({
    workspaceId: repo.workspaceId,
    entityType: "issue",
    entityId: issue.id,
    action: "commented",
    actorType: "system",
    actorId: null,
    after,
    issueKey: issue.key,
  });
}

async function onInstallationEvent(payload: Payload): Promise<boolean> {
  const p = payload as {
    action?: string;
    installation?: { id: number; account?: { login?: string } };
    repositories?: { id: number; full_name?: string; name: string }[];
    repositories_added?: { id: number; full_name?: string; name: string }[];
    repositories_removed?: { id: number; full_name?: string; name: string }[];
  };
  if (!p.installation?.id) return true;
  const installationId = p.installation.id;

  if (p.action === "deleted") {
    await db
      .delete(githubInstallations)
      .where(eq(githubInstallations.installationId, installationId));
    return true;
  }

  const [inst] = await db
    .select()
    .from(githubInstallations)
    .where(eq(githubInstallations.installationId, installationId))
    .limit(1);
  if (!inst) return false; // unbound — setup callback backfills later

  const added = [...(p.repositories ?? []), ...(p.repositories_added ?? [])];
  for (const repo of added) {
    const fullName = repo.full_name ?? repo.name;
    await db
      .insert(githubRepos)
      .values({
        workspaceId: inst.workspaceId,
        installationId,
        repoId: repo.id,
        fullName,
        enabled: false,
      })
      .onConflictDoUpdate({
        target: [githubRepos.workspaceId, githubRepos.fullName],
        set: { installationId, repoId: repo.id },
      });
  }
  for (const repo of p.repositories_removed ?? []) {
    const fullName = repo.full_name ?? repo.name;
    await db
      .delete(githubRepos)
      .where(
        and(
          eq(githubRepos.installationId, installationId),
          eq(githubRepos.fullName, fullName),
        ),
      );
  }
  return true;
}

// dispatch a stored delivery. Returns false when the event can't be fully
// processed yet (unbound installation) — caller leaves processedAt null.
export async function processGithubEvent(
  eventType: string,
  payload: Payload,
): Promise<boolean> {
  if (eventType === "installation" || eventType === "installation_repositories") {
    return onInstallationEvent(payload);
  }

  const repo = await repoFor(payload);
  if (!repo) return true; // untracked repo — consumed, nothing to do

  if (eventType === "push") await onPush(repo, payload);
  else if (eventType === "pull_request") await onPullRequest(repo, payload);
  else if (eventType === "pull_request_review") {
    await onPullRequestReview(repo, payload);
  } else if (eventType === "issues") {
    if (payload.action === "opened") await onIssueOpened(repo, payload);
    else await onIssueSync(repo, payload);
  } else if (eventType === "issue_comment" && payload.action === "created") {
    await onIssueCommentCreated(repo, payload);
  }
  return true;
}
