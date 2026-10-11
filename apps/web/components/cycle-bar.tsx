"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import { usePicker } from "@/components/app/picker";
import { useToast } from "@/components/app/toast";
import { Kbd } from "@/components/app/ui";

export interface CycleOption {
  id: string;
  number: number;
  name: string | null;
  teamKey: string;
  startsAt: string;
  endsAt: string;
  isActive: boolean;
}
export interface TeamOption { key: string; rolloverBehavior: string }

const fmt = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
const label = (c: CycleOption) => `${c.teamKey} Cycle ${c.number}${c.name ? ` · ${c.name}` : ""}`;

async function call(path: string, init: RequestInit): Promise<string | null> {
  try {
    const res = await fetch(path, { ...init, headers: { "content-type": "application/json" } });
    if (res.ok) return null;
    const b = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
    return b?.error?.message ?? `server returned ${res.status}`;
  } catch {
    return "network unreachable";
  }
}

export function CycleBar({
  cycles, teams, selected, status, daysLabel, carryOver, rolloverTo,
}: {
  cycles: CycleOption[];
  teams: TeamOption[];
  selected: CycleOption | null;
  status: "active" | "upcoming" | "completed" | null;
  daysLabel: string;
  carryOver: number;
  rolloverTo: string;
}) {
  const router = useRouter();
  const picker = usePicker();
  const toast = useToast();
  const [creating, setCreating] = useState(false);
  const [teamKey, setTeamKey] = useState(teams[0]?.key ?? "");
  const [name, setName] = useState("");
  const today = new Date().toISOString().slice(0, 10);
  const [startsAt, setStartsAt] = useState(today);
  const [endsAt, setEndsAt] = useState(new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10));
  const [activate, setActivate] = useState(true);
  const [busy, setBusy] = useState(false);

  async function create(e: FormEvent) {
    e.preventDefault();
    if (!teamKey || busy) return;
    setBusy(true);
    const err = await call("/api/cycles", {
      method: "POST",
      body: JSON.stringify({ teamKey, ...(name.trim() ? { name: name.trim() } : {}), startsAt: new Date(`${startsAt}T00:00:00`).toISOString(), endsAt: new Date(`${endsAt}T23:59:00`).toISOString(), isActive: activate }),
    });
    setBusy(false);
    if (err) return toast.push({ error: true, message: `Cycle not created: ${err}` });
    toast.push({ message: "Cycle created" });
    setCreating(false);
    setName("");
    router.refresh();
  }

  const switcher = (anchor: HTMLElement) =>
    picker.open({
      anchor,
      title: "Switch cycle",
      options: [...cycles].reverse().map((c) => ({ id: c.id, label: `${label(c)}`, hint: c.isActive ? "active" : fmt(c.startsAt), checked: c.id === selected?.id })),
      onSelect: (id) => router.push(`/cycle?cycle=${id}`),
    });

  const menu = (anchor: HTMLElement) => {
    if (!selected) return;
    const c = selected;
    picker.open({
      anchor,
      title: "Cycle actions",
      options: [
        ...(!c.isActive ? [{ id: "activate", label: "Make active cycle" }] : []),
        { id: "delete", label: "Delete cycle (issues are unassigned)" },
      ],
      onSelect: (id) => {
        if (id === "activate") {
          void call(`/api/cycles/${c.id}`, { method: "PATCH", body: JSON.stringify({ isActive: true }) }).then((err) => {
            if (err) toast.push({ error: true, message: `Not activated: ${err}` });
            else { toast.push({ message: `${label(c)} is now the active cycle` }); router.refresh(); }
          });
        } else {
          toast.defer({
            message: `${label(c)} will be deleted`,
            commit: async ({ keepalive }) => {
              const err = await call(`/api/cycles/${c.id}`, { method: "DELETE", ...(keepalive ? { keepalive: true } : {}) });
              if (err) toast.push({ error: true, message: `Cycle not deleted: ${err}` });
              else router.replace("/cycle");
              router.refresh();
            },
          });
        }
      },
    });
  };

  const complete = () => {
    if (!selected) return;
    const c = selected;
    toast.defer({
      message: `${label(c)} will complete${carryOver ? `: ${carryOver} open ${carryOver === 1 ? "issue rolls" : "issues roll"} over to ${rolloverTo}` : ""}`,
      commit: async ({ keepalive }) => {
        const err = await call(`/api/cycles/${c.id}/complete`, { method: "POST", ...(keepalive ? { keepalive: true } : {}) });
        if (err) toast.push({ error: true, message: `Cycle not completed: ${err}` });
        router.refresh();
      },
    });
  };

  const btn = "h-8 rounded-sm border border-control px-2.5 text-[13px] text-ink-muted hover:bg-surface-2 hover:text-ink";
  return (
    <div className="border-b border-lining-faint">
      <div className="flex min-h-12 flex-wrap items-center gap-x-3 gap-y-1 px-4 py-1.5">
        <h1 className="text-[15px] font-semibold">Cycles</h1>
        {selected && (
          <>
            <button type="button" onClick={(e) => switcher(e.currentTarget)} aria-label={`Cycle: ${label(selected)}. Switch cycle`} className="flex h-8 items-center gap-1.5 rounded-sm px-2 text-[13px] text-ink hover:bg-surface-2">
              {label(selected)}<span aria-hidden className="text-ink-subtle">▾</span>
            </button>
            <span className="text-[12px] tabular-nums text-ink-subtle" suppressHydrationWarning>{fmt(selected.startsAt)} to {fmt(selected.endsAt)}</span>
            {status && (
              <span className={`inline-flex items-center gap-1 text-[12px] font-medium ${status === "active" ? "text-healthy" : "text-ink-muted"}`}>
                <span aria-hidden>{status === "active" ? "●" : status === "upcoming" ? "○" : "✓"}</span>
                {status === "active" ? "Active" : status === "upcoming" ? "Upcoming" : "Ended"} · {daysLabel}
              </span>
            )}
          </>
        )}
        <div className="ml-auto flex items-center gap-1.5">
          {selected && <button type="button" onClick={complete} className={btn}>Complete cycle</button>}
          {selected && <button type="button" aria-label="More cycle actions" onClick={(e) => menu(e.currentTarget)} className={btn}>More</button>}
          <button type="button" onClick={() => setCreating((c) => !c)} aria-expanded={creating} className="h-8 rounded-sm bg-accent px-2.5 text-[13px] font-medium text-on-accent hover:bg-accent-hover">New cycle</button>
        </div>
      </div>
      {creating && (
        <form onSubmit={create} className="flex flex-wrap items-end gap-3 border-t border-lining-faint px-4 py-3">
          <div>
            <span className="block text-[12px] text-ink-subtle">Team</span>
            <button type="button" aria-label={`Team: ${teamKey}. Change`} onClick={(e) => picker.open({ anchor: e.currentTarget, title: "Team", options: teams.map((t) => ({ id: t.key, label: t.key, checked: t.key === teamKey })), onSelect: setTeamKey })} className={`${btn} mt-1`}>{teamKey || "Choose"}</button>
          </div>
          <label className="block text-[12px] text-ink-subtle">Name (optional)<input value={name} onChange={(e) => setName(e.target.value)} className="mt-1 block h-8 w-44 rounded-sm border border-control bg-transparent px-2 text-[13px] text-ink" /></label>
          <label className="block text-[12px] text-ink-subtle">Starts<input type="date" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} className="mt-1 block h-8 rounded-sm border border-control bg-transparent px-2 text-[13px] text-ink" /></label>
          <label className="block text-[12px] text-ink-subtle">Ends<input type="date" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} className="mt-1 block h-8 rounded-sm border border-control bg-transparent px-2 text-[13px] text-ink" /></label>
          <label className="flex h-8 items-center gap-2 text-[13px] text-ink-muted"><input type="checkbox" checked={activate} onChange={(e) => setActivate(e.target.checked)} />Make active</label>
          <button type="submit" disabled={busy || !teamKey} className="h-8 rounded-sm bg-accent px-3 text-[13px] font-medium text-on-accent hover:bg-accent-hover disabled:opacity-50">Create cycle</button>
          <button type="button" onClick={() => setCreating(false)} className="h-8 rounded-sm px-2 text-[13px] text-ink-subtle hover:bg-surface-2">Cancel <Kbd>Esc</Kbd></button>
        </form>
      )}
    </div>
  );
}
