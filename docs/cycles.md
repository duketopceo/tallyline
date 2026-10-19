# Cycles

A cycle is a dated work window for one team. Open issues roll into the team's
next cycle (or the backlog) when a cycle completes.

## Weekly auto-schedule

Off by default. Turn it on per team in Settings > Cycles, or with
`PATCH /v1/workspaces/{ws}/teams/{id}`:

| Field | Default | Meaning |
|---|---|---|
| `cycleAutoEnabled` | `false` | Create cycles without manual setup |
| `cycleLengthDays` | `7` | 1 to 28 |
| `cycleStartWeekday` | `1` | 0 = Sunday, 1 = Monday |
| `cycleUpcomingCount` | `2` | Future cycles kept ready, 1 to 6 |
| `timezone` | `null` (UTC) | IANA zone; boundaries are local midnight, DST-safe |

The API process checks every minute, right after the expired-cycle sweep: it
creates the cycle covering today if missing, tops up the upcoming ones, and
marks the current cycle active when the team has no active one. A second check
adds nothing. After downtime it resumes at the current week; it never creates
past cycles.

Plan the next cycle from the Cycle page ("Plan next cycle") or with the MCP
tools `create_cycle` and `assign_cycle`.
