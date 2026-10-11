"use client";

import { useState } from "react";
import { Glint } from "@/components/app/ui";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

export interface Insights {
  cycleTime: {
    avgDays: number;
    p50Days: number;
    p90Days: number;
    completed: number;
    weekly: { week: string; avgDays: number; count: number }[];
  };
  burnup: { week: string; total: number; done: number }[];
  velocity: {
    team: string;
    cycle: string;
    done: number;
    issueCount: number;
    estimateDone: number;
    estimateTotal: number;
  }[];
  throughput: { week: string; human: number; agent: number; system: number }[];
}

const AXIS = { fontSize: 11, fill: "var(--sl-ink-subtle)" };
const TIP = {
  contentStyle: {
    background: "var(--sl-surface-3)",
    border: "1px solid var(--sl-lining-strong)",
    borderRadius: 6,
    fontSize: 12,
    color: "var(--sl-ink)",
  },
  labelStyle: { color: "var(--sl-ink-subtle)" },
  itemStyle: { color: "var(--sl-ink)" },
  cursor: { fill: "var(--sl-surface-2)" },
} as const;

// durations read as minutes, hours or days, never as raw floats
export function fmtDays(d: number): string {
  if (!Number.isFinite(d) || d <= 0) return "0m";
  if (d < 1 / 1440) return "<1m";
  if (d < 1 / 24) return `${Math.round(d * 1440)}m`;
  if (d < 1) return `${(d * 24).toFixed(1)}h`;
  return `${d.toFixed(1)}d`;
}

function Panel({
  title,
  hint,
  rows,
  columns,
  empty,
  summary,
  children,
}: {
  title: string;
  hint?: string | undefined;
  rows: Record<string, string | number>[];
  columns: { key: string; label: string }[];
  empty?: string;
  summary: string;
  children: React.ReactNode;
}) {
  const [table, setTable] = useState(false);
  return (
    <section aria-label={title} className="flex min-h-0 flex-col border-b border-lining-faint p-4">
      <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="text-[13px] font-semibold text-ink">{title}</h2>
        {hint && <span className="text-[12px] tabular-nums text-ink-subtle">{hint}</span>}
        {!empty && (
          <button type="button" aria-pressed={table} onClick={() => setTable((t) => !t)} className="ml-auto h-6 rounded-xs px-2 text-[12px] text-ink-subtle hover:bg-surface-2 hover:text-ink">
            {table ? "Show chart" : "Show table"}
          </button>
        )}
      </div>
      {empty ? (
        <p className="flex min-h-36 flex-1 items-center justify-center text-center text-[13px] text-ink-subtle">{empty}</p>
      ) : table ? (
        <div className="scroll-quiet min-h-36 flex-1 overflow-auto">
          <table className="w-full text-left text-[12px]">
            <caption className="sr-only">{title}</caption>
            <thead><tr>{columns.map((c) => <th key={c.key} scope="col" className="border-b border-lining px-2 py-1 font-medium text-ink-subtle">{c.label}</th>)}</tr></thead>
            <tbody>{rows.map((r, i) => <tr key={i} className="border-b border-lining-faint">{columns.map((c) => <td key={c.key} className="px-2 py-1 tabular-nums text-ink-muted">{r[c.key]}</td>)}</tr>)}</tbody>
          </table>
        </div>
      ) : (
        <figure role="img" aria-label={summary} className="m-0 min-h-36 flex-1">{children}</figure>
      )}
    </section>
  );
}

function Stat({ label, value, sub, glint }: { label: string; value: string; sub?: string | undefined; glint?: boolean }) {
  return (
    <div className="rounded-md border border-lining bg-surface-1 px-4 py-3">
      <p className="flex items-center gap-1.5 text-[12px] text-ink-subtle">{glint && <Glint size={12} label="" />}{label}</p>
      <p className="mt-1 text-[24px] font-semibold leading-none tracking-[-0.4px] tabular-nums text-ink">{value}</p>
      {sub && <p className="mt-1 text-[12px] text-ink-subtle">{sub}</p>}
    </div>
  );
}

function Legend2({ items }: { items: { label: string; color: string; glint?: boolean }[] }) {
  return (
    <ul className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-ink-muted" aria-label="Legend">
      {items.map((i) => (
        <li key={i.label} className="flex items-center gap-1.5">
          {i.glint ? <Glint size={12} label="" /> : <span aria-hidden className="h-2.5 w-2.5 rounded-xs" style={{ background: i.color }} />}
          {i.label}
        </li>
      ))}
    </ul>
  );
}

export function InsightsClient({ insights }: { insights: Insights }) {
  const { cycleTime, burnup, velocity, throughput } = insights;
  const empty = cycleTime.completed === 0 && burnup.length === 0 && velocity.length === 0;

  if (empty) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center px-8 py-12 text-center">
        <p className="text-[14px] font-medium text-ink">No activity yet</p>
        <p className="mt-1 max-w-sm text-[13px] text-ink-subtle">Cycle time, burnup and throughput appear once issues move through the board. Move one issue to Done to see the first data point.</p>
      </div>
    );
  }
  const totals = throughput.reduce((a, w) => ({ h: a.h + w.human, g: a.g + w.agent, s: a.s + w.system }), { h: 0, g: 0, s: 0 });
  const all = totals.h + totals.g + totals.s;
  const agentShare = all ? Math.round((totals.g / all) * 100) : 0;
  const lastBurn = burnup.at(-1);

  return (
    <div className="scroll-quiet min-h-0 flex-1 overflow-y-auto">
      <div className="grid grid-cols-2 gap-3 p-4 lg:grid-cols-4">
        <Stat label="Median cycle time" value={fmtDays(cycleTime.p50Days)} sub={`p90 ${fmtDays(cycleTime.p90Days)}`} />
        <Stat label="Issues done" value={String(lastBurn?.done ?? cycleTime.completed)} sub={lastBurn ? `of ${lastBurn.total} created` : undefined} />
        <Stat label="Finished by agents" value={`${agentShare}%`} sub={`${totals.g} of ${all} done events`} glint />
        <Stat label="Completed cycles" value={String(velocity.length)} />
      </div>
      <div className="grid grid-cols-1 gap-px lg:grid-cols-2">
        <Panel
          title="Cycle time"
          hint={`${cycleTime.completed} done · avg ${fmtDays(cycleTime.avgDays)} · p50 ${fmtDays(cycleTime.p50Days)} · p90 ${fmtDays(cycleTime.p90Days)}`}
          summary={`Average cycle time per week, ${cycleTime.weekly.length} weeks`}
          columns={[{ key: "week", label: "Week" }, { key: "avg", label: "Average" }, { key: "count", label: "Issues" }]}
          rows={cycleTime.weekly.map((w) => ({ week: w.week, avg: fmtDays(w.avgDays), count: w.count }))}
          {...(cycleTime.weekly.length === 0 ? { empty: "No finished issues yet. Cycle time runs from In progress to Done." } : {})}
        >
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={cycleTime.weekly} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid stroke="var(--sl-lining-faint)" vertical={false} />
              <XAxis dataKey="week" tick={AXIS} tickLine={false} axisLine={false} />
              <YAxis tick={AXIS} tickLine={false} axisLine={false} width={44} tickFormatter={(v: number) => fmtDays(v)} />
              <Tooltip {...TIP} formatter={(v) => fmtDays(Number(v))} />
              <Bar dataKey="avgDays" name="Average cycle time" fill="var(--sl-ink-muted)" radius={[2, 2, 0, 0]} maxBarSize={40} />
            </BarChart>
          </ResponsiveContainer>
        </Panel>

        <Panel
          title="Burnup"
          hint="weekly cumulative, created vs done"
          summary={`Burnup over ${burnup.length} weeks`}
          columns={[{ key: "week", label: "Week" }, { key: "total", label: "Created" }, { key: "done", label: "Done" }]}
          rows={burnup.map((b) => ({ week: b.week, total: b.total, done: b.done }))}
          {...(burnup.length === 0 ? { empty: "Nothing created yet." } : {})}
        >
          <div className="flex h-full flex-col">
            <div className="min-h-0 flex-1">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={burnup} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid stroke="var(--sl-lining-faint)" vertical={false} />
                  <XAxis dataKey="week" tick={AXIS} tickLine={false} axisLine={false} />
                  <YAxis tick={AXIS} tickLine={false} axisLine={false} allowDecimals={false} width={36} />
                  <Tooltip {...TIP} />
                  <Line type="monotone" dataKey="total" name="Created" stroke="var(--sl-ink-subtle)" dot={{ r: 3 }} strokeWidth={1.5} />
                  <Line type="monotone" dataKey="done" name="Done" stroke="var(--sl-status-healthy)" dot={{ r: 3 }} strokeWidth={2} />
                </LineChart>
              </ResponsiveContainer>
            </div>
            <Legend2 items={[{ label: "Created", color: "var(--sl-ink-subtle)" }, { label: "Done", color: "var(--sl-status-healthy)" }]} />
          </div>
        </Panel>

        <Panel
          title="Throughput"
          hint="issues done per week, humans and agents"
          summary={`Issues done per week by actor, ${throughput.length} weeks`}
          columns={[{ key: "week", label: "Week" }, { key: "human", label: "Humans" }, { key: "agent", label: "Agents" }, { key: "system", label: "System" }]}
          rows={throughput.map((t) => ({ week: t.week, human: t.human, agent: t.agent, system: t.system }))}
          {...(throughput.length === 0 ? { empty: "No issues done yet." } : {})}
        >
          <div className="flex h-full flex-col">
            <div className="min-h-0 flex-1">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={throughput} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid stroke="var(--sl-lining-faint)" vertical={false} />
                  <XAxis dataKey="week" tick={AXIS} tickLine={false} axisLine={false} />
                  <YAxis tick={AXIS} tickLine={false} axisLine={false} allowDecimals={false} width={36} />
                  <Tooltip {...TIP} />
                  <Bar dataKey="human" name="Humans" stackId="a" fill="var(--sl-ink-muted)" maxBarSize={48} />
                  <Bar dataKey="agent" name="Agents" stackId="a" fill="var(--sl-glint)" maxBarSize={48} />
                  <Bar dataKey="system" name="System" stackId="a" fill="var(--sl-lining-strong)" radius={[2, 2, 0, 0]} maxBarSize={48} />
                </BarChart>
              </ResponsiveContainer>
            </div>
            <Legend2 items={[{ label: "Humans", color: "var(--sl-ink-muted)" }, { label: "Agents (glint)", color: "var(--sl-glint)", glint: true }, { label: "System", color: "var(--sl-lining-strong)" }]} />
          </div>
        </Panel>

        <Panel
          title="Velocity"
          hint={velocity.length ? `${velocity.length} completed cycles` : undefined}
          summary={`Issues and estimate completed per cycle, ${velocity.length} cycles`}
          columns={[{ key: "cycle", label: "Cycle" }, { key: "done", label: "Issues done" }, { key: "estimateDone", label: "Estimate done" }]}
          rows={velocity.map((v) => ({ cycle: v.cycle, done: v.done, estimateDone: v.estimateDone }))}
          {...(velocity.length === 0 ? { empty: "No completed cycles yet. Complete a cycle to see velocity." } : {})}
        >
          <div className="flex h-full flex-col">
            <div className="min-h-0 flex-1">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={velocity} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid stroke="var(--sl-lining-faint)" vertical={false} />
                  <XAxis dataKey="cycle" tick={AXIS} tickLine={false} axisLine={false} />
                  <YAxis tick={AXIS} tickLine={false} axisLine={false} allowDecimals={false} width={36} />
                  <Tooltip {...TIP} />
                  <Bar dataKey="done" name="Issues done" fill="var(--sl-status-healthy)" radius={[2, 2, 0, 0]} maxBarSize={40} />
                  <Bar dataKey="estimateDone" name="Estimate done" fill="var(--sl-ink-subtle)" radius={[2, 2, 0, 0]} maxBarSize={40} />
                </BarChart>
              </ResponsiveContainer>
            </div>
            <Legend2 items={[{ label: "Issues done", color: "var(--sl-status-healthy)" }, { label: "Estimate done", color: "var(--sl-ink-subtle)" }]} />
          </div>
        </Panel>
      </div>
    </div>
  );
}
