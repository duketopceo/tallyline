---
title: GlitchTip error feed per project - Plan
type: feat
date: 2026-11-09
artifact_contract: ce-unified-plan/v1
product_contract_source: session-settled
execution: code
---

# GlitchTip error feed per project - Plan

## Goal Capsule

- **Objective:** Every Tallyline project that maps to a GlitchTip project shows its production error health (open count, recent errors, links back to GlitchTip) without anyone leaving Tallyline.
- **Means:** A per-workspace GlitchTip connection (base URL + sealed token), a per-project mapping, a cached pull-sync of issues and the latest event, read endpoints, a project-page panel, and two MCP tools.
- **Authority:** Settled decisions below are owner-approved. This is the pull side; the existing alert-webhook integration (docs/glitchtip.md) is untouched.
- **Stop:** No merge, no deploy. Portfolio overview page is a later phase; this plan only exposes a reusable data shape.

## Settled decisions (KTD)

- **KTD1 (session-settled)** Per-organization connection. "Organization" is the workspace in this codebase; every query is scoped by `workspace_id`. Token is sealed with the existing AES-GCM `encryptSecret` / `AUTH_SECRET_KEY` mechanism (as `ai_providers.api_key_enc`), never returned, never logged, never put in an event. Rejected: plaintext column. No env fallback: the sealed store is the existing secrets mechanism.
- **KTD2 (session-settled)** Per-project mapping to `{orgSlug, projectSlug}` of GlitchTip, one mapping per Tallyline project. Rejected: implicit workspace-wide mapping.
- **KTD3 (session-settled)** Cached pull-sync, not a live proxy. Sync is: on mapping save (awaited, fail soft), a manual `POST .../sync`, and a 5 minute background tick. Reads only ever hit the cache, so a GlitchTip outage never fails a Tallyline request. Rate limits: honor `429` + `Retry-After` (stored as `backoff_until`, capped at 15 min), one request in flight per tick, 8 s timeout, 2 MB cap, SSRF-guarded fetch (`safeFetchText`).
- **KTD4 (session-settled)** Every connection and mapping mutation writes an `events` row (`entity_type` `glitchtip_connection` / `glitchtip_project_link`), with a secret-free `after`. Cache rows are not mutations and are not audited.
- **KTD5 (session-settled)** Read shape is reusable: `projectErrorHealth(workspaceId, projectId)` plus `GET /workspaces/:ws/glitchtip/health` (all mapped projects) for the later portfolio page.
- **KTD6 (session-settled)** MCP tools `list_project_errors` and `get_project_error`, in the MIT package, over the REST API only (no AGPL code imported).
- **KTD7 (session-settled, optional)** `POST .../issues/:issueId/ticket` creates a Tallyline issue from a cached GlitchTip issue, idempotent via `ticket_issue_id`.

## Assumptions (pipeline mode, no human)

- GlitchTip's Sentry-compatible API: `GET /api/0/projects/{org}/{project}/issues/?query=is:unresolved&limit=100` and `GET /api/0/issues/{id}/events/latest/`, bearer token. Issue links are built as `<base>/<org>/issues/<id>` (the same URL form the webhook parser already accepts).
- Open count is the number of unresolved issues returned in one page of 100; `openCapped: true` when the page is full.
- Event detail keeps only exception type/value, up to 8 stack frames, level and capped tags. User, request and context blocks (PII) are dropped before storage.

## Units

- **U1 Schema**: tables `glitchtip_connections`, `glitchtip_project_links`, `glitchtip_issues` (migration 0047, generated, append-only); tenant-table export policy (redact `token_enc`).
  Tests: tenancy coverage test, purge test.
- **U2 Client + sync service** (`lib/glitchtip-api.ts`, `services/glitchtip-sync.ts`): fetch, parse, upsert, backoff, single-flight, fail-soft status. Tests with a mocked GlitchTip HTTP layer and real Postgres: happy, 401, 429 backoff, timeout/unreachable keeps cache, resolved-issue reconciliation, malformed payload.
- **U3 Routes** (`routes/glitchtip-feed.ts`, openapi, permission matrix, tenancy ops): connection CRUD (admin), mapping CRUD (admin), health, issues list, issue detail, sync, ticket. Tests: happy, validation, 404 across tenants, token never in any response/event/log, audit rows.
- **U4 Background tick** in `index.ts`.
- **U5 Web**: `ErrorHealth` panel on the project page, admin connect form in Settings, same-origin bridges. Design per DESIGN.md (density, tokens, no decorative chrome).
- **U6 MCP**: two tools plus test.
- **U7 Docs**: extend docs/glitchtip.md, docs/mcp.md, CHANGELOG.

## Risks

- GlitchTip response drift from Sentry: parser is tolerant and drops unparseable rows instead of failing the sync.
- Token sealed with `AUTH_SECRET_KEY`: key rotation makes it unreadable; surfaced as `TOKEN_UNREADABLE` status, admin re-enters it (same as AI providers).
