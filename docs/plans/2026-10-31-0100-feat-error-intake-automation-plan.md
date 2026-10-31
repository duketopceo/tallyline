---
title: Error Intake Automation — Sentry/GlitchTip hook, issue.created loops, n8n intake op
created: 2026-10-31
status: draft
---

# Error Intake Automation

## Problem

Errors and feedback reach tallyline only when a human or agent files them by hand. The primitives exist — `ingestIntake` (delivery idempotency + fingerprint dedupe + occurrence counting), `workflow_definitions` loops (`issue.transition` → dispatch agent/comment/assign), and the n8n node — but nothing feeds them. Goal: an error in a watched app (or a helpdesk/n8n event) becomes a deduped issue that an existing user-connected agent picks up via a loop, with zero human touch. Tallyline's own GlitchTip/Sentry reports dogfood through the same endpoint.

## Current state (verified 2026-10-31)

- `POST /workspaces/:ws/intake` — normalized intake behind agent-key auth (`apps/api/src/routes/intake.ts`)
- `ingestIntake(workspace, provider, externalId, fingerprint, …)` — dedupe, `occurrenceCount`, provenance comment (`apps/api/src/services/intake.ts:72`)
- `workflow_definitions` + loops service — only `issue.transition` trigger (`apps/api/src/services/loops.ts:58`)
- Dispatch adapters: `local`, `claude-code`, `codex`, `opencode`, `webhook` (`apps/api/src/services/dispatch.ts`) — the loop reaches external agents via signed webhook already
- `webhook-endpoints` route — workspace webhook endpoint CRUD + delivery history
- `integrations/n8n/` — `Tallyline.node.ts` (issue CRUD, comments, lookup) + `TallylineTrigger.node.ts` (event feed)
- `apps/api/src/routes/glitchtip.ts` — exists on main; audit what it does before adding a second surface

## Decisions

- **One Sentry-compatible endpoint** for Sentry + GlitchTip (GlitchTip speaks Sentry format) — provider hint via query param or auto-detect, not two parsers.
- **Token-in-path auth**: `/v1/hooks/error/:token` — per-workspace signed token minted/rotated from Settings. Payload signature verified when the provider sends one; no unauthenticated writes. Rate-limit per token.
- **`issue.created` trigger added to the loops matcher** alongside `issue.transition` — the whole "error lands → agent triages" combo.
- **n8n `intake` operation** on the existing node — one new op, every n8n source (helpdesk, Langflow, forms, email) funnels in.
- **Out of scope**: public bug-report form (spam surface — helpdesk path covers), inbound-email worker (n8n covers), hosted-agent runtime/token billing (external agents connect via webhook adapter), per-cloud named adapters (Devin/Cursor connector UX is follow-on), hosted open signup.

## Units

**U1 — `POST /v1/hooks/error/:token`.** Token mint/list/revoke under `webhook-endpoints`-style management (new table or reuse `webhookEndpoints` with `kind`). Verify Sentry signature when present; normalize payload (title = error title, fingerprint = Sentry `event_id`/group fingerprint, externalRef = project+release+url, description = exception value + culprit + first frames, capped). Feed `ingestIntake(provider:"sentry")`. Per-token rate limit + 413 body cap. Append-only `intakeEvents` already records deliveries.
- Files: `apps/api/src/routes/` new `error-hooks.ts`; `apps/api/src/routes/index.ts` mount; schema for tokens (migration, append-only) or reuse `webhookEndpoints`.
- Test: valid Sentry envelope → issue created; GlitchTip body shape → same path; bad token → 401; bad signature → 401; replayed delivery id → deduped; fingerprint repeat → occurrenceCount bump.

**U2 — `issue.created` loop trigger.** Extend the workflow matcher: when an issue row is created (web, API, intake, Slack — any path through the service layer), evaluate `issue.created` workflows with conditions (state, priority, teamId, source/provider). Reuse `createDispatch` path so agent dispatch works identically to transition loops. Emit `workflow_triggered` events.
- Files: `apps/api/src/services/loops.ts` matcher + call site from issue-create path (shared issue-creation service, not the route).
- Test: loop with `issue.created` fires on normal create AND on intake create; disabled workflow doesn't fire; conditions filter correctly; dispatch records session.

**U3 — n8n `intake` operation.** `Tallyline.node.ts` gains an `intake` resource: provider, externalId, fingerprint, title, body, source fields → POST `/workspaces/:ws/intake`. README + test fixtures updated. Keeps the node MIT.
- Files: `integrations/n8n/nodes/Tallyline/`.
- Test: op sends normalized event; error responses surface; existing ops unaffected.

**U4 — Settings UX.** Tokens list + mint + copy-once + revoke under Settings → Integrations (web). Show delivery history (reuse webhook-endpoints pattern). Docs: `docs/` page on wiring Sentry/GlitchTip + n8n.
- Files: `apps/web` settings section, `apps/api` management endpoints from U1.

## Verification

- `pnpm --filter @tallyline/api test` for U1–U3 coverage listed per unit
- `pnpm typecheck`, `pnpm lint`
- Self-host dogfooding config documented (no second self-report path)
- No PII in logs; token never echoed to responses after mint-once

## Risks / open questions

- `glitchtip.ts` overlap — audit first; U1 may extend rather than add
- Sentry envelope variants (transaction vs error) — accept only error events; document
- Loop dispatch on intake errors needs a default delegate story — document "assign a loop agent" pattern, no auto-default
