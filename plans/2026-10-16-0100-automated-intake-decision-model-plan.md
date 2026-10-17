---
title: Automated intake + decision-model ranking
status: ready
created: 2026-10-16
---

# Automated intake + decision-model ranking

Sources like GlitchTip error reports, GitHub issues, request-for-help pings and
external bug reports need a single intake pipe: authenticate the sender, dedupe
deliveries and repeated errors, land a triage issue (or an occurrence bump on an
existing one), and pre-rank it with the existing assist model — while a human
(or a trusted agent) still makes the accept/decline call.

## Current state

- `assist.suggestTriage` already ranks a triage issue (accept/decline + reason)
  but is opt-in per call — nothing fires automatically on intake.
- `assist.checkDuplicates` does prompt-based dedupe against ~100 recent issues.
- `webhooks.ts` already has the delivery pattern to copy: signature check,
  `webhookDeliveries` idempotency on provider delivery id, sweep-based retry.
- `webhook-endpoints.ts` manages per-workspace endpoint tokens.
- `ISSUE_SOURCES = [web, github, slack, api, voice]` — no error-monitor source.

## Design

### Normalized input

```ts
interface IntakeEvent {
  kind: "error" | "bug" | "help" | "issue";
  title: string;
  body?: string;
  fingerprint?: string;        // provider grouping key (glitchtip event hash, etc.)
  externalId?: string;         // provider delivery/event id for idempotency
  url?: string;
  severity?: "fatal" | "error" | "warning" | "info";
  occurredAt?: string;         // ISO-8601
  payload?: Record<string, unknown>;  // raw provider fields, capped
}
```

### Endpoints

- `POST /v1/workspaces/:ws/intake` — session/agent-authed intake for first-party
  tools (CLI, future integrations, request-help flows).
- `POST /webhooks/intake/:endpointId` — token-authed for external sources; a
  `webhookEndpoints` row with `provider: "intake"` carries the shared secret.
  Signature handling reuses the existing webhook middleware.

### Pipeline (service: `services/intake.ts`)

1. **Authenticate** the endpoint/session; resolve workspace.
2. **Delivery idempotency**: when `externalId` is present, insert an
   `intake_events` row keyed on `(endpointId, externalId)`; conflict → 200 + drop
   (same contract as GitHub deliveries).
3. **Fingerprint dedupe**: when `fingerprint` is present, look up an open issue
   with `issues.intakeFingerprint = fingerprint` in the workspace. Hit → append
   an occurrence comment (`N more occurrences since …`, count bumped in a
   dedicated column) and optionally re-open triage if it was declined? — no:
   declined means a human already said no; just bump the count and record the
   event. Miss → step 4.
4. **Create** a `triage`-state issue: `source` = provider enum value,
   `intakeFingerprint` set, provenance (endpoint, externalId, url) recorded on
   the `intake_events` row linked to the issue.
5. **Rank** when `llmEnabled()`: run `assist.suggestTriage`; store the verdict on
   `issues.triageSuggestion` (jsonb `{ action, reason, at }`). Malformed output
   or provider failure → leave null; the issue still exists (§ never blocks
   intake on the model).
6. **Never auto-transition.** Accept/decline stays with the existing
   `POST /issues/:key/triage` handler — the suggestion is advisory signal in the
   triage queue UI.

### Schema

- `issues.intake_fingerprint text null` — index `(workspace_id, intake_fingerprint)`
  partial where not null; dedupe lookups hit it.
- `issues.triage_suggestion jsonb null` — `{ action, reason, model, at }`.
- `issues.occurrence_count int not null default 1` — bump on fingerprint hits.
- `intake_events` table: `id, workspace_id, endpoint_id?, provider text,
  external_id text?, fingerprint text?, issue_id fk?, received_at timestamptz,
  status text (accepted|deduped|duplicate_delivery|failed)` — unique
  `(endpoint_id, external_id)` where both present.
- `ISSUE_SOURCES` gains `"intake"` (one new enum value, migration) — external
  provenance lives on the intake_events row, not a per-provider enum explosion.

### Failure modes

- Webhook handler errors → 500 lets the provider retry; the sweep pattern from
  `webhooks.ts` retries persisted deliveries.
- LLM down/malformed → `triageSuggestion` stays null; `intake_events.status`
  stays `accepted` regardless (ranking is best-effort).
- Fingerprint collision with a `canceled` issue → bump count + comment, do not
  resurrect (human verdict stands).

## Units

| U | Work | Size |
|---|------|------|
| U1 | Migration + schema + `ISSUE_SOURCES` enum, `intake_events` table | easy |
| U2 | `services/intake.ts` — ingest, idempotency, fingerprint dedupe, issue create | med |
| U3 | `POST /v1/.../intake` + `/webhooks/intake/:id` routes, zod, tests | med |
| U4 | Rank-on-intake via `suggestTriage` → `triage_suggestion`; triage UI surfaces it | med |
| U5 | Web: occurrence count + suggestion badge on triage rows | small |

## Open decision for the user

**Should a high-confidence model verdict ever auto-accept into backlog?**
Plan defaults to *never* — humans keep the accept/decline click. If wanted,
gate it behind a workspace setting (`autoAcceptThreshold`) and record the
model verdict as the actor on the transition event. Decide before U4.
