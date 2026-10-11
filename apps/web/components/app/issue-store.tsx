"use client";

import { findPath, type IssueState, type Priority } from "@tallyline/types";
import { useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useTransition, type ReactNode } from "react";
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
  estimate: number | null;
}>;

export interface Edit {
  key: string;
  patch: IssuePatch;
  prior: IssuePatch;
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

export function useIssueEdit() {
  return useStore().apply;
}

// merge optimistic overrides over a server row
export function useMerged<T extends { key: string }>(issue: T): T & IssuePatch {
  const { overrides } = useStore();
  const o = overrides[issue.key];
  return useMemo(() => (o ? { ...issue, ...o } : issue), [issue, o]);
}

async function send(key: string, body: Record<string, unknown>): Promise<string | null> {
  try {
    const res = await fetch(`/api/issues/${key}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) return null;
    const err = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
    return err?.error?.message ?? `server returned ${res.status}`;
  } catch {
    return "network unreachable";
  }
}

export function IssueStoreProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const toast = useToast();
  const [overrides, setOverrides] = useState<Record<string, IssuePatch>>({});
  const [pending, startTransition] = useTransition();
  const toClear = useRef<Set<string>>(new Set());
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
      const failures: { key: string; msg: string }[] = [];
      await Promise.all(
        edits.map(async (e) => {
          const { state, ...rest } = e.patch;
          if (state !== undefined) {
            const from = e.prior.state;
            const steps = from && from !== state ? findPath(from, state) : [state];
            for (const s of steps ?? []) {
              const msg = await send(e.key, { state: s });
              if (msg) return void failures.push({ key: e.key, msg });
            }
          }
          if (Object.keys(rest).length) {
            const msg = await send(e.key, rest);
            if (msg) failures.push({ key: e.key, msg });
          }
        }),
      );
      const failed = new Set(failures.map((f) => f.key));
      for (const e of edits) toClear.current.add(e.key);
      if (failed.size) {
        setOverrides((o) => {
          const n = { ...o };
          for (const e of edits) if (failed.has(e.key)) n[e.key] = { ...n[e.key], ...e.prior };
          return n;
        });
        toast.push({
          error: true,
          message: `${failed.size === 1 ? failures[0]!.key : `${failed.size} issues`} not changed: ${failures[0]!.msg}`,
        });
      }
      refresh();
      const ok = edits.filter((e) => !failed.has(e.key));
      if (ok.length && !opts?.silent) {
        const undoable = ok.every((e) => e.patch.state === undefined || e.prior.state === undefined || findPath(e.patch.state, e.prior.state) !== null);
        toast.push({
          message: label,
          ...(undoable
            ? { undo: () => void apply(ok.map((e) => ({ key: e.key, patch: e.prior, prior: e.patch })), "Undone", { silent: true }) }
            : {}),
        });
      }
      return failed.size === 0;
    },
    [refresh, toast],
  );

  const value = useMemo(() => ({ overrides, apply }), [overrides, apply]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
