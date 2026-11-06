"use client";

import { findPath, type IssueState, type Priority } from "@tallyline/types";
import { useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useTransition, type ReactNode } from "react";
import { pathAfterMove } from "@/lib/issue-link";
import { latestVersion, sendIssuePatch } from "@/lib/write-contract";
import { useToast } from "./toast";

// Optimistic issue edits shared by lists, board, peek and detail. The UI shows
// the result immediately (overrides), the server reconciles, a rejection rolls
// back visibly, and a success toast offers Undo (Silver Lining section 7).
export type IssuePatch = Partial<{
  state: IssueState;
  priority: Priority;
  assigneeType: "human" | "agent" | null;
  assigneeId: string | null;
  title: string;
  cycleId: string | null;
  projectId: string | null;
  milestoneId: string | null;
  teamId: string;
  estimate: number | null;
  labels: { id: string; name: string; color: string }[];
  dueDate: string | null;
  description: string | null;
}>;

export interface Edit {
  key: string;
  patch: IssuePatch;
  prior: IssuePatch;
  // the issue version the edit was made against (write contract C6); omitted
  // = no precondition
  version?: number | undefined;
}

interface Store {
  overrides: Record<string, IssuePatch>;
  apply: (edits: Edit[], label: string, opts?: { silent?: boolean }) => Promise<boolean>;
}

const Ctx = createContext<Store | null>(null);
const useStore = () => {
  const v = useContext(Ctx);
  if (!v) throw new Error("IssueStoreProvider missing");
  return v;
};

export function useOverrides() {
  return useStore().overrides;
}

export function useIssueEdit() {
  return useStore().apply;
}

// merge optimistic overrides over a server row
export function useMerged<T extends { key: string }>(issue: T): T & IssuePatch {
  const { overrides } = useStore();
  const o = overrides[issue.key];
  return useMemo(() => (o ? { ...issue, ...o } : issue), [issue, o]);
}

export function IssueStoreProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const toast = useToast();
  const [overrides, setOverrides] = useState<Record<string, IssuePatch>>({});
  const [pending, startTransition] = useTransition();
  const toClear = useRef<Set<string>>(new Set());
  // newest version each of our own writes returned, so a quick second edit does
  // not send the version from props that have not refreshed yet
  const known = useRef<Record<string, number>>({});
  const started = useRef(false);

  useEffect(() => {
    if (pending) started.current = true;
    else if (started.current && toClear.current.size) {
      const keys = [...toClear.current];
      toClear.current.clear();
      started.current = false;
      setOverrides((o) => {
        const n = { ...o };
        for (const k of keys) delete n[k];
        return n;
      });
    }
  }, [pending]);

  const refresh = useCallback(() => startTransition(() => router.refresh()), [router]);

  const apply = useCallback<Store["apply"]>(
    async (edits, label, opts) => {
      setOverrides((o) => {
        const n = { ...o };
        for (const e of edits) n[e.key] = { ...n[e.key], ...e.patch };
        return n;
      });
      const failures: { edit: Edit; msg: string; stale: boolean; serverVersion: number | null }[] = [];
      await Promise.all(
        edits.map(async (e) => {
          let version = latestVersion(e.version, known.current[e.key]);
          // the issue's current key: a teamId step re-keys it, and every later
          // step of this edit addresses the new key
          let key = e.key;
          // one PATCH; false stops this edit (rolled back below)
          const step = async (body: Record<string, unknown>) => {
            const r = await sendIssuePatch(key, body, version);
            if (r.kind === "ok") {
              if (r.key && r.key !== key) {
                // the open page for the old key follows the issue to its new one
                const to = pathAfterMove(window.location.pathname, key, r.key);
                if (to) router.replace(to);
                key = r.key;
              }
              if (r.version !== null) {
                version = r.version;
                known.current[e.key] = r.version;
                known.current[key] = r.version;
              }
              return true;
            }
            failures.push({ edit: e, msg: r.message, stale: r.kind === "stale", serverVersion: r.kind === "stale" ? r.version : null });
            return false;
          };
          const { state, labels, ...rest } = e.patch;
          if (state !== undefined) {
            const from = e.prior.state;
            const steps = from && from !== state ? findPath(from, state) : [state];
            for (const s of steps ?? []) if (!(await step({ state: s }))) return;
          }
          if (labels !== undefined && !(await step({ labelIds: labels.map((l) => l.id) }))) return;
          if (Object.keys(rest).length) await step(rest);
        }),
      );
      const failed = new Set(failures.map((f) => f.edit.key));
      for (const e of edits) toClear.current.add(e.key);
      if (failed.size) {
        setOverrides((o) => {
          const n = { ...o };
          for (const e of edits) if (failed.has(e.key)) n[e.key] = { ...n[e.key], ...e.prior };
          return n;
        });
        const plain = failures.filter((f) => !f.stale);
        if (plain.length) {
          const keys = new Set(plain.map((f) => f.edit.key));
          toast.push({
            error: true,
            message: `${keys.size === 1 ? plain[0]!.edit.key : `${keys.size} issues`} not changed: ${plain[0]!.msg}`,
          });
        }
        // C6: the issue changed elsewhere. The edit is already rolled back; the
        // person chooses to resend it over the server's version or drop it.
        for (const f of failures.filter((x) => x.stale)) {
          toast.push({
            error: true,
            message: `${f.edit.key} changed elsewhere.`,
            actions: [
              { label: "Keep mine", run: () => void apply([{ ...f.edit, version: f.serverVersion ?? undefined }], `${f.edit.key} updated`) },
              { label: "Use theirs", run: () => undefined },
            ],
          });
        }
      }
      refresh();
      const ok = edits.filter((e) => !failed.has(e.key));
      if (ok.length && !opts?.silent) {
        // a team move re-keys the issue and clears team-scoped fields; moving back
        // would mint a third key, not restore the old one, so it has no Undo
        const undoable = ok.every(
          (e) =>
            e.patch.teamId === undefined &&
            (e.patch.state === undefined || e.prior.state === undefined || findPath(e.patch.state, e.prior.state) !== null),
        );
        toast.push({
          message: label,
          ...(undoable
            ? { undo: () => void apply(ok.map((e) => ({ key: e.key, patch: e.prior, prior: e.patch })), "Undone", { silent: true }) }
            : {}),
        });
      }
      return failed.size === 0;
    },
    [refresh, router, toast],
  );

  const value = useMemo(() => ({ overrides, apply }), [overrides, apply]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
