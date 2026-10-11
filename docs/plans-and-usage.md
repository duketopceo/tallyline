# Plans, limits and usage

Tallyline meters usage per workspace and can enforce plan limits on a hosted
install. Self-hosted installs are unlimited by default and send nothing anywhere.

## `BILLING` (default: off)

| `BILLING` | Effect |
|---|---|
| unset / `off` | Every workspace is `self_host_unlimited`. No limit is ever enforced. |
| `on` | `workspaces.plan` is read and the limits in `apps/api/src/plans.ts` apply. |

No billing provider is wired up yet (PLAN-060). Plans are set by hand:
`update workspaces set plan = 'team' where slug = '…'`. The `self_host_unlimited`
plan also works as a comp/override for a single workspace when `BILLING=on`.

## Plans

All numbers live in `apps/api/src/plans.ts`. `null` means unlimited.

| Plan | Workspaces per owner | Members | Agents | Agent runs / month (UTC) |
|---|---|---|---|---|
| `free` | 1 | 3 | 3 | 1,000 |
| `team` | unlimited | unlimited | unlimited | 25,000 |
| `self_host_unlimited` | unlimited | unlimited | unlimited | unlimited |

## Where limits are enforced

One function, `entitlements(workspaceId)`, and one assertion,
`assertWithinLimit(kind, …)`, in `apps/api/src/services/entitlements.ts`:

| Limit | Checked at |
|---|---|
| `seats` | invite create (members + live pending invites), invite accept, SSO joins |
| `agents` | agent create |
| `agent_keys` | agent key create, only while the workspace has more agents than its plan allows |
| `agent_runs` | dispatch create: assigning an issue to an agent, an `@agent` mention, review send-back. Refused before anything is written. |
| `workspaces` | workspace create (a new workspace starts on `free`) |

A refused request answers **402** with a machine-readable body:

```json
{
  "error": {
    "code": "PLAN_LIMIT",
    "message": "This workspace has all 3 agents included in the Free plan. Delete an agent you no longer use, or move to the Team plan.",
    "limit": "agents",
    "plan": "free",
    "max": 3,
    "used": 3
  }
}
```

Limits never delete or hide existing data.

## Usage metering

`usage_daily` holds one row per workspace per UTC day:

| Column | Source |
|---|---|
| `seats`, `agents` | end-of-day snapshot of `workspace_members` / `agents` |
| `agent_runs` | exact count of `dispatches` created that day |
| `api_calls` | in-process counter, incremented once an authenticated call passes the workspace gate, flushed every minute |
| `storage_bytes` | `pg_column_size` over issues, comments, events, run logs and webhook deliveries |

The rollup runs at boot and hourly (today and yesterday). Only counts are stored:
no content, no per-person rows, no third-party analytics.

`GET /v1/workspaces/{ws}/usage?days=30` (owner/admin) returns the plan, live
counters and the daily series; Settings > Usage renders it.
