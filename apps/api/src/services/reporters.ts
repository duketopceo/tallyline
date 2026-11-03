import { createHash, randomBytes } from "node:crypto";
import { and, asc, desc, eq, gt, inArray, isNotNull } from "drizzle-orm";
import { db } from "../db/client.js";
import {
  agents,
  comments,
  issues,
  reporterHandles,
  reporterReplyDeliveries,
  users,
} from "../db/schema.js";
import { config_ } from "../env.js";
import { clock } from "./clock.js";
import { mailer } from "./mailer.js";

// Reporter follow-up (plan 2026-11-03 U3). A report filed by an outside app
// gets one opaque handle the reporter can open, with no account and no
// session: the token is the capability, it lives 30 days, and only its sha256
// is stored. The handle shows the issue's status and its *public* comments —
// never internal discussion, never workspace identity.

export const REPORT_TOKEN_PREFIX = "tlreport_";

/** how long a handle works from issue time, and from each mailed reply */
export const REPORT_HANDLE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export function hashReporterToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export interface IssueReporterHandleInput {
  workspaceId: string;
  issueId: string;
  credentialId?: string | null;
  reporterEmail?: string | null;
  reporterName?: string | null;
}

export interface IssuedReporterHandle {
  /** plaintext, shown once — to the reporter directly or in a mailed link */
  token: string;
  expiresAt: Date;
}

/**
 * Mint a handle for one issue. The plaintext token is returned to the caller
 * and never stored; the row keeps only the hash and the expiry.
 */
export async function issueReporterHandle(
  input: IssueReporterHandleInput,
): Promise<IssuedReporterHandle> {
  const token = `${REPORT_TOKEN_PREFIX}${randomBytes(24).toString("base64url")}`;
  const expiresAt = new Date(clock.ms() + REPORT_HANDLE_TTL_MS);
  await db.insert(reporterHandles).values({
    workspaceId: input.workspaceId,
    issueId: input.issueId,
    credentialId: input.credentialId ?? null,
    reporterEmail: input.reporterEmail ?? null,
    reporterName: input.reporterName ?? null,
    tokenHash: hashReporterToken(token),
    expiresAt,
  });
  return { token, expiresAt };
}

export interface PublicReporterComment {
  author: string;
  body: string;
  createdAt: string;
}

/** what a reporter is allowed to see: status, title, public replies only */
export interface ReporterView {
  status: string;
  title: string;
  comments: PublicReporterComment[];
}

interface HandleRow {
  id: string;
  workspaceId: string;
  issueId: string;
  reporterEmail: string | null;
}

/**
 * Look up a live handle. Unknown, malformed and expired tokens are all `null`
 * on purpose: the route answers one 404 either way, so the token space has no
 * existence oracle.
 */
async function liveHandle(token: string): Promise<HandleRow | null> {
  if (!token.startsWith(REPORT_TOKEN_PREFIX) || token.length > 128) return null;
  const [row] = await db
    .select({
      id: reporterHandles.id,
      workspaceId: reporterHandles.workspaceId,
      issueId: reporterHandles.issueId,
      reporterEmail: reporterHandles.reporterEmail,
    })
    .from(reporterHandles)
    .where(
      and(
        eq(reporterHandles.tokenHash, hashReporterToken(token)),
        gt(reporterHandles.expiresAt, clock.now()),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** Resolve a handle to its issue and the public thread. */
export async function readReport(token: string): Promise<ReporterView | null> {
  const handle = await liveHandle(token);
  if (!handle) return null;
  const [issue] = await db
    .select({ state: issues.state, title: issues.title })
    .from(issues)
    .where(
      and(
        eq(issues.id, handle.issueId),
        eq(issues.workspaceId, handle.workspaceId),
      ),
    )
    .limit(1);
  if (!issue) return null;

  // best effort: a failed touch must not cost the reporter the page
  await db
    .update(reporterHandles)
    .set({ lastViewedAt: clock.now() })
    .where(eq(reporterHandles.id, handle.id))
    .catch(() => undefined);

  const rows = await db
    .select({
      actorType: comments.actorType,
      actorId: comments.actorId,
      body: comments.body,
      createdAt: comments.createdAt,
    })
    .from(comments)
    .where(
      and(
        eq(comments.workspaceId, handle.workspaceId),
        eq(comments.issueId, handle.issueId),
        eq(comments.visibility, "public"),
      ),
    )
    .orderBy(asc(comments.createdAt));

  const humanIds = [
    ...new Set(
      rows.filter((r) => r.actorType === "human" && r.actorId).map((r) => r.actorId!),
    ),
  ];
  const agentIds = [
    ...new Set(
      rows.filter((r) => r.actorType === "agent" && r.actorId).map((r) => r.actorId!),
    ),
  ];
  // display names only — a reporter never learns ids, emails or roles
  const humanNames = new Map<string, string>();
  if (humanIds.length > 0) {
    for (const u of await db
      .select({ id: users.id, name: users.name })
      .from(users)
      .where(inArray(users.id, humanIds))) {
      humanNames.set(u.id, u.name);
    }
  }
  const agentNames = new Map<string, string>();
  if (agentIds.length > 0) {
    for (const a of await db
      .select({ id: agents.id, name: agents.name })
      .from(agents)
      .where(inArray(agents.id, agentIds))) {
      agentNames.set(a.id, a.name);
    }
  }

  return {
    status: issue.state,
    title: issue.title,
    comments: rows.map((r) => ({
      author:
        r.actorType === "human"
          ? (humanNames.get(r.actorId ?? "") ?? "Support")
          : r.actorType === "agent"
            ? (agentNames.get(r.actorId ?? "") ?? "Agent")
            : "Tallyline",
      body: r.body,
      createdAt: r.createdAt.toISOString(),
    })),
  };
}

/** The emailed link: the web view when configured, else this API's own page. */
export function reportUrl(token: string): string {
  return `${config_.webUrl}/report/${token}`;
}

export type ReplyDeliveryStatus =
  | { status: "skipped"; reason: "no_reporter_email" }
  | { status: "skipped"; reason: "already_delivered" }
  | { status: "sent" }
  | { status: "failed"; error: string };

/**
 * Email one staff reply to the address given at report time. A fresh handle is
 * minted for the link so the message carries a live token and the row keeps
 * only its hash. The delivery row is claimed before sending; the unique
 * comment id means a retry finds the claim and does not mail twice.
 */
export async function deliverReporterReply(input: {
  workspaceId: string;
  issueId: string;
  commentId: string;
  body: string;
}): Promise<ReplyDeliveryStatus> {
  const [handle] = await db
    .select({
      id: reporterHandles.id,
      reporterEmail: reporterHandles.reporterEmail,
      reporterName: reporterHandles.reporterName,
    })
    .from(reporterHandles)
    .where(
      and(
        eq(reporterHandles.workspaceId, input.workspaceId),
        eq(reporterHandles.issueId, input.issueId),
        isNotNull(reporterHandles.reporterEmail),
        gt(reporterHandles.expiresAt, clock.now()),
      ),
    )
    .orderBy(desc(reporterHandles.createdAt))
    .limit(1);
  if (!handle?.reporterEmail) {
    return { status: "skipped", reason: "no_reporter_email" };
  }

  const [claim] = await db
    .insert(reporterReplyDeliveries)
    .values({
      workspaceId: input.workspaceId,
      issueId: input.issueId,
      handleId: handle.id,
      commentId: input.commentId,
      toEmail: handle.reporterEmail,
    })
    .onConflictDoNothing()
    .returning({ id: reporterReplyDeliveries.id });
  if (!claim) return { status: "skipped", reason: "already_delivered" };

  const [issue] = await db
    .select({ key: issues.key, title: issues.title })
    .from(issues)
    .where(eq(issues.id, input.issueId))
    .limit(1);

  try {
    // a per-message handle: the mailed token is usable and the database never
    // holds it in plaintext
    const fresh = await issueReporterHandle({
      workspaceId: input.workspaceId,
      issueId: input.issueId,
      reporterEmail: handle.reporterEmail,
      reporterName: handle.reporterName,
    });
    const body =
      input.body.length > 2_000 ? `${input.body.slice(0, 2_000)}…` : input.body;
    await mailer().send({
      kind: "reporter_reply",
      to: handle.reporterEmail,
      subject: `Update on your report${issue ? ` ${issue.key}` : ""}`,
      text: [
        `Someone from the team replied to your report${issue ? ` "${issue.title}"` : ""}:`,
        "",
        body,
        "",
        "Read the full thread and its current status:",
        reportUrl(fresh.token),
        "",
        "This link is private to you and expires in 30 days.",
        `Stop these emails: ${config_.apiBaseUrl}/v1/report/${fresh.token}/unsubscribe`,
      ].join("\n"),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db
      .update(reporterReplyDeliveries)
      .set({ error: message.slice(0, 500) })
      .where(eq(reporterReplyDeliveries.id, claim.id));
    return { status: "failed", error: message };
  }

  await db
    .update(reporterReplyDeliveries)
    .set({ sentAt: clock.now() })
    .where(eq(reporterReplyDeliveries.id, claim.id));
  return { status: "sent" };
}

/**
 * Opt out of reply email for one issue. The handle itself keeps working; only
 * the address is dropped, so the reporter can still open their own link.
 */
export async function unsubscribeReport(token: string): Promise<boolean> {
  const handle = await liveHandle(token);
  if (!handle) return false;
  await db
    .update(reporterHandles)
    .set({ reporterEmail: null })
    .where(
      and(
        eq(reporterHandles.workspaceId, handle.workspaceId),
        eq(reporterHandles.issueId, handle.issueId),
      ),
    );
  return true;
}
