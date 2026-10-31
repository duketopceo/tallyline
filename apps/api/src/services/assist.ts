import { and, desc, eq, ne } from "drizzle-orm";
import { db } from "../db/client.js";
import { agentActivities, agentSessions, comments, issues } from "../db/schema.js";
import { HttpError } from "../lib/errors.js";
import { workspaceLLM } from "./ai-seam.js";
import type { LLMProvider } from "./llm.js";
import type { ProjectUpdateDraft } from "./project-update-draft.js";

// Every surface is opt-in: callers invoke on demand, nothing fires on writes.
// The kill switch lives in the route layer (requireAi). Without an injected
// provider each call runs on the workspace's provider, so its monthly cap and
// usage ledger apply (S3-U4). Tests inject a stub.

export interface TriageSuggestion {
  action: "accept" | "decline";
  reason: string;
}

export interface SubIssueDraft {
  title: string;
  description: string;
}

/** most sub-issues one break-down may propose */
export const MAX_SUB_ISSUES = 8;

export interface AnswerDraft {
  /** the agent's open question, verbatim */
  question: string;
  draft: string;
}

/** longest model-written text we pass back (polish, brief, answer) */
export const MAX_DRAFT_CHARS = 8000;

const clip = (text: string) => text.trim().slice(0, MAX_DRAFT_CHARS);

export interface DuplicateMatch {
  key: string;
  title: string;
  reason: string;
}

const SYSTEM = "You are a terse assistant embedded in an issue tracker. Answer only what is asked; no preamble.";

function parseJson<T>(text: string): T | null {
  const m = text.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]) as T;
  } catch {
    return null;
  }
}

async function findIssueRow(workspaceId: string, key: string) {
  const [issue] = await db
    .select()
    .from(issues)
    .where(and(eq(issues.workspaceId, workspaceId), eq(issues.key, key)));
  if (!issue) throw new HttpError(404, "NOT_FOUND", "issue not found");
  return issue;
}

export function createAssist(provider?: LLMProvider) {
  const llmFor = (workspaceId: string, action: string): LLMProvider => provider ?? workspaceLLM(workspaceId, action);

  return {
    async summarizeIssue(workspaceId: string, key: string): Promise<string> {
      const issue = await findIssueRow(workspaceId, key);
      const thread = await db
        .select({ body: comments.body })
        .from(comments)
        .where(eq(comments.issueId, issue.id))
        .orderBy(desc(comments.createdAt))
        .limit(20);
      const prompt = [
        `Issue ${issue.key} (${issue.state}, priority ${issue.priority}): ${issue.title}`,
        issue.description ? `Description:\n${issue.description}` : "",
        thread.length > 0
          ? `Comments (newest first):\n${thread.map((c) => `- ${c.body}`).join("\n")}`
          : "",
        "\nSummarize this issue in 2-3 sentences: what it is, current state, and what happens next if anything.",
      ]
        .filter(Boolean)
        .join("\n\n");
      return llmFor(workspaceId, "summarize").complete({ system: SYSTEM, user: prompt });
    },

    async suggestTriage(
      workspaceId: string,
      key: string,
    ): Promise<TriageSuggestion> {
      const issue = await findIssueRow(workspaceId, key);
      const prompt = [
        `Triage this issue:\nKey: ${issue.key}\nTitle: ${issue.title}`,
        issue.description ? `Description:\n${issue.description}` : "",
        `\nReply as JSON only: {"action":"accept"|"decline","reason":"one sentence"}.`,
        `Accept if this is actionable work for the team; decline if it is noise, spam, a question, or not work.`,
      ]
        .filter(Boolean)
        .join("\n\n");
      const text = await llmFor(workspaceId, "triage_suggest").complete({
        system: SYSTEM,
        user: prompt,
        maxTokens: 128,
      });
      const parsed = parseJson<{ action?: string; reason?: string }>(text);
      if (
        !parsed ||
        (parsed.action !== "accept" && parsed.action !== "decline")
      ) {
        throw new HttpError(
          502,
          "LLM_BAD_RESPONSE",
          "triage suggestion was not parseable",
        );
      }
      return { action: parsed.action, reason: parsed.reason ?? "" };
    },

    async checkDuplicates(
      workspaceId: string,
      title: string,
      description?: string,
    ): Promise<DuplicateMatch[]> {
      // candidates: recent non-terminal issues — cap keeps the prompt small
      const candidates = await db
        .select({ key: issues.key, title: issues.title })
        .from(issues)
        .where(
          and(
            eq(issues.workspaceId, workspaceId),
            ne(issues.state, "done"),
            ne(issues.state, "canceled"),
            ne(issues.state, "duplicate"),
          ),
        )
        .orderBy(desc(issues.createdAt))
        .limit(100);
      if (candidates.length === 0) return [];

      const prompt = [
        `New issue title: ${title}`,
        description ? `New issue description: ${description}` : "",
        `Existing open issues:\n${candidates.map((c) => `${c.key}: ${c.title}`).join("\n")}`,
        `\nWhich existing issues are likely duplicates of the new one? Reply as JSON only: {"duplicates":[{"key":"ABC-1","reason":"one sentence"}]}. Return an empty list if none.`,
      ]
        .filter(Boolean)
        .join("\n\n");
      const text = await llmFor(workspaceId, "dup_check").complete({
        system: SYSTEM,
        user: prompt,
        maxTokens: 256,
      });
      const parsed = parseJson<{
        duplicates?: { key?: string; reason?: string }[];
      }>(text);
      const byKey = new Map(candidates.map((c) => [c.key, c.title]));
      return (parsed?.duplicates ?? [])
        .filter((d): d is { key: string; reason?: string } => !!d.key)
        .flatMap((d) => {
          const t = byKey.get(d.key);
          return t ? [{ key: d.key, title: t, reason: d.reason ?? "" }] : [];
        });
    },

    /**
     * Propose sub-issues for a larger issue. Nothing is written: the caller
     * shows the drafts and a person creates the ones they want.
     */
    async suggestSubIssues(workspaceId: string, key: string): Promise<SubIssueDraft[]> {
      const issue = await findIssueRow(workspaceId, key);
      const prompt = [
        `Break this issue into smaller pieces of work:\nKey: ${issue.key}\nTitle: ${issue.title}`,
        issue.description ? `Description:\n${issue.description}` : "",
        `\nReply as JSON only: {"subIssues":[{"title":"short imperative title","description":"one or two sentences"}]}.`,
        `Use 2 to ${MAX_SUB_ISSUES} sub-issues, each independently doable. Return an empty list if the issue is already small.`,
      ]
        .filter(Boolean)
        .join("\n\n");
      const text = await llmFor(workspaceId, "breakdown").complete({ system: SYSTEM, user: prompt, maxTokens: 700 });
      const parsed = parseJson<{ subIssues?: ({ title?: unknown; description?: unknown } | null)[] }>(text);
      if (!parsed || !Array.isArray(parsed.subIssues)) {
        throw new HttpError(502, "LLM_BAD_RESPONSE", "the break-down wasn't readable; try again");
      }
      const seen = new Set<string>();
      return parsed.subIssues
        .flatMap((d) => {
          if (!d || typeof d !== "object") return [];
          const title = typeof d.title === "string" ? d.title.trim().slice(0, 200) : "";
          if (!title || seen.has(title.toLowerCase())) return [];
          seen.add(title.toLowerCase());
          const description = typeof d.description === "string" ? d.description.trim().slice(0, 2000) : "";
          return [{ title, description }];
        })
        .slice(0, MAX_SUB_ISSUES);
    },

    /**
     * S3-U4b: rewrite a fact-based status update in plain prose. The facts
     * stay the draft's; the model only words them. Output that drops an issue
     * key the facts name is rejected, so a polish can't quietly lose work.
     */
    async polishProjectUpdate(workspaceId: string, projectName: string, draft: ProjectUpdateDraft): Promise<string> {
      const prompt = [
        `Project: ${projectName}`,
        `Suggested health: ${draft.suggestedHealth} (${draft.healthReason})`,
        `Facts-only draft:\n${draft.body}`,
        "\nRewrite the draft as a short status update for the team: 3 to 6 sentences or a few bullets, plain words, no headings.",
        "Keep every issue key exactly as written. Add nothing that is not in the draft.",
      ].join("\n\n");
      const text = clip(await llmFor(workspaceId, "status_update").complete({ system: SYSTEM, user: prompt, maxTokens: 500 }));
      const required = [...draft.doneKeys, ...draft.blockedKeys];
      if (!text || required.some((k) => !text.includes(k))) {
        throw new HttpError(502, "LLM_BAD_RESPONSE", "the polished update left out some work; use the facts draft or try again");
      }
      return text;
    },

    /** S3-U4b: a pull-request description for the work on an issue. Nothing is posted. */
    async draftPrBrief(workspaceId: string, key: string): Promise<string> {
      const issue = await findIssueRow(workspaceId, key);
      const thread = await db
        .select({ body: comments.body })
        .from(comments)
        .where(eq(comments.issueId, issue.id))
        .orderBy(desc(comments.createdAt))
        .limit(10);
      const prompt = [
        `Issue ${issue.key}: ${issue.title}`,
        issue.description ? `Description:\n${issue.description}` : "",
        thread.length > 0 ? `Recent comments (newest first):\n${thread.map((c) => `- ${c.body}`).join("\n")}` : "",
        "\nDraft a pull-request description in Markdown with three short sections: ## Summary, ## Changes, ## Testing.",
        `Describe what the issue asks for, not code you have not seen. End with the line: Closes ${issue.key}`,
      ]
        .filter(Boolean)
        .join("\n\n");
      const text = clip(await llmFor(workspaceId, "pr_brief").complete({ system: SYSTEM, user: prompt, maxTokens: 700 }));
      if (!text) throw new HttpError(502, "LLM_BAD_RESPONSE", "the brief came back empty; try again");
      return text.includes(`Closes ${issue.key}`) ? text : `${text}\n\nCloses ${issue.key}`;
    },

    /**
     * S3-U4b: a suggested reply to the question an agent is waiting on. The
     * person edits and sends it as a `prompt`; nothing is posted here.
     */
    async draftAnswer(workspaceId: string, sessionId: string): Promise<AnswerDraft> {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId)) {
        throw new HttpError(404, "NOT_FOUND", "session not found");
      }
      const [session] = await db
        .select()
        .from(agentSessions)
        .where(and(eq(agentSessions.id, sessionId), eq(agentSessions.workspaceId, workspaceId)));
      if (!session) throw new HttpError(404, "NOT_FOUND", "session not found");
      const recent = await db
        .select({ type: agentActivities.type, content: agentActivities.content })
        .from(agentActivities)
        .where(and(eq(agentActivities.sessionId, session.id), eq(agentActivities.ephemeral, false)))
        .orderBy(desc(agentActivities.id))
        .limit(12);
      const bodyOf = (c: unknown) => {
        const b = (c as { body?: unknown } | null)?.body;
        return typeof b === "string" ? b : "";
      };
      const asked = session.status === "awaitingInput" ? recent.find((a) => a.type === "elicitation") : undefined;
      const question = asked ? bodyOf(asked.content) : "";
      if (!question) throw new HttpError(409, "NO_OPEN_QUESTION", "the agent isn't waiting on a question");
      const issue = await db.select().from(issues).where(eq(issues.id, session.issueId)).then((r) => r[0]);
      const prompt = [
        issue ? `Issue ${issue.key}: ${issue.title}` : "",
        issue?.description ? `Description:\n${issue.description}` : "",
        `Recent session activity (newest first):\n${recent
          .map((a) => `- ${a.type}: ${bodyOf(a.content).slice(0, 400)}`)
          .filter((l) => !l.endsWith(": "))
          .join("\n")}`,
        `The agent asks: ${question}`,
        "\nDraft a short, direct reply a teammate could send. If the issue does not settle the question, say what to decide instead of guessing.",
      ]
        .filter(Boolean)
        .join("\n\n");
      const draft = clip(await llmFor(workspaceId, "inbox_answer").complete({ system: SYSTEM, user: prompt, maxTokens: 400 }));
      if (!draft) throw new HttpError(502, "LLM_BAD_RESPONSE", "the answer came back empty; try again");
      return { question, draft };
    },
  };
}

export type Assist = ReturnType<typeof createAssist>;
