import type { Priority } from "@tallyline/types";
import {
  accent,
  bad,
  bold,
  colorOn,
  dim,
  GLINT,
  mut,
  ok,
  priorityGlyph,
  stateGlyph,
  stateText,
} from "./pretty.js";
import type {
  Comment,
  FeedEvent,
  Issue,
  IssueDetail,
} from "./client.js";

// Lower sorts first — urgent at the top of `ready`.
export const PRIORITY_RANK: Record<Priority, number> = {
  urgent: 0,
  high: 1,
  medium: 2,
  low: 3,
  none: 4,
};

export function compareForReady(a: Issue, b: Issue): number {
  const d = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
  return d !== 0 ? d : a.number - b.number;
}

// Slim issue shape for `--json` — stable keys for agent chaining.
export function slimIssue(i: Issue) {
  return {
    id: i.id,
    key: i.key,
    title: i.title,
    state: i.state,
    priority: i.priority,
    assigneeType: i.assigneeType,
    assigneeId: i.assigneeId,
    updatedAt: i.updatedAt,
  };
}

export function issueRow(i: Issue): string {
  if (!colorOn()) {
    const assignee = i.assigneeId ? ` @${i.assigneeType ?? "?"}` : "";
    return `${i.key.padEnd(10)} ${i.state.padEnd(11)} ${i.priority.padEnd(7)} ${i.title}${assignee}`;
  }
  const who = i.assigneeId
    ? i.assigneeType === "agent"
      ? ` ${accent(GLINT)}${accent(i.assigneeType)}`
      : ` ${mut(`@${i.assigneeType ?? "?"}`)}`
    : ` ${dim("·")}`;
  return `${stateGlyph(i.state)} ${accent(i.key.padEnd(9))} ${priorityGlyph(i.priority)} ${stateText(i.state.padEnd(14))}${i.title}${who}`;
}

function stamp(iso: string): string {
  return iso.replace("T", " ").replace(/\.\d+Z?$/, "");
}

export function issueDetail(
  i: IssueDetail,
  comments: Comment[],
): string[] {
  const field = (k: string, v: string) =>
    colorOn() ? `${mut(k.padEnd(9))} ${v}` : `${k.padEnd(9)} ${v}`;
  const lines: string[] = colorOn()
    ? [
        `${stateGlyph(i.state)} ${accent(i.key)}  ${bold(i.title)}`,
        "",
        field("state", stateText(i.state)),
        field("priority", `${priorityGlyph(i.priority)} ${i.priority}`),
        field("assignee", i.assigneeId ? `${i.assigneeType} ${i.assigneeId}` : dim("unassigned")),
        field("creator", `${i.creatorType}${i.creatorId ? ` ${i.creatorId}` : ""}`),
        field("created", stamp(i.createdAt)),
        field("updated", stamp(i.updatedAt)),
      ]
    : [
        `${i.key}  ${i.title}`,
        `state:     ${i.state}`,
        `priority:  ${i.priority}`,
        `assignee:  ${
          i.assigneeId ? `${i.assigneeType} ${i.assigneeId}` : "unassigned"
        }`,
        `creator:   ${i.creatorType}${i.creatorId ? ` ${i.creatorId}` : ""}`,
        `created:   ${stamp(i.createdAt)}`,
        `updated:   ${stamp(i.updatedAt)}`,
      ];
  if (i.labels?.length) {
    lines.push(
      field("labels", i.labels.map((l) => l.name).join(", ")),
    );
  }
  if (i.children?.length) {
    lines.push(
      field("children", i.children.map((c) => `${c.key} ${c.title}`).join(", ")),
    );
  }
  if (i.description) {
    lines.push("", i.description.trimEnd());
  }
  if (comments.length > 0) {
    lines.push("", colorOn() ? mut("comments") : "comments:");
    for (const c of comments) {
      const who = colorOn()
        ? c.actorType === "agent"
          ? accent(`${GLINT}${c.actorType}`)
          : bold(c.actorType)
        : c.actorType;
      const when = colorOn() ? dim(stamp(c.createdAt)) : stamp(c.createdAt);
      lines.push(`  ${colorOn() ? "·" : "["}${who} ${when}${colorOn() ? "" : "]"} ${c.body}`);
    }
  }
  return lines;
}

export function eventLine(e: FeedEvent): string {
  const actor = e.actorName
    ? `${e.actorType}:${e.actorName}`
    : e.actorType;
  const what = e.issueKey ?? `${e.entityType}:${e.entityId.slice(0, 8)}`;
  if (!colorOn())
    return `${e.id.padStart(6)}  ${stamp(e.createdAt)}  ${actor.padEnd(18)} ${e.action.padEnd(14)} ${what}`;
  const action =
    e.action.includes("creat") || e.action.includes("done")
      ? ok(e.action.padEnd(14))
      : e.action.includes("delet") || e.action.includes("cancel")
        ? bad(e.action.padEnd(14))
        : accent(e.action.padEnd(14));
  return `${dim(e.id.padStart(6))}  ${mut(stamp(e.createdAt))}  ${actor.padEnd(18)} ${action} ${what}`;
}
