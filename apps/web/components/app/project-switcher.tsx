"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { NavIcon } from "./nav-icons";

interface Project { id: string; name: string }

// Jump to a project (a repo's worth of tickets and roadmap) or back to the
// overview. The popover is `fixed` so the scrolling sidebar cannot clip it, and
// it follows the picker popover's keyboard contract: type to filter, arrows to
// move, Enter to go, Escape to close and give focus back to the button.
export function ProjectSwitcher({ projects, currentId, rail, onChoose }: { projects: Project[]; currentId: string | null; rail: boolean; onChoose?: () => void }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  const current = projects.find((p) => p.id === currentId);
  const options = useMemo(() => {
    const all = [{ id: "", name: "All projects" }, ...projects];
    const s = q.trim().toLowerCase();
    return s ? all.filter((o) => o.name.toLowerCase().includes(s)) : all;
  }, [projects, q]);
  const activeIdx = Math.min(active, Math.max(0, options.length - 1));

  const close = (refocus = true) => {
    setOpen(false);
    setQ("");
    setActive(0);
    if (refocus) btnRef.current?.focus();
  };

  useEffect(() => {
    if (!open || !btnRef.current) return;
    const r = btnRef.current.getBoundingClientRect();
    const w = 248;
    const h = Math.min(360, 64 + (projects.length + 1) * 32);
    const left = rail ? r.right + 4 : r.left;
    const top = Math.max(8, Math.min(r.bottom + 4, window.innerHeight - h - 8));
    setPos({ left: Math.max(8, Math.min(left, window.innerWidth - w - 8)), top });
  }, [open, rail, projects.length]);

  // keep the highlighted option in view when the list scrolls
  useEffect(() => {
    if (!open) return;
    const id = options[activeIdx]?.id || "all";
    document.getElementById(`${listId}-${id}`)?.scrollIntoView({ block: "nearest" });
  }, [open, activeIdx, options, listId]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (boxRef.current?.contains(t) || btnRef.current?.contains(t)) return;
      close(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const choose = (id: string | undefined) => {
    if (id === undefined) return;
    close(false);
    onChoose?.();
    router.push(id ? `/projects/${id}` : "/overview");
  };

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Switch project, current: ${current?.name ?? "All projects"}`}
        title="Switch project"
        onClick={() => (open ? close(false) : setOpen(true))}
        className={`flex h-8 items-center gap-2 rounded-sm border border-lining text-body text-ink hover:bg-surface-2 ${rail ? "w-8 justify-center" : "w-full px-2"}`}
      >
        <span aria-hidden className="flex h-5 w-5 shrink-0 items-center justify-center rounded-xs bg-surface-3 text-micro font-medium text-ink-muted">
          {(current?.name ?? "All").slice(0, 1).toUpperCase()}
        </span>
        {!rail && (
          <>
            <span className="truncate">{current?.name ?? "All projects"}</span>
            <span aria-hidden className="ml-auto rotate-90 text-ink-subtle"><NavIcon name="chevron" size={12} /></span>
          </>
        )}
      </button>
      {open && (
        <div
          ref={boxRef}
          role="dialog"
          aria-label="Switch project"
          tabIndex={-1}
          style={{ top: pos?.top ?? -999, left: pos?.left ?? -999 }}
          className="fixed z-[70] w-[248px] overflow-hidden rounded-md border border-lining-strong bg-surface-3"
          onKeyDown={(e) => {
            if (e.key === "Tab") {
              close(false);
            } else if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              close();
            } else if (e.key === "ArrowDown") {
              e.preventDefault();
              setActive(Math.min(activeIdx + 1, options.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive(Math.max(activeIdx - 1, 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              choose(options[activeIdx]?.id);
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
            role="combobox"
            aria-expanded
            aria-label="Filter projects"
            aria-controls={listId}
            aria-activedescendant={options[activeIdx] ? `${listId}-${options[activeIdx]!.id || "all"}` : undefined}
            placeholder="Find a project"
            className="h-9 w-full border-b border-lining bg-transparent px-3 text-body text-ink placeholder:text-ink-subtle focus:outline-none"
          />
          {options.length === 0 && <p className="px-2 py-3 text-center text-xs text-ink-subtle">No matches</p>}
          <ul id={listId} role="listbox" aria-label="Projects" onMouseDown={(e) => e.preventDefault()} className="max-h-[320px] overflow-y-auto p-1">
            {options.map((o, i) => (
              <li
                key={o.id || "all"}
                id={`${listId}-${o.id || "all"}`}
                role="option"
                aria-selected={o.id === (currentId ?? "")}
                onMouseMove={() => setActive(i)}
                onClick={() => choose(o.id)}
                className={`flex h-8 cursor-pointer items-center gap-2 rounded-xs px-2 text-body ${i === activeIdx ? "bg-surface-4 text-ink" : "text-ink-muted"}`}
              >
                <span className="truncate">{o.name}</span>
                {o.id === (currentId ?? "") && <span aria-hidden className="ml-auto text-accent">✓</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}
