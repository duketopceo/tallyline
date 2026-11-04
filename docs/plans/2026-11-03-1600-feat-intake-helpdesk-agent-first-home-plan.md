---
title: Public intake, helpdesk, and an agent-first iOS home
created: 2026-11-03
status: draft
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-plan-bootstrap
---

# Public intake, helpdesk, and an agent-first iOS home

## Goal Capsule

**Objective.** Give Tallyline a front door for the outside world and a phone
home that matches how the work actually runs. Someone else's app should be able
to report a crash, a bug, or a feature request into a workspace and hear back;
the iPhone should open on the projects that are alive and what agents are doing
in them, not a flat ticket list.

**Means.** One intake spine already exists server-side (`POST
/v1/workspaces/:ws/intake`, `ingestIntake`, GlitchTip receiver) but it sits
behind a session and speaks only to first-party senders. Open it with
per-app credentials, give the reporter a way back, and rebuild the iOS root
view around projects.

## Problem Frame

- `POST /v1/workspaces/:ws/intake` is mounted under `/v1/*`, which
  `requireSession` guards (`apps/api/src/index.ts`). An outside app cannot post
  without a human session, so nothing can be embedded in a customer's product.
- `intakeSchema` already accepts `kind: error | bug | help | issue`,
  `fingerprint`, `severity`, `provider`, `payload`
  (`apps/api/src/routes/intake.ts`), so the normalisation is done. What is
  missing is identity, credentials, abuse control, and a reply path.
- The iOS root view is an issue list. Projects and roadmap exist in the API and
  are unread by the app; agents are the primary actors but the home screen
  cannot show them.
- A server without `AUTH_SECRET_KEY` silently cannot seal provider keys: the
  API answers `503 SECRETS_KEY_MISSING` with an operator instruction, but
  nothing in the UI or deploy docs tells an operator that before they try.

## Product Contract

### Requirements

R1. An app owner can mint, list, rotate, and revoke an intake credential per
project, scoped to a team, with a readable label and last-used timestamp.
R2. An outside app can post a normalised report with that credential alone — no
human session — and receive the created issue key back.
R3. Duplicate reports from the same source collapse: same credential plus same
fingerprint updates the existing issue instead of filing a second one.
R4. A reporter gets a follow-up handle (opaque URL token) that shows status and
public comments without exposing the workspace.
R5. Staff replies on an intake issue reach the reporter: email when the reporter
supplied one, otherwise the follow-up handle shows the reply.
R6. Sentry and GlitchTip remain supported as *sources*: their payloads
normalise into the same intake shape as a first-party report.
R7. The embeddable path ships documented: a copy-paste endpoint, a minimal
TypeScript client, and framework snippets for a React error boundary, an
Express handler, and a plain `fetch`.
R8. Intake credentials are rate limited and revocable; a revoked credential
fails closed with a machine-readable code.
R9. The iOS app's root screen is an agent-first overview of active projects,
with projects and roadmap reachable in one tap.
R10. Settings → AI and Settings → Providers show the `SECRETS_KEY_MISSING`
condition as an operator instruction with the exact environment variable, not
a generic failure. `docs/deploy.md` names it in the environment table.

### Scope Boundaries

In: per-app credentials, public ingest, reporter follow-up, staff reply
delivery, Sentry/GlitchTip normalisation parity, a small client package and
docs, a web helpdesk view, the iOS home rebuild, the missing-key surfacing.

Out: end-user accounts inside Tallyline for reporters; a hosted SaaS intake
domain separate from a workspace; billing for intake volume; two-way chat with
push notifications into the reporter's app; SDKs for languages beyond
TypeScript in the first pass.

### Key Decisions

- **Per-project credential, not a workspace-wide key.** A leaked key should
  expose one project's intake, not the workspace. Rotation is per credential.
- **Dedupe on `(credentialId, fingerprint)`.** The existing issue-level dedupe
  keys on content; an embedding app knows its own error identity better.
- **Reporter handle is a capability token, not an account.** No passwords, no
  sessions for reporters; the URL is the credential and expires.
- **Reuse `ingestIntake`.** The triage ranker, dedupe counter, and event stream
  stay one path; intake is a credential and transport layer over it.

## Implementation Units

### U1 — Intake credentials

`apps/api/src/db/schema.ts`, `apps/api/src/services/intake-credentials.ts`,
`apps/api/src/routes/intake.ts`, `apps/api/src/openapi.ts`.

- Table `intake_credentials` (`id`, `workspaceId`, `projectId`, `teamId`,
  `label`, `keyHash`, `keyLast4`, `reporterNotifyEmail`?, `revokedAt`,
  `lastUsedAt`, `createdBy`, timestamps). Append-only migration.
- Mint returns the plaintext key once (`tlintake_…`), stores only the hash —
  same shape as device tokens and agent keys.
- Routes under the session: `POST/GET/DELETE /v1/workspaces/:ws/intake-credentials`.

Tests (`apps/api/src/routes/intake.test.ts`): mint requires member role; key is
shown once and never returned by list; revoke is idempotent; another
workspace's credential id is a 404, not a 403 leak.

### U2 — Public ingest

`apps/api/src/routes/intake-public.ts`, mounted **before** `requireSession`.

- `POST /v1/intake/:key` with the existing intake schema plus optional
  `reporter: { email?, name? }`.
- Resolves credential → workspace/team/project, applies a per-credential rate
  limit, calls `ingestIntake`, returns `{ issueKey, reporterToken?, deduped }`.
- Fails closed: `401 INTAKE_KEY_INVALID`, `410 INTAKE_KEY_REVOKED`,
  `429` with `Retry-After`.
- Never echoes workspace ids, slugs, or other issues.

Tests: valid key creates one issue; same fingerprint twice yields one issue and
`deduped: true`; revoked key is 410; a payload with 200 KB body is rejected;
no session cookie is required and none is set.

### U3 — Reporter follow-up

`apps/api/src/services/reporters.ts`, `apps/api/src/routes/reporters.ts`.

- `reporter_handles` table: `tokenHash`, `issueId`, `expiresAt`, `createdAt`.
- `GET /v1/report/:token` returns `{ status, title, comments: [{ author, body,
  createdAt }] }` with public comments only.
- Staff comment on an intake issue enqueues delivery: email through the
  existing mailer when the reporter gave an address, otherwise the handle.
- Handle expires (30 days) and rotates on request.

Tests: token round-trips status; internal comments never appear; expired token
is 404; a comment from an agent is not echoed as public unless marked.

### U4 — Sentry and GlitchTip parity

`apps/api/src/routes/glitchtip.ts`, `apps/api/src/services/intake.ts`,
`docs/glitchtip.md`, `docs/intake.md`.

- Keep the webhook signature check; add a normaliser so a Sentry-style payload
  and a first-party report land in the same shape.
- Document both setups on one page: webhook URL, signing secret, which fields
  map where, and how to test with `curl`.

Tests: a captured Sentry payload normalises to the same `IntakeInput` as the
first-party path; an unsigned webhook is refused; a signed one is accepted.

### U5 — Embeddable client and docs

`packages/intake-client/`, `docs/intake.md`.

- `report(event)` posting to `/v1/intake/:key`, with a browser and a Node
  entry, no dependencies, and a `beforeSend` hook for scrubbing.
- Snippets: React error boundary, Express, plain `fetch`, and a curl example.
- Document the correlation contract: the embedder passes its own `externalId`
  so their support tooling and Tallyline agree on identity.

Tests (`packages/intake-client/src/*.test.ts`): payload shape, retry on 429
honouring `Retry-After`, no PII added beyond what the caller passed.

### U6 — Web helpdesk view

`apps/web/app/(app)/support/page.tsx`, `apps/web/components/support/`.

- List of intake-origin issues with kind, source app, reporter, age, state.
- Detail: the thread with a reply box that marks the reply public, plus the
  reporter handle for manual sharing.
- Filter by kind (`error`, `bug`, `help`, `feature`) and by project.

Tests: e2e spec files a report through the public endpoint, replies as staff,
and reads the reply back through the reporter handle.

### U7 — iOS agent-first home

`apps/ios/Sources/tallyline_ios/HomeView.swift` (new),
`apps/ios/Sources/TallylineCore/TrackerClient.swift`,
`apps/ios/Sources/TallylineCore/TrackerModels.swift`.

- Home = active projects first: one card per project with progress ring, open
  counts, and the last agent activity line ("Agent moved ENG-42 to review").
- A compact "agents working" strip above the list, fed by dispatch/session data
  already available in `/roadmap/summary` merges and the agent surfaces.
- Issues remain reachable as a tab, no longer the root.
- The projects and roadmap screens planned in PR #230 reuse U1 of that plan;
  this unit owns the root composition and the activity feed.

Tests: `swift test` covering the home view model (active-project ordering,
empty state, activity-line formatting); a UI snapshot at AX5.

### U8 — Missing-key surfacing

`apps/web/components/settings/ai-provider-panel.tsx`,
`apps/web/components/settings/providers-panel.tsx`, `docs/deploy.md`.

- Render `SECRETS_KEY_MISSING` as a callout with the variable name and the
  one-line operator action; do not show a bare error toast.
- Add `AUTH_SECRET_KEY` to the environment table with "optional, required to
  store provider keys; must differ from `JWT_SECRET`".
- Log one startup warning when the key is absent in production.

Tests: a component test asserting the callout text appears for a 503 with that
code; `docs/deploy.md` link check.

## Risks

- **Public write endpoint.** Rate limiting per credential plus payload caps are
  the only guard against abuse; if a key leaks, rotation must be one action.
- **Reply delivery.** Email from an unauthenticated report is an outbound path
  an attacker can aim at a stranger's address. Send only to the address given
  at report time, once per reply, with a working unsubscribe.
- **Agent-first home.** Activity lines are derived from dispatch and merge
  data; if the source goes stale the home quietly lies. Show "as of" time.
- **Session boundary.** The public route mounts before `requireSession`; a
  single ordering mistake re-exposes it. Cover with a test that asserts no
  session cookie is required *and* that the route set excludes workspace data.

## Verification

- `pnpm --filter @tallyline/api test`, `pnpm --filter @tallyline/web test`,
  `swift test` in `apps/ios` (core only on Linux).
- One end-to-end pass: mint a credential, file a report with curl, read it as
  staff, reply, read the reply back through the reporter handle.
- `pnpm lint:design` — the new web surfaces must not add palette violations.

## Prerequisites

- `AUTH_SECRET_KEY` on the host. **Done 2026-11-03**: generated, stored in the
  system keyring, written to the host's `.env`, api recreated, health 200.
  `devices.push_handle` and `ai_providers` were both
  empty, so nothing depended on the previous fallback.
- App Group `group.app.tallyline.ios` registration and the widget/share App IDs
  remain outstanding from `ROADMAP.md` (S5-U1) and are not part of this plan.
