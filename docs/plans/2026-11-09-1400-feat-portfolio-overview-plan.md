---
title: Portfolio / client overview page - Plan
type: feat
date: 2026-11-09
artifact_contract: ce-unified-plan/v1
product_contract_source: session-settled
execution: code
---

# Portfolio / client overview page - Plan

## Goal Capsule

- **Objective:** A client (or member) opens one page and sees how every project (repo) in the workspace is going: ticket counts by state, milestone progress, recent activity, and production error health.
- **Means:** One aggregated read endpoint `GET /v1/workspaces/:ws/portfolio` (constant query count), a rebuilt web page at `/overview`, made the post-login landing and the first nav entry.
- **Authority:** Settled decisions below are owner-approved. Stacked on PR #269 (reads its GlitchTip cache).
- **Stop:** No merge, no deploy. Sidebar redesign is a later phase.

## Settled decisions (KTD)

- **KTD1 (session-settled)** Tallyline is the client-facing hub for tickets and repo roadmap progress; this is not an app-status or agent-WIP board. Rejected: a status-board framing.
- **KTD2 (session-settled)** All numbers are aggregated in the API in one endpoint; the browser never fans out per project and never calls GlitchTip. Rejected: the existing `/projects` page's per-project `issues?project=` fetches (N+1, capped at 200 issues).
- **KTD3 (session-settled)** Visibility mirrors `GET /workspaces/:ws/projects`: any workspace member and read-scope agent keys, always filtered by `workspace_id`. The schema has no guest/client role (roles are member/admin/owner), so none is invented; if one is added later, this endpoint is the single place to narrow. Rejected: a new role in this phase.
- **KTD4 (session-settled)** Minimal nav change only: an "Overview" entry first in the existing work list, `g o`, a Cmd+K action, and the post-login default. Rejected: sidebar redesign.
- **KTD5 (assumption)** Progress is done over total, excluding canceled and duplicate (same rule as milestone progress in `routes/resources.ts` and `lib/project-health.ts`). Activity is issue events only, last 30 days, 5 per project, never including `before`/`after` payloads.

## Units

- **U1 Aggregation service + route** (`services/portfolio.ts`, `routes/portfolio.ts`, mounted in `index.ts`, `openapi-extra.ts`, matrix-ops, permission CSV, tenancy ops list). Queries: projects; issue counts grouped by project and state; workspace milestones plus linked-issue progress grouped by milestone; repos bound to projects; recent issue events per project via a window function with actor names joined; `workspaceErrorHealth` from #269. Five or six queries regardless of project count.
  Tests (real Postgres): counts per state and progress exclude canceled/duplicate; milestone progress and cap; repos; recent activity limited to 5/project, newest first, scoped, has no payload fields; GlitchTip health merged and null when unmapped; two tenants never see each other's data; agent read key allowed, outsider 403; query count constant (1 project vs 12 projects issue the same number of SQL statements).
- **U2 Web data + view-model** (`lib/portfolio.ts` with types, sorting, percent and error-health labels; unit tests).
- **U3 Page** (`app/(app)/overview/page.tsx`, `loading.tsx`, client list component with keyboard nav: j/k or arrows move, Enter opens `/projects/[id]`): dense rows per DESIGN.md, empty, error and loading states; error health chip uses the status ladder (urgent/attention/healthy/neutral). `/projects` becomes a redirect to `/overview`.
- **U4 Landing + nav**: `DEFAULT_LANDING = "/overview"` used by session default, login, workspace chooser, auth callback, manifest `start_url`; shell nav entry, `g o`, Cmd+K action; update affected tests.
- **U5 Docs**: `docs/portfolio.md`, ROADMAP line, CHANGELOG.

## Risks

- Changing the landing route touches several redirect sites; covered by existing session/manifest tests updated in U4.
- Window-function activity query on a large `events` table: bounded by workspace, 30 day window and existing `(workspace_id, created_at)` index.
