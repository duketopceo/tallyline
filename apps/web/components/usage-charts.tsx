"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { AXIS, Panel, TIP } from "./insights-charts";

export interface UsageDay {
  day: string;
  seats: number;
  agents: number;
  agentRuns: number;
  apiCalls: number;
  storageBytes: number;
}

const MARGIN = { top: 4, right: 8, left: -18, bottom: 0 };

/** "2026-10-11" -> "Oct 11" (UTC, so the label is the metered day) */
function shortDay(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

export function UsageCharts({ daily }: { daily: UsageDay[] }) {
  const data = daily.map((d) => ({ ...d, label: shortDay(d.day), storageMb: d.storageBytes / 1_048_576 }));
  const runs = daily.reduce((s, d) => s + d.agentRuns, 0);
  const calls = daily.reduce((s, d) => s + d.apiCalls, 0);

  return (
    <div className="grid grid-cols-1 gap-px lg:grid-cols-2">
      <Panel title="Agent runs" hint={`${runs.toLocaleString("en-US")} in ${daily.length} days`}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={MARGIN} accessibilityLayer>
            <CartesianGrid stroke="var(--sl-lining-faint)" vertical={false} />
            <XAxis dataKey="label" tick={AXIS} tickLine={false} axisLine={false} minTickGap={16} />
            <YAxis tick={AXIS} tickLine={false} axisLine={false} allowDecimals={false} />
            <Tooltip {...TIP} />
            <Bar dataKey="agentRuns" name="agent runs" fill="var(--sl-accent)" radius={[2, 2, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </Panel>

      <Panel title="API calls" hint={`${calls.toLocaleString("en-US")} in ${daily.length} days`}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={MARGIN} accessibilityLayer>
            <CartesianGrid stroke="var(--sl-lining-faint)" vertical={false} />
            <XAxis dataKey="label" tick={AXIS} tickLine={false} axisLine={false} minTickGap={16} />
            <YAxis tick={AXIS} tickLine={false} axisLine={false} allowDecimals={false} />
            <Tooltip {...TIP} />
            <Bar dataKey="apiCalls" name="API calls" fill="var(--sl-ink-muted)" radius={[2, 2, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </Panel>

      <Panel title="Members and agents" hint="end-of-day count">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={MARGIN} accessibilityLayer>
            <CartesianGrid stroke="var(--sl-lining-faint)" vertical={false} />
            <XAxis dataKey="label" tick={AXIS} tickLine={false} axisLine={false} minTickGap={16} />
            <YAxis tick={AXIS} tickLine={false} axisLine={false} allowDecimals={false} />
            <Tooltip {...TIP} />
            <Legend wrapperStyle={{ fontSize: 11, fontFamily: "monospace" }} />
            <Line type="stepAfter" dataKey="seats" name="members" stroke="var(--sl-ink-muted)" dot={false} strokeWidth={1.5} />
            <Line type="stepAfter" dataKey="agents" name="agents" stroke="var(--sl-accent)" dot={false} strokeWidth={1.5} />
          </LineChart>
        </ResponsiveContainer>
      </Panel>

      <Panel title="Storage" hint="issues, comments, activity and run logs">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={MARGIN} accessibilityLayer>
            <CartesianGrid stroke="var(--sl-lining-faint)" vertical={false} />
            <XAxis dataKey="label" tick={AXIS} tickLine={false} axisLine={false} minTickGap={16} />
            <YAxis tick={AXIS} tickLine={false} axisLine={false} unit=" MB" />
            <Tooltip {...TIP} formatter={(v) => [`${Number(v).toFixed(2)} MB`, "storage"]} />
            <Line type="monotone" dataKey="storageMb" name="storage" stroke="var(--sl-lining-strong)" dot={false} strokeWidth={1.5} />
          </LineChart>
        </ResponsiveContainer>
      </Panel>
    </div>
  );
}
