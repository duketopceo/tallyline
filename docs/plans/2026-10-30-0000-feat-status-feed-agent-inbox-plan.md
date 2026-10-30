---
title: Project Status Feed and Agent Inbox Mentions - Plan
type: feat
date: 2026-10-30
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-plan-bootstrap
execution: code
origin: docs/plans/2026-10-17-0000-feat-tallyline-full-roadmap-plan.md
---

# Project Status Feed and Agent Inbox Mentions - Plan

## Goal Capsule

- **Objective:** Luke (and any member) can read a project's status history and post a new update from the web, and an agent that asks "what needs me" is told about mentions and answers to its questions, not only assigned work.
- **Means:** a per-project web page with a feed and composer over the shipped U14 API (KTD1); an API-derived, ack-able agent inbox feed consumed by the MCP `inbox` tool (KTD2, KTD3).
- **Authority:** `ROADMAP.md` and the U14 and U20 specs in `docs/plans/2026-10-17-0000-feat-tallyline-full-roadmap-plan.md` win over this file on scope. This plan only carves the remaining parts of those two units.
- **Stop conditions:** if U20 pushes the diff past a reviewable size, ship U14 alone and record U20 as next (settled, see KTD5).
- **Ship:** one PR on `feat/status-feed-inbox-mentions`; merging is Luke's.

## Product Contract

### Summary

U14 API and MCP shipped in #170 (`project_updates`, `GET/POST /workspaces/:ws/projects/:id/updates`, `GET .../update-draft`). U20 inbox shipped in #169 (assigned and delegated work, blocked-aware ready). Remaining: the web feed (U14) and mentions plus answered questions in the agent inbox (U20).

### Requirements

- R1. A project page lists status updates newest first with health, author (human name or agent name with an "agent" marker), body as safely rendered markdown, and relative time. An empty feed says so.
- R2. A member can post an update from that page (health select, body), the new entry appears without a reload, and errors are shown, not swallowed. The composer can prefill from the existing draft endpoint.
- R3. The feed and composer are keyboard operable, pass the axe gate at 390 and 1440 in both themes, and are covered by the e2e harness.
- R4. The agent inbox includes, for the calling agent only, mentions (comment `@agent` dispatches) and answered questions (human `prompt` activity on one of its sessions) newer than the agent's ack mark, and an `ack` clears them.
- R5. An agent never sees another agent's inbox items; a human key gets no agent inbox.
- R6. `docs/mcp.md` and the MCP tool descriptions say what the inbox now returns; ROADMAP.md rows for U14 and U20 reflect the result.

### Scope Boundaries

- Not in scope: email or weekly digest (U20 says none), notification rows for agent recipients (see KTD2), web UI for the agent inbox, the draft-from-events logic (shipped), U17 and other roadmap units.
- Not copied: the e2e rate-limit fix in open PR #196.

### Outstanding Questions

- Deferred: whether to later move agent inbox items into `notifications` (needs `user_id` made nullable plus an agent column). Not needed for R4.

## Planning Contract

### Key Technical Decisions

- **KTD1.** There is no per-project page today (`apps/web/app/(app)/projects/page.tsx` is a card list; roadmap has an expandable panel). Add `apps/web/app/(app)/projects/[id]/page.tsx` as the project page, linked from each card's name, rather than growing the card. Server component loads project, updates and the actor directory (`apps/web/lib/actors.ts`) like sibling pages; a small client component owns the composer and posts through a new same-origin bridge `apps/web/app/api/projects/[id]/updates/route.ts` modelled on `apps/web/app/api/cycles/route.ts`.
- **KTD1b.** Markdown renders through the existing `apps/web/lib/markdown.tsx` (builds React nodes, no HTML strings), not a new dependency. Author display: `authorType` + `authorId` resolved through the actor directory; unknown id falls back to "Unknown".
- **KTD2.** Do not reuse `notifications` for agents: `user_id` is a non-null FK to `users` and the human routes are explicitly human-only. Derive agent inbox items from rows that already exist: `dispatches` with `trigger = 'mention'` for the agent (written by `routes/issues/comments.ts`), and `agent_activities` of type `prompt` with `actor_type = 'human'` on that agent's `agent_sessions` (the elicitation reply path, `routes/agent-sessions.ts` and the L3 comment-resume in `comments.ts`). No new writers, so no drift from the producing code.
- **KTD3.** Ack is state: add `agents.inbox_acked_at timestamptz null` (migration 0035 via `drizzle-kit generate`, snapshot included). `GET /workspaces/:ws/agent-inbox?limit` (agent key only, 403 otherwise) returns items with `createdAt` greater than the mark; `POST /workspaces/:ws/agent-inbox/ack {through}` advances the mark monotonically (never backwards, clamped to now) and returns it. Items carry `kind` (`mention` | `answer`), issue key and title, actor, excerpt (capped) and `createdAt`. A service module `apps/api/src/services/agent-inbox.ts` holds the queries so the routes stay thin.
- **KTD4.** MCP `inbox` keeps `waiting` (assigned and delegated) and adds `mentions` and `answers`, plus an `ack` tool. Agent identity is already available via `client.whoami()`.
- **KTD5 (session-settled, user-directed).** If both units do not fit one reviewable PR, U14 ships first and U20 is recorded as next. Rejected: one oversized PR; reason: reviewability.

### Assumptions

- The `/projects` card list stays; the new page is additive.
- Postgres for tests is a throwaway container on a non-default port per `apps/api/test/db-guard.ts`; never the default dev stack.

## Implementation Units

### U1. Web project status feed and composer (U14)

- **Goal:** R1, R2, R3.
- **Files:** `apps/web/app/(app)/projects/[id]/page.tsx`, `apps/web/components/project-updates.tsx` (feed plus composer client component), `apps/web/app/api/projects/[id]/updates/route.ts` (POST, plus GET `?draft=1` proxying `update-draft` if the composer prefill is built), `apps/web/app/(app)/projects/page.tsx` (link project name), `apps/web/lib/project-updates.ts` (types, health labels, author resolution) with `apps/web/lib/project-updates.test.ts`, `tools/e2e/tests/project-updates.spec.ts`, `tools/e2e/tests/a11y.spec.ts` (add the page), `apps/web/lib/public-paths.ts` or route-guard only if the new routes need registration (verify).
- **Approach:** follow `projects/page.tsx` (server fetch via `api()`, `PageHeader`, `EmptyState`, `ErrorState`, `RelativeTime`). Health shown as text plus a colored dot, never color alone; use design tokens, no hard-coded colors (`lint:design` runs). Composer: labelled `<select>` for health, labelled `<textarea>`, submit button, `aria-live="polite"` status; optimistic insert or refetch after 201. 404 project renders a not-found state.
- **Test scenarios:** unit tests for health label/author resolution (human, agent, unknown) and markdown of a body with a `javascript:` link rendering no anchor; e2e: open a project page, empty state shown, post an at-risk update through the form, it appears first with health and author, an update posted via API as an agent shows the agent marker, axe has zero violations at 390 and 1440 in both themes.
- **Verification:** `pnpm --filter @tallyline/web test`, `pnpm --filter @tallyline/web typecheck lint`, `pnpm lint:design`, web e2e spec.

### U2. Agent inbox API: mentions, answers, ack (U20)

- **Goal:** R4, R5.
- **Files:** `apps/api/src/db/schema.ts` (`agents.inboxAckedAt`), `apps/api/drizzle/0035_*.sql` plus `meta/0035_snapshot.json` and `_journal.json` (generated), `apps/api/src/services/agent-inbox.ts`, `apps/api/src/routes/agent-inbox.ts`, `apps/api/src/index.ts` (mount), `apps/api/src/openapi.ts`, `apps/api/test/permission-matrix.csv` and `apps/api/test/matrix-ops.ts` (new ops), `apps/api/src/routes/agent-inbox.test.ts`.
- **Approach:** KTD2 and KTD3. Both sources unioned, ordered oldest first so an agent processes in order, capped by `limit` (default 50, max 200). Scope queries by workspace and agent id from `agentAuth`.
- **Test scenarios:** a comment `@agent-name` yields one `mention` item and a human `prompt` on that agent's session yields one `answer` item; an item disappears after ack and a later one appears; ack never moves the mark backwards; agent B never sees agent A's items; a human session key gets 403; another workspace's data never appears; an agent's own prompt or its own comment mention is not an item.
- **Verification:** `pnpm --filter @tallyline/api test` (throwaway Postgres), tenancy and permission-matrix suites stay green.

### U3. MCP inbox mentions/answers/ack and docs (U20)

- **Goal:** R4, R6.
- **Files:** `apps/mcp-server/src/tools.ts`, `apps/mcp-server/src/tools.test.ts`, `docs/mcp.md`, `tools/cli/src/commands.ts` only if the CLI mirrors `inbox`, `ROADMAP.md` (U14 and U20 rows), `CHANGELOG.md` if the repo convention requires.
- **Approach:** KTD4. Update the `inbox` description (it currently says mentions and answered questions are not included). `ack` takes `through` (ISO, from the last item) and is not read-only.
- **Test scenarios:** `inbox` returns `waiting`, `mentions`, `answers`; `ack` passes the cursor to the API; a human whoami gets only `waiting`.
- **Verification:** `pnpm --filter @tallyline/mcp-server test`, typecheck, lint.

## Verification Contract

- `pnpm --filter @tallyline/api test` and `pnpm --filter @tallyline/mcp-server test` against a throwaway Postgres (non-default port), `pnpm --filter @tallyline/web test`, `pnpm check` for typecheck and lint, `pnpm lint:design`, `pnpm turbo run build --filter=@tallyline/web... --filter=@tallyline/mcp-server...`.
- e2e: `tools/e2e` `pnpm test` (own stack on its own ports; do not touch the pre-existing listener on 3100). CI e2e on the PR may flake on the rate limiter or `triage-review` until PR #196 merges; rerun the failed job once and say so.

## Definition of Done

- U1 to U3 complete, ROADMAP rows updated, no dead code, no secrets, all verification above green or flaky-explained.
- Containers and dev servers started for verification are removed.
