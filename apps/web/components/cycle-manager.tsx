"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";

export interface ManagerCycle {
  id: string;
  number: number;
  name: string | null;
  teamKey: string;
  startsAt: string;
  endsAt: string;
  isActive: boolean;
}

export interface ManagerTeam {
  key: string;
  rolloverBehavior: string;
}

function fmt(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

function toLocalInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function CycleManager({
  cycles,
  teams,
  selectedId,
}: {
  cycles: ManagerCycle[];
  teams: ManagerTeam[];
  selectedId: string | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [teamKey, setTeamKey] = useState(teams[0]?.key ?? "");
  const [name, setName] = useState("");
  const [startsAt, setStartsAt] = useState(toLocalInput(new Date()));
  const [endsAt, setEndsAt] = useState(
    toLocalInput(new Date(Date.now() + 14 * 86_400_000)),
  );
  const [activate, setActivate] = useState(true);

  async function call(path: string, init: RequestInit, tag: string) {
    setBusy(tag);
    setError(null);
    try {
      const res = await fetch(path, {
        ...init,
        headers: { "content-type": "application/json" },
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        setError(body?.error?.message ?? `request failed (${res.status})`);
        return false;
      }
      router.refresh();
      return true;
    } catch {
      setError("network error");
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!teamKey || busy) return;
    const ok = await call(
      "/api/cycles",
      {
        method: "POST",
        body: JSON.stringify({
          teamKey,
          ...(name.trim() ? { name: name.trim() } : {}),
          startsAt: new Date(startsAt).toISOString(),
          endsAt: new Date(endsAt).toISOString(),
          isActive: activate,
        }),
      },
      "create",
    );
    if (ok) setName("");
  }

  return (
    <section className="border-t border-lining-faint">
      <h2 className="px-4 pt-3 font-mono text-[11px] uppercase tracking-wider text-ink-tertiary">
        All cycles
      </h2>
      <ul className="px-2 py-2">
        {cycles.map((c) => (
          <li
            key={c.id}
            className={`flex h-9 items-center gap-3 rounded-sm px-2 text-[13px] ${
              c.id === selectedId
                ? "bg-surface-2 text-ink"
                : "text-ink-muted hover:bg-surface-1"
            }`}
          >
            <Link
              href={`/cycle?cycle=${c.id}`}
              className="flex min-w-0 flex-1 items-center gap-2"
            >
              <span className="font-mono text-xs text-ink-tertiary">
                {c.teamKey} · C{c.number}
              </span>
              <span className="truncate">
                {c.name ?? ""}
              </span>
              <span className="font-mono text-[11px] text-ink-tertiary">
                {fmt(c.startsAt)} → {fmt(c.endsAt)}
              </span>
            </Link>
            {c.isActive ? (
              <span className="rounded-full bg-healthy/15 px-2 py-0.5 font-mono text-[11px] text-healthy">
                active
              </span>
            ) : (
              <button
                type="button"
                disabled={busy !== null}
                onClick={() =>
                  void call(
                    `/api/cycles/${c.id}`,
                    {
                      method: "PATCH",
                      body: JSON.stringify({ isActive: true }),
                    },
                    c.id,
                  )
                }
                className="rounded-sm border border-control px-2 py-0.5 font-mono text-[11px] text-ink-subtle hover:border-accent hover:text-accent disabled:opacity-50"
              >
                {busy === c.id ? "…" : "activate"}
              </button>
            )}
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => {
                if (
                  window.confirm(
                    `Complete Cycle ${c.number}? Open issues roll over per team policy.`,
                  )
                ) {
                  void call(
                    `/api/cycles/${c.id}/complete`,
                    { method: "POST" },
                    c.id,
                  );
                }
              }}
              className="rounded-sm border border-control px-2 py-0.5 font-mono text-[11px] text-ink-subtle hover:border-accent hover:text-accent disabled:opacity-50"
            >
              complete
            </button>
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => {
                if (
                  window.confirm(
                    `Delete Cycle ${c.number}? Issues are unassigned from it.`,
                  )
                ) {
                  void call(`/api/cycles/${c.id}`, { method: "DELETE" }, c.id);
                }
              }}
              className="rounded-sm border border-control px-2 py-0.5 font-mono text-[11px] text-ink-subtle hover:border-urgent hover:text-urgent disabled:opacity-50"
            >
              delete
            </button>
          </li>
        ))}
        {cycles.length === 0 && (
          <li className="px-2 py-1 text-[13px] text-ink-tertiary">
            No cycles yet.
          </li>
        )}
      </ul>

      <form
        onSubmit={submit}
        className="flex flex-wrap items-center gap-2 border-t border-lining-faint px-4 py-3"
      >
        <select
          aria-label="Team"
          value={teamKey}
          onChange={(e) => setTeamKey(e.target.value)}
          className="h-7 rounded-sm border border-control bg-surface-2 px-1.5 font-mono text-[11px] text-ink-muted"
        >
          {teams.map((t) => (
            <option key={t.key} value={t.key}>
              {t.key}
            </option>
          ))}
        </select>
        <input
          aria-label="Cycle name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="name (optional)"
          className="h-7 w-32 rounded-sm border border-control bg-surface-2 px-2 text-[12px] text-ink placeholder:text-ink-tertiary focus:border-accent focus:outline-none"
        />
        <input
          type="datetime-local"
          aria-label="Cycle start"
          value={startsAt}
          onChange={(e) => setStartsAt(e.target.value)}
          className="h-7 rounded-sm border border-control bg-surface-2 px-1.5 font-mono text-[11px] text-ink-muted"
        />
        <span className="font-mono text-[11px] text-ink-tertiary">→</span>
        <input
          type="datetime-local"
          aria-label="Cycle end"
          value={endsAt}
          onChange={(e) => setEndsAt(e.target.value)}
          className="h-7 rounded-sm border border-control bg-surface-2 px-1.5 font-mono text-[11px] text-ink-muted"
        />
        <label className="flex items-center gap-1 font-mono text-[11px] text-ink-tertiary">
          <input
            type="checkbox"
            checked={activate}
            onChange={(e) => setActivate(e.target.checked)}
          />
          activate
        </label>
        <button
          type="submit"
          disabled={busy !== null || !teamKey}
          className="h-7 rounded-sm bg-accent px-3 text-[12px] font-medium text-on-accent hover:bg-accent-hover disabled:opacity-50"
        >
          {busy === "create" ? "…" : "New cycle"}
        </button>
        {error && (
          <span className="text-[11px] text-urgent" role="alert">
            {error}
          </span>
        )}
      </form>
    </section>
  );
}
