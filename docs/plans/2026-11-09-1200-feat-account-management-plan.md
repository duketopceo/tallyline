---
title: Account Management Gaps - Plan
type: feat
date: 2026-11-09
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-plan-bootstrap
execution: code
---

# Account Management Gaps - Plan

## Goal Capsule

- **Objective:** A signed-in person can manage their profile, their workspace and its credentials from Settings without a missing control: edit name and avatar, change a password, rename a workspace, leave a workspace, and see every credential mutation in the audit trail.
- **Means:** Fill the gaps in the account surfaces that already exist (KTD1). No page is rebuilt.
- **Authority:** This plan, then DESIGN.md, then the existing route and permission-matrix behaviour.
- **Stop:** No billing, no Stripe, no plans. No sidebar or navigation redesign. No change to who may mint tokens today.
- **Who ships:** The implementing agent opens a draft PR. The owner merges; merging deploys tallyline.app, so nothing here deploys.

## Settled decisions (session-settled, user-directed)

- KTD1. Fill gaps in existing pages; do not rebuild or duplicate members, invites, tokens, agents, account or workspace pages. Rejected: rewriting settings pages.
- KTD2. Billing is deferred. Rejected: bundling plans or Stripe here.
- KTD3. Tokens are shown once at creation and only a hash is stored (already true for PATs and agent keys; kept and tested). Rejected: recoverable tokens.
- KTD4. The sidebar component is untouched. Only the shared settings list in `apps/web/lib/settings-nav.ts` may change descriptions.

## Current state (verified in the repo)

Exists: `GET/DELETE /v1/me/identities`, `POST /v1/me/deletion` (blocks sole owners, hard delete), `GET /v1/me/export`, password forgot/reset (public), PAT and agent-key mint/list/revoke/rotate, workspace PATCH (name, allowedDomains), members role change and removal, invites create/list/revoke, workspace deletion with a 7-day restore window.

Gaps this plan closes:

| Gap | Fix |
|---|---|
| No way to edit name or avatar | `PATCH /v1/me` (cookie session only), audit `profile_updated` |
| No password change while signed in | `POST /v1/me/password` verifies the current password, signs out other sessions, audit `password_changed`, mail the owner of the address |
| Workspace slug cannot change; PATCH writes no audit record | owner-only `slug` on `PATCH /v1/workspaces/:ws`; every PATCH writes a tenant `events` row |
| A non-admin cannot leave a workspace (`DELETE members/:id` needs admin) | `POST /v1/workspaces/:ws/leave` |
| PAT mint/revoke and agent-key mint write no audit record | `events` rows `token_created`, `token_revoked`, `agent_key_created` (never the secret) |

## Implementation units

- U1. API profile: `PATCH /v1/me`, `POST /v1/me/password`, in `routes/account.ts` and `services/account.ts`.
  - Name 1-120 chars trimmed; avatar must be an `https:` URL up to 2048 chars or null.
  - Password change refuses when password auth is disabled (403 `PASSWORD_DISABLED`), when the account has no password (409 `NO_PASSWORD`, the person uses reset), on a wrong current password (400 `CURRENT_PASSWORD_INVALID`), and when the new one is under 10 chars or equals the current one.
  - Keeps the calling session, deletes the others. PATs stay (same rule as reset).
- U2. API workspace: slug rename and audit on PATCH; `POST /workspaces/:ws/leave`.
  - Rename: owner only, same slug rules as create, 409 `SLUG_TAKEN`.
  - Leave: any human member via cookie session. Refuses the last owner (409 `LAST_OWNER`) and the person's only workspace (409 `LAST_WORKSPACE`, delete the account instead). Revokes the person's PATs in that workspace and rebinds their sessions to another workspace. Writes an `events` row and an `audit_events` row.
- U3. Credential audit: events on PAT mint/revoke and agent-key mint.
- U4. Contract: OpenAPI entries, permission-matrix rows and builders for the new operations.
- U5. Web bridges: `/api/account/profile`, `/api/account/password`, `/api/settings/workspace` (PATCH), `/api/settings/workspace/leave`.
- U6. Web UI: profile form and password form in `AccountSettings`; name/slug form and a Leave button with type-to-confirm in `WorkspaceSettings`. Links inside text carry an underline (axe `link-in-text-block`).
- U7. Tests: API on real Postgres (happy path, authorization failures, tenant isolation), web unit tests, axe e2e extended to the settings pages.

## Test scenarios

- Profile: member edits own name; PAT and agent key get 403; blank name 400; `http:` avatar 400; audit row exists and holds no email or secret.
- Password: wrong current 400; correct current changes the hash, other sessions die, calling session lives, old password stops working; reuse 400; disabled 403.
- Slug: admin 403 `FORBIDDEN_ROLE`; owner renames; taken slug 409; outsider tenant 403; old slug 404.
- Leave: member leaves and loses access; last owner 409; only workspace 409; co-owner can leave; PAT for that workspace stops; sessions rebound; tenant B unaffected; outsider and agent credentials refused.
- Audit: token create/revoke and agent-key create each write one tenant-scoped row, none containing the secret.

## Risks

- Renaming a slug changes URLs and the web's `tly_ws` cookie. The UI re-binds the cookie through the existing session endpoint after a rename.
- Avatar is a URL only (no upload store exists); a bad URL just shows initials.
