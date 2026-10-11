"use client";

import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

// Single registry feeding the command palette and the `?` overlay, so the
// palette covers every action on screen (Silver Lining section 7/13 @palette).
export interface Action {
  id: string;
  label: string;
  group: string;
  keys?: string;
  run: () => void;
}

interface Reg {
  actions: Action[];
  register: (owner: string, list: Action[]) => void;
  unregister: (owner: string) => void;
}
const Ctx = createContext<Reg | null>(null);

export function ActionsProvider({ children }: { children: ReactNode }) {
  const [byOwner, setByOwner] = useState<Record<string, Action[]>>({});
  const value = useMemo<Reg>(
    () => ({
      actions: Object.values(byOwner).flat(),
      register: (owner, list) => setByOwner((m) => ({ ...m, [owner]: list })),
      unregister: (owner) =>
        setByOwner((m) => {
          const n = { ...m };
          delete n[owner];
          return n;
        }),
    }),
    [byOwner],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useActions(): Action[] {
  return useContext(Ctx)?.actions ?? [];
}

// register a set of actions while the caller is mounted; `run` closures are
// kept fresh through a ref so callers don't need stable identities
export function useRegisterActions(owner: string, list: Omit<Action, "run">[], run: (id: string) => void) {
  const reg = useContext(Ctx);
  const runRef = useRef(run);
  runRef.current = run;
  const sig = JSON.stringify(list);
  useEffect(() => {
    if (!reg) return;
    reg.register(owner, (JSON.parse(sig) as Omit<Action, "run">[]).map((a) => ({ ...a, run: () => runRef.current(a.id) })));
    return () => reg.unregister(owner);
  }, [owner, sig]);
}
