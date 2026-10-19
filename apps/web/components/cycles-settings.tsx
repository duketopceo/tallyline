"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export interface CycleRow {
  id: string;
  number: number;
  name: string | null;
  startsAt: string;
  endsAt: string;
  isActive: boolean;
  teamId: string;
}

export interface TeamRow {
  id: string;
  key: string;
  name: string;
  cycleAutoEnabled?: boolean;
  cycleLengthDays?: number;
  cycleStartWeekday?: number;
  cycleUpcomingCount?: number;
  timezone?: string | null;
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function AutoSchedule({ team }: { team: TeamRow }) {
  const router = useRouter();
  const [enabled, setEnabled] = useState(team.cycleAutoEnabled ?? false);
  const [length, setLength] = useState(team.cycleLengthDays ?? 7);
  const [weekday, setWeekday] = useState(team.cycleStartWeekday ?? 1);
  const [ahead, setAhead] = useState(team.cycleUpcomingCount ?? 2);
  const [tz, setTz] = useState(team.timezone ?? "");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const field =
    "rounded-sm border border-control bg-surface-1 px-1.5 py-1 text-[12px] text-ink focus-visible:outline-2 focus-visible:outline-accent";

  async function save() {
    setBusy(true);
    setMsg(null);
    const res = await fetch(`/api/teams/${team.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        cycleAutoEnabled: enabled,
        cycleLengthDays: length,
        cycleStartWeekday: weekday,
        cycleUpcomingCount: ahead,
        timezone: tz.trim() === "" ? null : tz.trim(),
      }),
    });
    setBusy(false);
    if (res.ok) {
      setMsg("Saved");
      router.refresh();
    } else {
      setMsg(await err(res, "could not save"));
    }
  }

  return (
    <form
      className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <span className="w-10 font-mono text-[12px] text-ink">{team.key}</span>
      <label className="flex items-center gap-1.5 text-[12px] text-ink-subtle">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} className="accent-accent" />
        Auto-schedule
      </label>
      <label className="flex items-center gap-1.5 text-[12px] text-ink-subtle">
        Starts
        <select value={weekday} onChange={(e) => setWeekday(Number(e.target.value))} className={field}>
          {WEEKDAYS.map((w, i) => (
            <option key={w} value={i}>{w}</option>
          ))}
        </select>
      </label>
      <label className="flex items-center gap-1.5 text-[12px] text-ink-subtle">
        Days
        <input type="number" min={1} max={28} value={length} onChange={(e) => setLength(Number(e.target.value))} className={`${field} w-14`} />
      </label>
      <label className="flex items-center gap-1.5 text-[12px] text-ink-subtle">
        Upcoming
        <input type="number" min={1} max={6} value={ahead} onChange={(e) => setAhead(Number(e.target.value))} className={`${field} w-12`} />
      </label>
      <label className="flex items-center gap-1.5 text-[12px] text-ink-subtle">
        Timezone
        <input value={tz} onChange={(e) => setTz(e.target.value)} placeholder="UTC" maxLength={64} className={`${field} w-40 font-mono`} />
      </label>
      <button type="submit" disabled={busy} className="rounded-sm bg-accent px-3 py-1 text-[12px] font-medium text-on-accent disabled:opacity-50">
        Save
      </button>
      {msg && <span role="status" className="text-[12px] text-ink-subtle">{msg}</span>}
    </form>
  );
}

const day = (d: string) => d.slice(0, 10);

async function err(res: Response, fallback: string) {
  const d = (await res.json().catch(() => null)) as {
    error?: { message?: string };
  } | null;
  return d?.error?.message ?? fallback;
}

export function CyclesSettings({
  cycles,
  teams,
}: {
  cycles: CycleRow[];
  teams: TeamRow[];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [teamKey, setTeamKey] = useState(teams[0]?.key ?? "");
  const [name, setName] = useState("");
  const [startsAt, setStartsAt] = useState("");
  const [endsAt, setEndsAt] = useState("");
  const [active, setActive] = useState(false);
  const teamName = (id: string) => teams.find((t) => t.id === id)?.key ?? "?";

  async function run(
    path: string,
    init: RequestInit,
    fallback: string,
    busyKey = "form",
  ) {
    setBusy(busyKey);
    setError(null);
    const res = await fetch(path, init);
    setBusy(null);
    if (res.ok) {
      router.refresh();
      return true;
    }
    setError(await err(res, fallback));
    return false;
  }

  async function create() {
    const ok = await run(
      "/api/cycles",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          teamKey,
          ...(name.trim() ? { name: name.trim() } : {}),
          startsAt: new Date(startsAt).toISOString(),
          endsAt: new Date(endsAt).toISOString(),
          isActive: active,
        }),
      },
      "could not create cycle",
    );
    if (ok) {
      setName("");
      setStartsAt("");
      setEndsAt("");
      setActive(false);
    }
  }

  async function patch(c: CycleRow, body: Record<string, unknown>) {
    await run(
      `/api/cycles/${c.id}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
      "could not update cycle",
      c.id,
    );
  }

  return (
    <div className="mx-auto w-full max-w-2xl p-4">
      {error && (
        <p
          role="alert"
          className="mb-3 rounded-sm border border-lining-bright px-3 py-2 text-sm text-ink-muted"
        >
          {error}
        </p>
      )}

      <section aria-label="Weekly auto-schedule" className="mb-4">
        <h2 className="mb-1 text-[13px] font-semibold text-ink">Weekly auto-schedule</h2>
        <p className="mb-2 text-[12px] text-ink-subtle">
          Keeps the current cycle and the next few ready, starting at local midnight in the timezone below (UTC when empty).
        </p>
        <div className="divide-y divide-lining-faint rounded-sm border border-lining">
          {teams.map((t) => (
            <AutoSchedule key={`${t.id}:${t.cycleAutoEnabled}:${t.cycleLengthDays}:${t.cycleStartWeekday}:${t.cycleUpcomingCount}:${t.timezone}`} team={t} />
          ))}
        </div>
      </section>

      <form
        className="mb-4 flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
      >
        {teams.length > 1 && (
          <select
            value={teamKey}
            onChange={(e) => setTeamKey(e.target.value)}
            aria-label="Team"
            className="rounded-sm border border-control bg-surface-1 px-1.5 py-1.5 font-mono text-[12px] text-ink focus-visible:outline-2 focus-visible:outline-accent"
          >
            {teams.map((t) => (
              <option key={t.id} value={t.key}>
                {t.key}
              </option>
            ))}
          </select>
        )}
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Name (optional)"
          maxLength={120}
          className="min-w-0 flex-1 basis-36 rounded-sm border border-control bg-surface-1 px-2 py-1.5 text-[13px] text-ink placeholder:text-ink-disabled focus-visible:outline-2 focus-visible:outline-accent"
        />
        <input
          type="date"
          value={startsAt}
          onChange={(e) => setStartsAt(e.target.value)}
          required
          aria-label="Starts on"
          className="rounded-sm border border-control bg-surface-1 px-2 py-1.5 font-mono text-[12px] text-ink focus-visible:outline-2 focus-visible:outline-accent"
        />
        <input
          type="date"
          value={endsAt}
          onChange={(e) => setEndsAt(e.target.value)}
          required
          aria-label="Ends on"
          className="rounded-sm border border-control bg-surface-1 px-2 py-1.5 font-mono text-[12px] text-ink focus-visible:outline-2 focus-visible:outline-accent"
        />
        <label className="flex items-center gap-1.5 font-mono text-[11px] text-ink-subtle">
          <input
            type="checkbox"
            checked={active}
            onChange={(e) => setActive(e.target.checked)}
            className="accent-accent"
          />
          active
        </label>
        <button
          type="submit"
          disabled={busy === "form" || !teamKey || !startsAt || !endsAt}
          className="rounded-sm bg-accent px-3 py-1.5 text-[13px] font-medium text-on-accent disabled:opacity-50"
        >
          Add cycle
        </button>
      </form>

      {cycles.length === 0 ? (
        <p className="py-8 text-center text-sm text-ink-subtle">
          No cycles yet. A cycle is a dated work window per team — the Cycle
          view (<kbd className="font-mono">g c</kbd>) scopes issues to it.
        </p>
      ) : (
        <ul className="divide-y divide-lining-faint rounded-sm border border-lining">
          {cycles.map((c) => (
            <li key={c.id} className="flex items-center gap-3 px-3 py-2">
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] text-ink">
                  {teamName(c.teamId)} #{c.number}
                  {c.name ? ` — ${c.name}` : ""}
                </span>
                <span className="block font-mono text-[11px] text-ink-tertiary">
                  {day(c.startsAt)} → {day(c.endsAt)}
                </span>
              </span>
              {c.isActive && (
                <span className="rounded-full border border-accent px-2 py-0.5 font-mono text-[11px] text-accent">
                  active
                </span>
              )}
              {!c.isActive && (
                <button
                  type="button"
                  onClick={() => void patch(c, { isActive: true })}
                  disabled={busy === c.id}
                  className="font-mono text-[11px] text-ink-subtle hover:text-ink disabled:opacity-50"
                >
                  activate
                </button>
              )}
              <button
                type="button"
                onClick={() =>
                  void run(
                    `/api/cycles/${c.id}/complete`,
                    { method: "POST" },
                    "could not complete cycle",
                    c.id,
                  )
                }
                disabled={busy === c.id}
                className="font-mono text-[11px] text-ink-subtle hover:text-ink disabled:opacity-50"
              >
                complete
              </button>
              <button
                type="button"
                onClick={() =>
                  void run(
                    `/api/cycles/${c.id}`,
                    { method: "DELETE" },
                    "could not delete cycle",
                    c.id,
                  )
                }
                disabled={busy === c.id}
                className="font-mono text-[11px] text-ink-subtle hover:text-danger disabled:opacity-50"
              >
                delete
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
