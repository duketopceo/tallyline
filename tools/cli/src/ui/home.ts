import type { ApiClient, Issue, IssueList } from "../client.js";
import { accent, bold, dim, mut, stateMark } from "../pretty.js";
import { ago, clip, nextSteps, section, statusLine } from "./render.js";

export interface HomeData {
  version: string;
  server: string;
  workspace: string;
  connected: boolean;
  greetingName?: string | undefined;
  inReview: number;
  inTriage: number;
  working: { key: string; title: string; who: string; since: string }[];
  now?: number;
}

export function greeting(hour: number): string {
  if (hour < 5) return "Burning the midnight oil";
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function renderHome(d: HomeData, hour: number, width = 78): string {
  const left = `${accent("✦")} ${bold("tallyline")}  ${dim(`v${d.version}`)}`;
  const right = d.connected
    ? `${accent("●")} connected to ${hostOf(d.server)}`
    : `${mut("○")} not connected`;
  const out: string[] = [`${left}    ${dim(right)}`.trimEnd(), ""];

  if (!d.connected) {
    out.push(
      "Welcome. Let's connect this computer to your Tallyline.",
      "",
      nextSteps([
        ["tallyline connect", "sign in to your Tallyline"],
        ["tallyline setup", "set up your own Tallyline on this computer"],
        ["tallyline help", "see everything it can do"],
      ]),
    );
    return out.join("\n");
  }

  out.push(
    `${greeting(hour)}${d.greetingName ? `, ${d.greetingName}` : ""}.`,
    "",
  );

  const need: string[] = [];
  if (d.inReview > 0)
    need.push(
      `${stateMark("in_review")} ${d.inReview} ${d.inReview === 1 ? "issue" : "issues"} waiting for your review`,
    );
  if (d.inTriage > 0)
    need.push(`${stateMark("triage")} ${d.inTriage} new in triage`);
  out.push(
    section(
      "Needs you",
      need.length ? need : [statusLine("ok", "Nothing waiting. Nice.")],
    ),
    "",
  );

  if (d.working.length > 0) {
    const rows = d.working.slice(0, 5).map((w) => {
      const meta = `${w.who}${w.since ? ` · ${w.since}` : ""}`;
      const room = Math.max(12, width - 4 - w.key.length - meta.length - 4);
      return `${stateMark("in_progress")} ${bold(w.key.padEnd(8))}${clip(w.title, room).padEnd(room)}  ${dim(meta)}`;
    });
    out.push(section("Working now", rows), "");
  }

  out.push(
    nextSteps([
      ["tallyline ready", "pick something to work on"],
      ["tallyline list", "browse the board"],
      ["tallyline doctor", "check that everything is healthy"],
    ]),
  );
  return out.join("\n");
}

// Three small calls, run together. One failing degrades that row; all three
// failing means the server is unreachable, which the caller shows honestly
// instead of a misleading "nothing waiting".
export async function loadHome(
  client: ApiClient,
  base: Pick<HomeData, "version" | "server" | "workspace">,
  nameOf: (assigneeId: string | null) => string,
): Promise<HomeData> {
  const [review, triage, wip] = await Promise.allSettled([
    client.listIssues({ state: "in_review", limit: 100 }),
    client.listIssues({ state: "triage", limit: 100 }),
    client.listIssues({ state: "in_progress", limit: 5 }),
  ]);
  if (
    review.status === "rejected" &&
    triage.status === "rejected" &&
    wip.status === "rejected"
  ) {
    throw review.reason;
  }
  const issues = (r: PromiseSettledResult<IssueList>): Issue[] =>
    r.status === "fulfilled" ? r.value.issues : [];
  return {
    ...base,
    connected: true,
    inReview: issues(review).length,
    inTriage: issues(triage).length,
    working: issues(wip).map((i) => ({
      key: i.key,
      title: i.title,
      who: nameOf(i.assigneeId ?? null),
      since: ago(i.updatedAt),
    })),
  };
}
