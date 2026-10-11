"use client";

import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";

// One popover host for every inline editor (state, priority, assignee, label,
// project, cycle, filters). Pickers are popovers anchored to their trigger,
// never modals, and Esc returns focus to the trigger (Silver Lining section 7).
export interface PickerOption {
  id: string;
  label: string;
  icon?: ReactNode;
  hint?: string;
  disabled?: boolean;
  checked?: boolean;
}
export interface PickerRequest {
  anchor: HTMLElement;
  title: string;
  options: PickerOption[];
  onSelect: (id: string) => void;
  multi?: boolean;
  searchable?: boolean;
}

const Ctx = createContext<{ open: (r: PickerRequest) => void; close: () => void } | null>(null);
export const usePicker = () => {
  const v = useContext(Ctx);
  if (!v) throw new Error("PickerProvider missing");
  return v;
};

export function PickerProvider({ children }: { children: ReactNode }) {
  const [req, setReq] = useState<PickerRequest | null>(null);
  const restore = useRef<HTMLElement | null>(null);
  const open = useCallback((r: PickerRequest) => {
    restore.current = r.anchor;
    setReq(r);
  }, []);
  const close = useCallback(() => {
    setReq(null);
    const el = restore.current;
    if (el && el.isConnected) el.focus();
  }, []);
  const value = useMemo(() => ({ open, close }), [open, close]);
  return (
    <Ctx.Provider value={value}>
      {children}
      {req && <PickerPopover key={req.title + req.options.length} req={req} close={close} />}
    </Ctx.Provider>
  );
}

function PickerPopover({ req, close }: { req: PickerRequest; close: () => void }) {
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const [checked, setChecked] = useState<Set<string>>(
    () => new Set(req.options.filter((o) => o.checked).map((o) => o.id)),
  );
  const boxRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    return s ? req.options.filter((o) => o.label.toLowerCase().includes(s)) : req.options;
  }, [q, req.options]);

  useEffect(() => {
    const r = req.anchor.getBoundingClientRect();
    const w = 248;
    const h = Math.min(360, 56 + req.options.length * 32);
    const left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8));
    const below = r.bottom + 4 + h <= window.innerHeight;
    setPos({ left, top: below ? r.bottom + 4 : Math.max(8, r.top - 4 - h) });
  }, [req]);

  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node) && !req.anchor.contains(e.target as Node)) close();
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [close, req.anchor]);

  function choose(o: PickerOption | undefined) {
    if (!o || o.disabled) return;
    if (req.multi) {
      setChecked((s) => {
        const n = new Set(s);
        if (n.has(o.id)) n.delete(o.id);
        else n.add(o.id);
        return n;
      });
      req.onSelect(o.id);
      return;
    }
    close();
    req.onSelect(o.id);
  }

  const activeIdx = Math.min(active, Math.max(0, shown.length - 1));
  return (
    <div
      ref={boxRef}
      role="dialog"
      aria-label={req.title}
      style={{ top: pos?.top ?? -999, left: pos?.left ?? -999 }}
      className="fixed z-[70] w-[248px] overflow-hidden rounded-md border border-lining-strong bg-surface-3"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          close();
        } else if (e.key === "ArrowDown") {
          e.preventDefault();
          setActive(Math.min(activeIdx + 1, shown.length - 1));
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          setActive(Math.max(activeIdx - 1, 0));
        } else if (e.key === "Enter") {
          e.preventDefault();
          choose(shown[activeIdx]);
        }
      }}
    >
      <input
        autoFocus
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setActive(0);
        }}
        aria-label={`${req.title}, filter`}
        aria-controls={listId}
        aria-activedescendant={shown[activeIdx] ? `${listId}-${shown[activeIdx]!.id}` : undefined}
        placeholder={req.title}
        className="h-9 w-full border-b border-lining bg-transparent px-3 text-[13px] text-ink placeholder:text-ink-subtle focus:outline-none"
      />
      <ul id={listId} role="listbox" aria-label={req.title} aria-multiselectable={req.multi} className="max-h-[320px] overflow-y-auto p-1">
        {shown.length === 0 && <li className="px-2 py-3 text-center text-[12px] text-ink-subtle">No matches</li>}
        {shown.map((o, i) => (
          <li
            key={o.id}
            id={`${listId}-${o.id}`}
            role="option"
            aria-selected={checked.has(o.id)}
            aria-disabled={o.disabled || undefined}
            onMouseMove={() => setActive(i)}
            onClick={() => choose(o)}
            className={`flex h-8 cursor-pointer items-center gap-2 rounded-xs px-2 text-[13px] ${i === activeIdx ? "bg-surface-4 text-ink" : "text-ink-muted"} ${o.disabled ? "cursor-not-allowed opacity-50" : ""}`}
          >
            {o.icon}
            <span className="truncate">{o.label}</span>
            {checked.has(o.id) && <span aria-hidden className="ml-auto text-accent">✓</span>}
            {o.hint && !checked.has(o.id) && <kbd className="ml-auto font-mono text-[11px] text-ink-subtle">{o.hint}</kbd>}
          </li>
        ))}
      </ul>
    </div>
  );
}
