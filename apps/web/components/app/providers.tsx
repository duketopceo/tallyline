"use client";

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import type { Meta } from "@/lib/meta";
import { ActionsProvider } from "./actions";
import { IssueStoreProvider } from "./issue-store";
import { PickerProvider } from "./picker";
import { ToastProvider } from "./toast";

const MetaCtx = createContext<Meta | null>(null);
export function useMeta(): Meta {
  const v = useContext(MetaCtx);
  if (!v) throw new Error("MetaProvider missing");
  return v;
}

export function useNames() {
  const m = useMeta();
  return useMemo(() => {
    const humans = new Map(m.members.map((x) => [x.userId, x.name]));
    const agents = new Map(m.agents.map((x) => [x.id, x.name]));
    return {
      assignee: (type: string | null | undefined, id: string | null | undefined) =>
        !type || !id ? null : ((type === "agent" ? agents.get(id) : humans.get(id)) ?? null),
      actor: (type: string, id: string | null | undefined) =>
        type === "agent" ? (id ? (agents.get(id) ?? "agent") : "agent") : type === "human" ? ((id && humans.get(id)) || "Someone") : "System",
    };
  }, [m]);
}

interface PeekCtx { key: string | null; open: (k: string) => void; close: () => void; toggle: (k: string) => void }
const PeekContext = createContext<PeekCtx | null>(null);
export const usePeek = () => {
  const v = useContext(PeekContext);
  if (!v) throw new Error("PeekProvider missing");
  return v;
};

function PeekProvider({ children }: { children: ReactNode }) {
  const [key, setKey] = useState<string | null>(null);
  const open = useCallback((k: string) => setKey(k), []);
  const close = useCallback(() => setKey(null), []);
  const toggle = useCallback((k: string) => setKey((c) => (c === k ? null : k)), []);
  const value = useMemo(() => ({ key, open, close, toggle }), [key, open, close, toggle]);
  return <PeekContext.Provider value={value}>{children}</PeekContext.Provider>;
}

export function AppProviders({ meta, children }: { meta: Meta; children: ReactNode }) {
  return (
    <MetaCtx.Provider value={meta}>
      <ToastProvider>
        <IssueStoreProvider>
          <PickerProvider>
            <ActionsProvider>
              <PeekProvider>{children}</PeekProvider>
            </ActionsProvider>
          </PickerProvider>
        </IssueStoreProvider>
      </ToastProvider>
    </MetaCtx.Provider>
  );
}
