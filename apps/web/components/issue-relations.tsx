"use client";

import type { IssueState } from "@tallyline/types";
import Link from "next/link";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useNames } from "@/components/app/providers";
import { useToast } from "@/components/app/toast";
import { StateGlyph } from "@/components/app/ui";

// U19: typed links between issues. The API lists each edge from this issue's
// point of view (`direction`), so "blocks" reads as "Blocks" or "Blocked by".
export interface RelationRow {
  id: string;
  relationType: "blocks" | "duplicate" | "related" | "similar";
  direction: "outgoing" | "incoming";
  other: { id: string; key: string; title: string; state: IssueState } | null;
}

const LABEL: Record<RelationRow["relationType"], [outgoing: string, incoming: string]> = {
  blocks: ["Blocks", "Blocked by"],
  duplicate: ["Duplicate of", "Duplicated by"],
  related: ["Related to", "Related to"],
  similar: ["Similar to", "Similar to"],
};

// what the add form offers; "blocked_by" is a blocks edge written from the other side
const ADD_OPTIONS = [
  { value: "blocks", label: "Blocks" },
  { value: "blocked_by", label: "Blocked by" },
  { value: "related", label: "Related to" },
  { value: "duplicate", label: "Duplicate of" },
] as const;
type AddKind = (typeof ADD_OPTIONS)[number]["value"];

const FINISHED: IssueState[] = ["done", "canceled", "duplicate"];

async function errorMessage(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
  return body?.error?.message ?? fallback;
}

export function RelationsSection({ issueKey }: { issueKey: string }) {
  const toast = useToast();
  const [rows, setRows] = useState<RelationRow[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [kind, setKind] = useState<AddKind>("blocks");
  const [target, setTarget] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/issues/${issueKey}/relations`, { cache: "no-store" });
      if (res.ok) setRows(((await res.json()) as { relations?: RelationRow[] }).relations ?? []);
    } catch {
      // leave the section as it was; the next action reloads it
    }
  }, [issueKey]);
  useEffect(() => void load(), [load]);

  async function add(e: FormEvent) {
    e.preventDefault();
    const other = target.trim().toUpperCase();
    if (!other) return;
    setBusy(true);
    // "X is blocked by Y" is stored as "Y blocks X"
    const [from, to, relationType] = kind === "blocked_by" ? [other, issueKey, "blocks"] : [issueKey, other, kind];
    try {
      const res = await fetch(`/api/issues/${from}/relations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ targetIssueKey: to, relationType }),
      });
      if (!res.ok) {
        toast.push({ error: true, message: await errorMessage(res, `Could not link ${other}.`) });
        return;
      }
      setTarget("");
      setAdding(false);
      await load();
    } catch {
      toast.push({ error: true, message: `Could not link ${other}: the server did not answer.` });
    } finally {
      setBusy(false);
    }
  }

  async function remove(r: RelationRow) {
    // the API deletes an edge through either end, so this issue's key always works
    try {
      const res = await fetch(`/api/issues/${issueKey}/relations/${r.id}`, { method: "DELETE" });
      if (!res.ok) return toast.push({ error: true, message: await errorMessage(res, "Could not remove the link.") });
      setRows((cur) => cur?.filter((x) => x.id !== r.id) ?? cur);
    } catch {
      toast.push({ error: true, message: "Could not remove the link: the server did not answer." });
    }
  }

  const blockedBy = (rows ?? []).filter(
    (r) => r.relationType === "blocks" && r.direction === "incoming" && r.other && !FINISHED.includes(r.other.state),
  );

  return (
    <section aria-label="Relations" className="mt-8">
      <div className="flex items-center gap-2">
        <h2 className="text-[13px] font-semibold">
          Relations {rows && rows.length > 0 && <span className="font-normal tabular-nums text-ink-subtle">{rows.length}</span>}
        </h2>
        {blockedBy.length > 0 && <BlockedBadge title={`Blocked by ${blockedBy.map((r) => r.other!.key).join(", ")}`} />}
        {!adding && (
          <button type="button" onClick={() => setAdding(true)} className="ml-auto h-7 rounded-sm px-2 text-[12px] text-ink-subtle hover:bg-surface-2 hover:text-ink">
            Add link
          </button>
        )}
      </div>
      {rows && rows.length > 0 && (
        <ul className="mt-2 divide-y divide-lining-faint rounded-md border border-lining bg-surface-1">
          {rows.map((r) => (
            <li key={r.id} className="flex h-9 items-center gap-3 px-3 text-[13px]">
              <span className="w-[92px] shrink-0 text-[12px] text-ink-subtle">{LABEL[r.relationType][r.direction === "outgoing" ? 0 : 1]}</span>
              {r.other ? (
                <Link href={`/issues/${r.other.key}`} className="flex min-w-0 flex-1 items-center gap-2 text-ink-muted hover:text-ink">
                  <StateGlyph state={r.other.state} size={12} />
                  <span className="font-mono text-[12px] text-ink-subtle">{r.other.key}</span>
                  <span className="truncate">{r.other.title}</span>
                </Link>
              ) : (
                <span className="flex-1 text-ink-subtle">Issue no longer available</span>
              )}
              <button type="button" onClick={() => void remove(r)} aria-label={`Remove link to ${r.other?.key ?? "issue"}`} className="h-6 shrink-0 rounded-xs px-1.5 text-[12px] text-ink-subtle hover:bg-surface-2 hover:text-ink">
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      {adding && (
        <form onSubmit={(e) => void add(e)} className="mt-2 flex flex-wrap items-center gap-2">
          <label className="sr-only" htmlFor="relation-kind">Link type</label>
          <select id="relation-kind" value={kind} onChange={(e) => setKind(e.currentTarget.value as AddKind)} className="h-8 rounded-sm border border-control bg-transparent px-2 text-[13px]">
            {ADD_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          <label className="sr-only" htmlFor="relation-target">Issue key</label>
          <input id="relation-target" value={target} onChange={(e) => setTarget(e.currentTarget.value)} placeholder="Issue key, like ENG-12" autoFocus className="h-8 w-[180px] rounded-sm border border-control bg-transparent px-2 font-mono text-[13px]" />
          <button type="submit" disabled={busy || !target.trim()} className="h-8 rounded-sm bg-accent px-3 text-[12px] font-medium text-on-accent hover:bg-accent-hover disabled:opacity-50">
            {busy ? "Linking" : "Link"}
          </button>
          <button type="button" onClick={() => { setAdding(false); setTarget(""); }} className="h-8 rounded-sm px-2 text-[12px] text-ink-subtle hover:bg-surface-2">
            Cancel
          </button>
        </form>
      )}
    </section>
  );
}

// shared with the board and list rows: an unfinished issue blocks this one
export function BlockedBadge({ title }: { title?: string }) {
  return (
    <span title={title ?? "Blocked by an unfinished issue"} className="inline-flex h-5 shrink-0 items-center rounded-full border border-lining-bright px-1.5 text-[11px] font-medium text-urgent">
      Blocked
    </span>
  );
}

// U23: rule-based suggestions (labels, project, team, assignee, likely
// duplicates). Nothing changes until a person accepts a chip.
export interface SuggestionRow {
  id: string;
  kind: "label" | "project" | "team" | "assignee" | "duplicate";
  suggestedValue: string;
  reason: string | null;
  state: "pending" | "accepted" | "dismissed";
}

const KIND_LABEL: Record<SuggestionRow["kind"], string> = {
  label: "Label",
  project: "Project",
  team: "Team",
  assignee: "Assignee",
  duplicate: "Duplicate",
};

export function SuggestionChips({ issueKey, onApplied }: { issueKey: string; onApplied: () => void }) {
  const toast = useToast();
  const names = useNames();
  const [rows, setRows] = useState<SuggestionRow[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch(`/api/issues/${issueKey}/suggestions`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { suggestions?: SuggestionRow[] } | null) => setRows(d?.suggestions ?? []))
      .catch(() => {});
  }, [issueKey]);

  async function suggest() {
    setBusy(true);
    try {
      const res = await fetch(`/api/issues/${issueKey}/suggestions`, { method: "POST" });
      if (!res.ok) return toast.push({ error: true, message: await errorMessage(res, "Suggestions unavailable right now.") });
      const body = (await res.json()) as { suggestions?: SuggestionRow[] };
      const next = body.suggestions ?? [];
      setRows(next);
      if (!next.some((s) => s.state === "pending")) toast.push({ message: "No suggestions for this issue." });
    } catch {
      toast.push({ error: true, message: "Suggestions unavailable right now." });
    } finally {
      setBusy(false);
    }
  }

  async function decide(s: SuggestionRow, state: "accepted" | "dismissed") {
    try {
      const res = await fetch(`/api/issues/${issueKey}/suggestions/${s.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ state }),
      });
      if (!res.ok) return toast.push({ error: true, message: await errorMessage(res, "Could not update the suggestion.") });
      setRows((cur) => cur.map((x) => (x.id === s.id ? { ...x, state } : x)));
      if (state === "accepted") onApplied();
    } catch {
      toast.push({ error: true, message: "Could not update the suggestion: the server did not answer." });
    }
  }

  const describe = (s: SuggestionRow) =>
    s.kind === "assignee" ? (names.assignee("human", s.suggestedValue) ?? s.reason ?? "a teammate") : (s.reason ?? s.suggestedValue);

  const pending = rows.filter((s) => s.state === "pending");
  return (
    <div role="group" aria-label="Suggestions" className="mt-3 flex flex-wrap items-center gap-2">
      {pending.map((s) => (
        <span key={s.id} className="inline-flex h-7 items-center gap-1.5 rounded-full border border-lining bg-surface-1 pl-2.5 pr-1 text-[12px] text-ink-muted">
          <span className="text-ink-subtle">{KIND_LABEL[s.kind]}</span>
          <span className="max-w-[36ch] truncate">{describe(s)}</span>
          <button type="button" onClick={() => void decide(s, "accepted")} aria-label={`Accept ${KIND_LABEL[s.kind].toLowerCase()} suggestion`} className="h-5 rounded-full px-1.5 text-accent hover:bg-surface-2">
            Accept
          </button>
          <button type="button" onClick={() => void decide(s, "dismissed")} aria-label={`Dismiss ${KIND_LABEL[s.kind].toLowerCase()} suggestion`} className="h-5 rounded-full px-1.5 text-ink-subtle hover:bg-surface-2 hover:text-ink">
            Dismiss
          </button>
        </span>
      ))}
      <button type="button" disabled={busy} onClick={() => void suggest()} className="h-7 rounded-sm border border-control px-2.5 text-[12px] text-ink-muted hover:bg-surface-2 hover:text-ink disabled:opacity-50">
        {busy ? "Suggesting" : "Suggest"}
      </button>
    </div>
  );
}
