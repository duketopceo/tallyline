"use client";

import { ISSUE_STATES, PRIORITIES } from "@tallyline/types";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { activeFilterCount, filtersFromObject, filtersToObject, filtersToQuery, parseFilters, type Filters } from "@/lib/filters";
import { PRIORITY_LABEL, STATE_LABEL } from "@/lib/format";
import { useRegisterActions } from "./actions";
import { usePicker, type PickerOption } from "./picker";
import { useMeta } from "./providers";
import { useToast } from "./toast";
import { Kbd } from "./ui";

const SOURCES = ["web", "github", "slack", "api", "voice"];
const DIMS = [
  ["state", "State"], ["priority", "Priority"], ["assignee", "Assignee"], ["label", "Label"],
  ["project", "Project"], ["cycle", "Cycle"], ["team", "Team"], ["source", "Source"],
] as const;
type Dim = (typeof DIMS)[number][0];

const GROUPS = ["none", "state", "assignee", "priority", "project", "cycle"];
const SORTS = [["created", "Newest"], ["updated", "Recently updated"], ["priority", "Priority"]];
const DENSITIES = ["compact", "default", "comfortable"];

export function FilterBar({ title, count, hint }: { title: string; count: number; hint?: string }) {
  const meta = useMeta();
  const picker = usePicker();
  const toast = useToast();
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const filters = useMemo(() => parseFilters(search), [search]);
  const [, startTransition] = useTransition();
  const [saving, setSaving] = useState(false);
  const [q, setQ] = useState(filters.q ?? "");
  const searchRef = useRef<HTMLInputElement>(null);
  const filterBtn = useRef<HTMLButtonElement>(null);
  const displayBtn = useRef<HTMLButtonElement>(null);

  const go = (next: Partial<Filters>) => {
    const merged = { ...filters, ...next };
    startTransition(() => router.replace(`${pathname}${filtersToQuery(merged) ? `?${filtersToQuery(merged)}` : ""}`, { scroll: false }));
  };

  useEffect(() => setQ(filters.q ?? ""), [filters.q]);
  useEffect(() => {
    if (q === (filters.q ?? "")) return;
    const t = setTimeout(() => go({ q: q || null }), 250);
    return () => clearTimeout(t);
  }, [q]);

  const valueOptions = (dim: Dim): PickerOption[] => {
    switch (dim) {
      case "state": return ISSUE_STATES.map((s) => ({ id: s, label: STATE_LABEL[s]!, checked: filters.state.includes(s) }));
      case "priority": return PRIORITIES.map((p) => ({ id: p, label: PRIORITY_LABEL[p]!, checked: filters.priority.includes(p) }));
      case "assignee": return [
        { id: "me", label: "Me" }, { id: "none", label: "Unassigned" }, { id: "agent", label: "Any agent" }, { id: "human", label: "Any human" },
        ...meta.members.map((m) => ({ id: m.userId, label: m.name })), ...meta.agents.map((a) => ({ id: a.id, label: a.name, hint: "agent" })),
      ];
      case "label": return meta.labels.map((l) => ({ id: l.id, label: l.name }));
      case "project": return meta.projects.map((p) => ({ id: p.id, label: p.name }));
      case "cycle": return meta.cycles.map((c) => ({ id: c.id, label: `${meta.teams.find((t) => t.id === c.teamId)?.key ?? ""} Cycle ${c.number}${c.name ? ` · ${c.name}` : ""}` }));
      case "team": return meta.teams.map((t) => ({ id: t.key, label: `${t.name} (${t.key})` }));
      case "source": return SOURCES.map((s) => ({ id: s, label: s }));
    }
  };

  const openValues = (anchor: HTMLElement, dim: Dim) => {
    const multi = dim === "state" || dim === "priority";
    const label = DIMS.find((d) => d[0] === dim)![1];
    if (multi) {
      let sel = new Set(filters[dim]);
      picker.open({
        anchor, title: `Filter by ${label.toLowerCase()}`, multi: true, options: valueOptions(dim),
        onSelect: (id) => {
          sel = new Set(sel);
          if (sel.has(id)) sel.delete(id); else sel.add(id);
          go({ [dim]: [...sel] } as Partial<Filters>);
        },
      });
    } else {
      picker.open({ anchor, title: `Filter by ${label.toLowerCase()}`, options: valueOptions(dim), onSelect: (id) => go({ [dim]: id } as Partial<Filters>) });
    }
  };

  const addFilter = (anchor: HTMLElement) =>
    picker.open({ anchor, title: "Add filter", options: DIMS.map(([id, label]) => ({ id, label })), onSelect: (id) => setTimeout(() => openValues(anchor, id as Dim), 0) });

  const display = (anchor: HTMLElement) =>
    picker.open({
      anchor, title: "Display options",
      options: [
        ...GROUPS.map((g) => ({ id: `group:${g}`, label: `Group by ${g === "none" ? "nothing" : g}`, checked: (filters.group ?? "none") === g })),
        ...SORTS.map(([id, l]) => ({ id: `sort:${id}`, label: `Sort: ${l}`, checked: (filters.sort ?? "created") === id })),
        ...DENSITIES.map((d) => ({ id: `density:${d}`, label: `Density: ${d}` })),
      ],
      onSelect: (id) => {
        const [kind, v] = id.split(":") as [string, string];
        if (kind === "group") go({ group: v === "none" ? null : v });
        else if (kind === "sort") go({ sort: v === "created" ? null : v });
        else {
          try { localStorage.setItem("tl:density", v); } catch { /* ignore */ }
          window.dispatchEvent(new CustomEvent("tl:density", { detail: v }));
        }
      },
    });

  useRegisterActions(
    "filters",
    [
      { id: "filter", label: "Add filter", group: "View", keys: "f" },
      { id: "search", label: "Search in this list", group: "View", keys: "/" },
      { id: "display", label: "Display options (group, sort, density)", group: "View" },
      { id: "clear", label: "Clear filters", group: "View" },
    ],
    (id) => {
      if (id === "filter" && filterBtn.current) addFilter(filterBtn.current);
      else if (id === "search") searchRef.current?.focus();
      else if (id === "display" && displayBtn.current) display(displayBtn.current);
      else if (id === "clear") go({ state: [], priority: [], assignee: null, label: null, project: null, cycle: null, team: null, source: null, q: null });
    },
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target;
      if (t instanceof HTMLElement && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName))) return;
      if (document.querySelector('[role="dialog"]')) return;
      if (e.key === "/") { e.preventDefault(); searchRef.current?.focus(); }
      else if (e.key === "f" && filterBtn.current) { e.preventDefault(); addFilter(filterBtn.current); }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [filters]);

  const nameOf = (dim: Dim, id: string): string => {
    if (dim === "assignee") return ({ me: "Me", none: "Unassigned", agent: "Any agent", human: "Any human" } as Record<string, string>)[id] ?? valueOptions("assignee").find((o) => o.id === id)?.label ?? id;
    return valueOptions(dim).find((o) => o.id === id)?.label ?? id;
  };
  const pills = DIMS.flatMap(([dim, label]) => {
    const v = filters[dim];
    const ids = Array.isArray(v) ? v : v ? [v] : [];
    return ids.length ? [{ dim, label, text: ids.map((i) => nameOf(dim, i)).join(", ") }] : [];
  });

  const matchingView = meta.views.find((v) => filtersToQuery(filtersFromObject(v.filters)) === filtersToQuery(filters));
  const dirty = activeFilterCount(filters) > 0 || !!filters.group || !!filters.sort;

  async function saveView(name: string) {
    const res = await fetch("/api/views", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, filters: filtersToObject(filters), shared: false }) });
    setSaving(false);
    if (!res.ok) return toast.push({ error: true, message: "View not saved: the server rejected it. Try a different name." });
    toast.push({ message: `View "${name}" saved to the sidebar` });
    router.refresh();
  }
  async function deleteView() {
    if (!matchingView) return;
    const v = matchingView;
    const res = await fetch(`/api/views/${v.id}`, { method: "DELETE" });
    if (!res.ok) return toast.push({ error: true, message: "View not deleted: only its owner can delete it." });
    router.refresh();
    toast.push({
      message: `View "${v.name}" deleted`,
      undo: async () => {
        await fetch("/api/views", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: v.name, filters: v.filters, shared: v.shared }) });
        router.refresh();
      },
    });
  }

  return (
    <div className="border-b border-lining-faint">
      <div className="flex min-h-12 flex-wrap items-center gap-x-3 gap-y-1 px-4 py-1.5">
        <h1 className="text-[15px] font-semibold">{matchingView ? matchingView.name : title}</h1>
        <span className="text-[12px] tabular-nums text-ink-subtle">{count}{hint ? ` ${hint}` : ""}</span>
        <div className="ml-auto flex items-center gap-1.5">
          <label className="relative">
            <span className="sr-only">Search issues</span>
            <input
              ref={searchRef} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" type="search"
              onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); searchRef.current?.blur(); } }}
              className="h-8 w-36 rounded-sm border border-control bg-transparent px-2 text-[13px] text-ink placeholder:text-ink-subtle focus:w-52 max-sm:w-28"
            />
            <span className="pointer-events-none absolute right-2 top-1.5 max-sm:hidden"><Kbd>/</Kbd></span>
          </label>
          <button ref={filterBtn} type="button" onClick={(e) => addFilter(e.currentTarget)} className="h-8 rounded-sm border border-control px-2.5 text-[13px] text-ink-muted hover:bg-surface-2 hover:text-ink">Filter <Kbd>f</Kbd></button>
          <button ref={displayBtn} type="button" onClick={(e) => display(e.currentTarget)} className="h-8 rounded-sm border border-control px-2.5 text-[13px] text-ink-muted hover:bg-surface-2 hover:text-ink">Display</button>
        </div>
      </div>
      {(pills.length > 0 || dirty) && (
        <div className="flex flex-wrap items-center gap-1.5 px-4 pb-2" aria-label="Active filters" role="group">
          {pills.map((p) => (
            <span key={p.dim} className="inline-flex h-7 items-center overflow-hidden rounded-full border border-lining-strong text-[12px] text-ink-muted">
              <button type="button" onClick={(e) => openValues(e.currentTarget, p.dim)} className="h-full max-w-[16rem] truncate pl-2.5 pr-1.5 hover:bg-surface-2" aria-label={`${p.label}: ${p.text}. Edit filter`}>
                <span className="text-ink-subtle">{p.label}</span> {p.text}
              </button>
              <button type="button" onClick={() => go({ [p.dim]: Array.isArray(filters[p.dim]) ? [] : null } as Partial<Filters>)} aria-label={`Remove ${p.label} filter`} className="flex h-full w-6 items-center justify-center hover:bg-surface-2">
                <svg width="10" height="10" viewBox="0 0 10 10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden><path d="M2 2l6 6M8 2l-6 6" /></svg>
              </button>
            </span>
          ))}
          {saving ? (
            <form onSubmit={(e) => { e.preventDefault(); const v = new FormData(e.currentTarget).get("name"); if (typeof v === "string" && v.trim()) void saveView(v.trim()); }} className="flex items-center gap-1">
              <input name="name" autoFocus aria-label="View name" placeholder="View name" maxLength={120} onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); setSaving(false); } }} className="h-7 w-40 rounded-sm border border-control bg-transparent px-2 text-[13px]" />
              <button type="submit" className="h-7 rounded-sm bg-accent px-2.5 text-[12px] font-medium text-on-accent hover:bg-accent-hover">Save view</button>
            </form>
          ) : matchingView ? (
            <button type="button" onClick={() => void deleteView()} className="h-7 rounded-sm px-2 text-[12px] text-ink-subtle hover:bg-surface-2 hover:text-ink">Delete view</button>
          ) : (
            <button type="button" onClick={() => setSaving(true)} className="h-7 rounded-sm px-2 text-[12px] text-accent hover:bg-surface-2">Save as view</button>
          )}
          {activeFilterCount(filters) > 0 && (
            <button type="button" onClick={() => go({ state: [], priority: [], assignee: null, label: null, project: null, cycle: null, team: null, source: null, q: null })} className="h-7 rounded-sm px-2 text-[12px] text-ink-subtle hover:bg-surface-2 hover:text-ink">Clear all</button>
          )}
        </div>
      )}
    </div>
  );
}
