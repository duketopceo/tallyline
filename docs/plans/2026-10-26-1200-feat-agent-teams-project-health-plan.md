# Agent-creatable teams, project health page — implementation plan

Created: 2026-10-26 · Depth: Lightweight · Source: owner direction 2026-10-26 ("Linear but super backend-friendly for agents, frontend super simple for people")

## Findings that shaped scope

- `POST /v1/workspaces/:ws/teams` already exists on main (and in OpenAPI) but has no role gate; `PATCH /teams/:id` has none either. Agent credentials resolve `memberRole = null` (R24, oauth-org-identity plan), so a plain `requireRole("admin")` would lock out agents, the exact callers this work serves.
- MCP has `list_teams` only; the CLI has no team commands.
- Python urllib 403 is not in the repo (no User-Agent logic in apps/ or ops/); it is Cloudflare edge config (Browser Integrity Check / Bot Fight / WAF). Noted only.
- Helpdesk: roadmap plan U24 routes help requests through the single intake pipe into triage. A separate help inbox would contradict it. Deferred as a /triage follow-up.

## Settled decisions

- KTD1 (`session-settled:`): human callers need `admin` to create a team; agent credentials pass on their normal write scope. Rejected: admin-only for everyone (blocks agents, contradicts R24 intent).
- KTD2: the project health page is a new read-only route composed from existing endpoints (projects, issues?project=, github/repos, events). No new API.
- KTD3: "parent roadmap issue" = the project's top-level issue (parentId null) that is parent to the most other issues in the project. Absent means none shown.

## Units (cut from the bottom)

- U1 API gate: in `apps/api/src/routes/workspaces.ts` POST teams, `if (!c.get("agentAuth")) requireRole(c, "admin")`. Same gate on PATCH teams. Tests in `workspaces.test.ts`: member session gets 403 FORBIDDEN_ROLE, admin 201, agent key 201, duplicate key 409.
- U2 MCP + CLI: `create_team` tool (key, name, rolloverBehavior) in `apps/mcp-server/src/tools.ts` with tests; `tallyline teams` and `tallyline teams create --key K --name N` in `tools/cli` with tests, if cheap.
- U3 Web: `apps/web/app/(app)/projects/page.tsx` plus `apps/web/lib/project-health.ts` (pure aggregation, vitest). Per project: open (triage/backlog/todo), in progress (in_progress/in_review), done counts; linked repos; five most recent activity events matched by issue key; parent roadmap issue link. Reuse PageHeader, EmptyState, ErrorState, StateDot.
- U4 Docs: OpenAPI note on the role rule; MCP tool list doc if one exists.

## Verification

`pnpm check` (typecheck, lint, tests). Manual: none against hosted data.

## Deferred

- Help inbox: add a "help" kind badge/filter to /triage under roadmap U24.
- Cloudflare UA 403: owner to check Browser Integrity Check / Bot Fight rule for api host.
