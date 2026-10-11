"use client";

import { findPath, ISSUE_STATES, PRIORITIES, type IssueState, type Priority } from "@tallyline/types";
import { useCallback } from "react";
import { PRIORITY_LABEL, STATE_LABEL } from "@/lib/format";
import { useIssueEdit, type Edit, type IssuePatch } from "./issue-store";
import { usePicker, type PickerOption } from "./picker";
import { useMeta, useNames } from "./providers";
import { Assignee, PriorityGlyph, StateGlyph } from "./ui";

export interface IssueLike {
  key: string;
  state: IssueState;
  priority: Priority;
  assigneeType?: "human" | "agent" | null | undefined;
  assigneeId?: string | null | undefined;
  cycleId?: string | null | undefined;
  projectId?: string | null | undefined;
  teamId?: string | undefined;
  title?: string;
}

const who = (issues: IssueLike[]) => (issues.length === 1 ? issues[0]!.key : `${issues.length} issues`);

// Inline editors for one or many issues; every change is optimistic + undoable.
export function useIssueEditors() {
  const meta = useMeta();
  const names = useNames();
  const picker = usePicker();
  const apply = useIssueEdit();

  const run = useCallback(
    (issues: IssueLike[], patch: IssuePatch, label: string) => {
      const edits: Edit[] = issues
        .filter((i) => (Object.keys(patch) as (keyof IssuePatch)[]).some((k) => (i as unknown as IssuePatch)[k] !== patch[k]))
        .map((i) => ({
          key: i.key,
          patch,
          prior: Object.fromEntries(
            (Object.keys(patch) as (keyof IssuePatch)[]).map((k) => [k, (i as unknown as IssuePatch)[k] ?? null]),
          ) as IssuePatch,
        }));
      if (edits.length) void apply(edits, label);
    },
    [apply],
  );

  const pickState = useCallback(
    (anchor: HTMLElement, issues: IssueLike[]) => {
      const reachable = (to: IssueState) => issues.some((i) => i.state !== to && findPath(i.state, to) !== null);
      const options: PickerOption[] = ISSUE_STATES.filter((s) => s !== "triage").map((s) => ({
        id: s,
        label: STATE_LABEL[s]!,
        icon: <StateGlyph state={s} labelled={false} />,
        checked: issues.length === 1 && issues[0]!.state === s,
        disabled: !reachable(s) && !(issues.length === 1 && issues[0]!.state === s),
      }));
      picker.open({
        anchor,
        title: "Set state",
        options,
        onSelect: (id) => {
          const to = id as IssueState;
          const ok = issues.filter((i) => i.state === to || findPath(i.state, to) !== null);
          const skipped = issues.length - ok.length;
          run(ok, { state: to }, `${who(ok)} → ${STATE_LABEL[to]}${skipped ? ` (${skipped} skipped: not allowed from their state)` : ""}`);
        },
      });
    },
    [picker, run],
  );

  const pickPriority = useCallback(
    (anchor: HTMLElement, issues: IssueLike[]) => {
      picker.open({
        anchor,
        title: "Set priority",
        options: [...PRIORITIES].reverse().map((p) => ({
          id: p,
          label: PRIORITY_LABEL[p]!,
          icon: <PriorityGlyph priority={p} />,
          checked: issues.length === 1 && issues[0]!.priority === p,
        })),
        onSelect: (id) => run(issues, { priority: id as Priority }, `${who(issues)} priority → ${PRIORITY_LABEL[id]}`),
      });
    },
    [picker, run],
  );

  const pickAssignee = useCallback(
    (anchor: HTMLElement, issues: IssueLike[]) => {
      const cur = issues.length === 1 ? issues[0]! : null;
      const options: PickerOption[] = [
        { id: "none", label: "Unassigned", icon: <Assignee type={null} name={null} />, checked: !!cur && !cur.assigneeId },
        ...meta.members.map((m) => ({ id: `human:${m.userId}`, label: m.name, icon: <Assignee type="human" name={m.name} />, checked: cur?.assigneeId === m.userId })),
        ...meta.agents.map((a) => ({ id: `agent:${a.id}`, label: a.name, hint: "agent", icon: <Assignee type="agent" name={a.name} />, checked: cur?.assigneeId === a.id })),
      ];
      picker.open({
        anchor,
        title: "Assign to",
        options,
        onSelect: (id) => {
          if (id === "none") return run(issues, { assigneeType: null, assigneeId: null }, `${who(issues)} unassigned`);
          const [type, ref] = id.split(":") as ["human" | "agent", string];
          const name = names.assignee(type, ref) ?? "assignee";
          run(issues, { assigneeType: type, assigneeId: ref }, type === "agent" ? `${who(issues)} assigned to ${name}: session dispatched (undo does not recall it)` : `${who(issues)} assigned to ${name}`);
        },
      });
    },
    [meta, names, picker, run],
  );

  const pickProject = useCallback(
    (anchor: HTMLElement, issues: IssueLike[]) => {
      const team = issues[0]?.teamId;
      const projects = meta.projects.filter((p) => p.teamId === null || !team || p.teamId === team);
      picker.open({
        anchor,
        title: "Set project",
        options: [{ id: "none", label: "No project" }, ...projects.map((p) => ({ id: p.id, label: p.name, checked: issues.length === 1 && issues[0]!.projectId === p.id }))],
        onSelect: (id) => run(issues, { projectId: id === "none" ? null : id }, `${who(issues)} project updated`),
      });
    },
    [meta, picker, run],
  );

  const pickCycle = useCallback(
    (anchor: HTMLElement, issues: IssueLike[]) => {
      const team = issues[0]?.teamId;
      const cycles = meta.cycles.filter((c) => !team || c.teamId === team);
      const teamKey = (id: string) => meta.teams.find((t) => t.id === id)?.key ?? "";
      picker.open({
        anchor,
        title: "Set cycle",
        options: [{ id: "none", label: "No cycle" }, ...cycles.map((c) => ({ id: c.id, label: `${teamKey(c.teamId)} Cycle ${c.number}${c.name ? ` · ${c.name}` : ""}`, hint: c.isActive ? "active" : "", checked: issues.length === 1 && issues[0]!.cycleId === c.id }))],
        onSelect: (id) => run(issues, { cycleId: id === "none" ? null : id }, `${who(issues)} cycle updated`),
      });
    },
    [meta, picker, run],
  );

  const setTitle = useCallback((issue: IssueLike, title: string) => run([issue], { title }, `${issue.key} renamed`), [run]);

  return { pickState, pickPriority, pickAssignee, pickProject, pickCycle, setTitle, run };
}
