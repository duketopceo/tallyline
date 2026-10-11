import { api, type Me } from "@/lib/api";
import { formatBytes } from "@/lib/format-bytes";
import { SettingsTabs } from "@/components/settings-tabs";
import { UsageLoader } from "@/components/usage-loader";
import type { UsageDay } from "@/components/usage-charts";

interface UsageReport {
  plan: {
    plan: "free" | "team" | "self_host_unlimited";
    planLabel: string;
    enforced: boolean;
    limits: {
      maxWorkspaces: number | null;
      maxSeats: number | null;
      maxAgents: number | null;
      agentRunsPerMonth: number | null;
    };
  };
  current: {
    seats: number;
    pendingInvites: number;
    agents: number;
    agentRunsThisMonth: number;
    apiCallsToday: number;
    storageBytes: number;
  };
  daily: UsageDay[];
  from: string;
  to: string;
}

const num = (n: number) => n.toLocaleString("en-US");

type Level = "ok" | "near" | "at";

function levelOf(used: number, max: number | null): Level {
  if (max === null) return "ok";
  if (used >= max) return "at";
  return used / max >= 0.8 ? "near" : "ok";
}

// status is never color alone: shape + label + color (Silver Lining §5)
function LimitBadge({ level }: { level: Level }) {
  if (level === "ok") return null;
  const at = level === "at";
  return (
    <span
      className={`inline-flex h-5 items-center gap-1 rounded-xs px-1.5 font-mono text-[11px] ${
        at ? "bg-urgent-soft text-ink" : "bg-attention-soft text-ink"
      }`}
    >
      <svg aria-hidden width="10" height="10" viewBox="0 0 10 10">
        {at ? (
          <rect x="1" y="1" width="8" height="8" rx="1" fill="var(--sl-status-urgent)" />
        ) : (
          <path d="M5 1 9 9H1Z" fill="var(--sl-status-attention)" />
        )}
      </svg>
      {at ? "Limit reached" : "Nearing limit"}
    </span>
  );
}

function Stat({
  label,
  value,
  used,
  max,
  detail,
}: {
  label: string;
  value: string;
  used?: number;
  max?: number | null;
  detail?: string;
}) {
  const level = used !== undefined && max !== undefined ? levelOf(used, max) : "ok";
  const pct = max ? Math.min(100, Math.round(((used ?? 0) / max) * 100)) : null;
  return (
    <div className="flex min-w-0 flex-col gap-1 border-b border-lining-faint p-4 sm:border-r">
      <div className="flex items-center gap-2">
        <h2 className="text-xs text-ink-subtle">{label}</h2>
        <LimitBadge level={level} />
      </div>
      <p className="font-mono text-[17px] text-ink tabular-nums">
        {value}
        {max ? <span className="text-[13px] text-ink-subtle"> of {num(max)}</span> : null}
      </p>
      {pct !== null && (
        <div
          role="meter"
          aria-label={`${label} used`}
          aria-valuemin={0}
          aria-valuemax={max ?? undefined}
          aria-valuenow={used}
          aria-valuetext={`${num(used ?? 0)} of ${num(max!)}`}
          className="h-1 w-full rounded-full bg-surface-3"
        >
          <div
            className={`h-1 rounded-full ${
              level === "at" ? "bg-urgent" : level === "near" ? "bg-attention" : "bg-lining-strong"
            }`}
            style={{ width: `${pct}%` }}
          />
        </div>
      )}
      {detail && <p className="text-[11px] text-ink-tertiary">{detail}</p>}
    </div>
  );
}

export default async function UsagePage() {
  const me = await api<Me>("/v1/auth/me");
  if (!me.data) return <main className="p-8 text-sm text-ink-subtle">Not signed in.</main>;
  const res = await api<UsageReport>(`/v1/workspaces/${me.data.workspaceSlug}/usage?days=30`);
  const u = res.data;

  return (
    <main className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-lining-faint px-4">
        <h1 className="text-sm font-semibold">Usage</h1>
        <SettingsTabs />
        {u && (
          <span className="ml-auto hidden font-mono text-[11px] text-ink-tertiary sm:inline">
            last 30 days · UTC
          </span>
        )}
      </header>

      {!u ? (
        <p className="p-4 text-sm text-ink-subtle">
          {res.status === 403
            ? "Usage is visible to workspace owners and admins. Ask one of them for the numbers."
            : "Usage could not be loaded. Refresh the page to try again."}
        </p>
      ) : (
        <>
          <section aria-labelledby="plan-heading" className="border-b border-lining-faint px-4 py-3">
            <h2 id="plan-heading" className="text-[13px] font-medium text-ink">
              {u.plan.planLabel} plan
            </h2>
            <p className="mt-1 max-w-[72ch] text-[13px] text-ink-subtle">
              {u.plan.enforced
                ? "Limits apply to this workspace. When one is reached, Tallyline refuses the action and says which limit it hit; nothing already in the workspace is touched."
                : "Billing is off on this instance, so nothing is limited. These numbers are for your own planning."}
            </p>
          </section>

          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-5">
            <Stat
              label="Members"
              value={num(u.current.seats)}
              used={u.current.seats + u.current.pendingInvites}
              max={u.plan.limits.maxSeats}
              detail={
                u.current.pendingInvites > 0
                  ? `${num(u.current.pendingInvites)} pending invite${u.current.pendingInvites === 1 ? "" : "s"} hold a seat`
                  : "people only; agents never take a seat"
              }
            />
            <Stat label="Agents" value={num(u.current.agents)} used={u.current.agents} max={u.plan.limits.maxAgents} />
            <Stat
              label="Agent runs this month"
              value={num(u.current.agentRunsThisMonth)}
              used={u.current.agentRunsThisMonth}
              max={u.plan.limits.agentRunsPerMonth}
              detail="each dispatch to an agent is one run"
            />
            <Stat label="API calls today" value={num(u.current.apiCallsToday)} detail="not limited" />
            <Stat label="Storage" value={formatBytes(u.current.storageBytes)} detail="not limited" />
          </div>

          <UsageLoader daily={u.daily} />
        </>
      )}
    </main>
  );
}
